#!/usr/bin/env node
/* =====================================================================
   Lakeshore One — smoke test (zero dependencies, Node >= 22.5).

   Spawns the server against a throwaway SQLite DB on a spare port and
   exercises the security- and correctness-critical paths, including the
   fixes this test was written to lock in:
     - patient-impact tickets are forced to at least P2 server-side
     - idempotent ops dedup without creating duplicates
     - OT board authority matches the client (agents may not schedule)
     - admin-only guards hold for non-admins
     - SSE authenticates by single-use ticket, never a URL bearer token
     - a PIN reset invalidates the target user's live token

   Run:  npm test   (or: node server/smoke-test.js)
   Exits non-zero on the first hard failure.
   ===================================================================== */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 8000 + Math.floor((process.pid % 1000));
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lso-smoke-'));
const SERVER = path.join(__dirname, 'server.js');

let passed = 0;
const failures = [];
function ok(cond, msg){ if (cond){ passed++; console.log('  ✓ ' + msg); } else { failures.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg){ ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

async function req(method, p, { token, body } = {}){
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; try{ json = await r.json(); }catch(e){}
  return { status: r.status, json };
}
const op = (token, o) => req('POST', '/api/op', { token, body: { op: o } });
let uidN = 0;
const uid = () => 'smoke-' + (++uidN);

async function waitForHealth(ms = 10000){
  const deadline = Date.now() + ms;
  while (Date.now() < deadline){
    try{ const r = await fetch(BASE + '/api/health'); if (r.ok) return true; }catch(e){}
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

async function main(){
  // --experimental-sqlite: required on early Node 22.5.x (node:sqlite is flagged
  // there), a harmless no-op on newer 22.x where it's on by default.
  const child = spawn(process.execPath, ['--experimental-sqlite', SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  let exitInfo = null;
  child.on('exit', (code, sig) => { exitInfo = { code, sig }; });

  try{
    if (!(await waitForHealth())){
      throw new Error('server did not become healthy on ' + BASE + (exitInfo ? ' (server exited: ' + JSON.stringify(exitInfo) + ')' : ''));
    }

    console.log('health + auth');
    const health = await req('GET', '/api/health');
    eq(health.json && health.json.service, 'lakeshore-one', 'health reports service');
    const unknown = await req('POST', '/api/login', { body: { empId: 'NOPE', pin: '1234' } });
    eq(unknown.status, 401, 'unknown employee ID is rejected');

    // First sign-in sets a PIN for a seeded doctor and an admin.
    const docSet = await req('POST', '/api/set-pin', { body: { empId: 'LH-DOC01', pin: '4321' } });
    eq(docSet.status, 200, 'doctor sets PIN on first login');
    ok(docSet.json && !!docSet.json.token, 'doctor receives a token');
    let docTok = docSet.json.token;

    const adminSet = await req('POST', '/api/set-pin', { body: { empId: 'LH-ADMIN', pin: '9876' } });
    const adminTok = adminSet.json.token;
    const itSet = await req('POST', '/api/set-pin', { body: { empId: 'LH-IT01', pin: '1111' } });
    const itTok = itSet.json.token;

    const me = await req('GET', '/api/me', { token: docTok });
    eq(me.json && me.json.role, 'doctor', 'token identifies the doctor');

    console.log('patient-impact forces >= P2');
    const impactUid = uid();
    const created = await op(docTok, { uid: impactUid, kind: 'create', mod: 'it', type: 'incident',
      cat: 'HIS / EMR issue', title: 'HIS unreachable in ICU', desc: '', zone: 'ICU Complex',
      pri: 'P4', impact: true });
    eq(created.status, 200, 'ticket created');
    let state = (await req('GET', '/api/state', { token: docTok })).json;
    const impactTicket = state.tickets.find(t => t.id === created.json.id);
    ok(!!impactTicket, 'created ticket is in the doctor’s state');
    eq(impactTicket && impactTicket.pri, 'P2', 'P4 + patient impact is stored as P2');

    console.log('idempotent op dedup');
    const before = state.tickets.length;
    const replay = await op(docTok, { uid: impactUid, kind: 'create', mod: 'it', type: 'incident',
      cat: 'HIS / EMR issue', title: 'HIS unreachable in ICU', desc: '', zone: 'ICU Complex',
      pri: 'P4', impact: true });
    ok(replay.json && replay.json.dedup === true, 'replayed op is deduped');
    state = (await req('GET', '/api/state', { token: docTok })).json;
    eq(state.tickets.length, before, 'replay did not create a duplicate ticket');

    console.log('role enforcement');
    const docAddUser = await op(docTok, { uid: uid(), kind: 'user_add',
      user: { empId: 'LH-X1', name: 'Nobody', role: 'staff', dept: 'X' } });
    eq(docAddUser.status, 403, 'doctor cannot add users (admin only)');

    console.log('OT authority matches the client');
    const docOt = await op(docTok, { uid: uid(), kind: 'ot_add', suite: 'OT-3 · Ortho',
      date: new Date().toISOString().slice(0,10), planned: '09:00', durMin: 90,
      procedure: 'Total knee replacement (L)', surgeon: 'Dr. George' });
    eq(docOt.status, 200, 'doctor can schedule an OT case');
    const itOt = await op(itTok, { uid: uid(), kind: 'ot_add', suite: 'OT-3 · Ortho',
      date: new Date().toISOString().slice(0,10), planned: '10:00', durMin: 60,
      procedure: 'Should be rejected', surgeon: 'Dr. Nobody' });
    eq(itOt.status, 403, 'IT agent cannot schedule an OT case');

    console.log('SSE ticket auth');
    const noTicket = await fetch(BASE + '/api/events');
    eq(noTicket.status, 401, 'events stream rejects a request with no ticket');
    noTicket.body && noTicket.body.cancel && noTicket.body.cancel().catch(() => {});
    const sseTicket = await req('GET', '/api/sse-ticket', { token: docTok });
    ok(sseTicket.json && !!sseTicket.json.ticket, 'authenticated client can mint an SSE ticket');
    const ctrl = new AbortController();
    const stream = await fetch(BASE + '/api/events?ticket=' + encodeURIComponent(sseTicket.json.ticket), { signal: ctrl.signal });
    eq(stream.status, 200, 'events stream accepts a valid ticket');
    ok((stream.headers.get('content-type') || '').includes('text/event-stream'), 'events stream is an event stream');
    ctrl.abort();

    console.log('PIN reset invalidates live tokens');
    const preReset = await req('GET', '/api/me', { token: docTok });
    eq(preReset.status, 200, 'doctor token valid before reset');
    const reset = await op(adminTok, { uid: uid(), kind: 'pin_reset', empId: 'LH-DOC01' });
    eq(reset.status, 200, 'admin resets the doctor’s PIN');
    const postReset = await req('GET', '/api/me', { token: docTok });
    eq(postReset.status, 401, 'doctor’s old token is invalid after PIN reset');
  } finally {
    child.kill('SIGKILL');
    try{ fs.rmSync(DATA_DIR, { recursive: true, force: true }); }catch(e){}
  }

  console.log('');
  if (failures.length){
    console.error(`FAILED: ${failures.length} assertion(s) failed, ${passed} passed.`);
    process.exit(1);
  }
  console.log(`PASSED: ${passed} assertions.`);
  process.exit(0);
}

main().catch(err => { console.error('smoke test crashed:', err); process.exit(1); });
