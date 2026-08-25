/* =====================================================================
   Lakeshore One — auth & access-control tests (zero dependencies).

   Run:  node --test server/server.test.js
   Boots real server processes on temp databases and exercises the
   security-sensitive endpoints: guest/patient sign-in, demo-nurse gate,
   Google SSO gating, role-scoped state, email linking, guest cleanup.
   ===================================================================== */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let nextPort = 18100 + (process.pid % 400);

async function startServer(env = {}){
  const port = nextPort++;
  const dataDir = env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'lso-test-'));
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: dataDir, ...env },
    stdio: 'ignore'
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++){
    try{ if ((await fetch(base + '/api/health')).ok) return { child, base, dataDir }; }catch(e){}
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('server did not start');
}
function stop(srv){
  return new Promise(resolve => { srv.child.on('exit', resolve); srv.child.kill(); });
}
const post = (base, p, body, token) => fetch(base + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify(body)
});
const get = (base, p, token) => fetch(base + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
async function adminToken(base){
  const r = await post(base, '/api/set-pin', { empId: 'LH-ADMIN', pin: '1234' });
  assert.equal(r.status, 200);
  return (await r.json()).token;
}
const op = (base, token, body) => post(base, '/api/op', { op: { uid: Math.random().toString(36).slice(2), ...body } }, token);

test('default server: guest access model', async () => {
  const srv = await startServer();
  try{
    const cfg = await (await get(srv.base, '/api/config')).json();
    assert.deepEqual(cfg, { googleClientId: null, demoLogin: false });

    assert.equal((await post(srv.base, '/api/guest', { as: 'nurse' })).status, 403);
    assert.equal((await post(srv.base, '/api/guest', { as: 'admin' })).status, 400);
    assert.equal((await post(srv.base, '/api/google-login', { credential: 'x' })).status, 404);

    const g = await (await post(srv.base, '/api/guest', { as: 'guest' })).json();
    assert.match(g.empId, /^GST-\d+$/);
    const me = await (await get(srv.base, '/api/me', g.token)).json();
    assert.equal(me.role, 'guest');

    const p = await (await post(srv.base, '/api/guest', { as: 'patient' })).json();
    assert.match(p.empId, /^PAT-\d+$/);
    assert.equal((await (await get(srv.base, '/api/me', p.token)).json()).role, 'patient');

    /* guests raise visitor desks only */
    const bad = await op(srv.base, g.token, { kind: 'create', mod: 'it', pri: 'P3', title: 'x', cat: 'c', zone: 'z' });
    assert.equal(bad.status, 403);
    const ok = await (await op(srv.base, g.token, { kind: 'create', mod: 'hk', pri: 'P3', title: 'spill near lift', cat: 'Cleaning', zone: 'Lobby' })).json();
    assert.equal(ok.ok, true);

    /* guest state: own tickets only, no beds / OT / audit / other users */
    const gs = await (await get(srv.base, '/api/state', g.token)).json();
    assert.equal(gs.tickets.length, 1);
    assert.equal(gs.tickets[0].reporter, g.empId);
    assert.deepEqual(gs.beds, {});
    assert.deepEqual(gs.bedlog, []);
    assert.deepEqual(gs.ot.cases, []);
    assert.deepEqual(gs.audit, []);
    assert.deepEqual(gs.users.map(u => u.empId), [g.empId]);

    /* the other guest can't see it */
    const ps = await (await get(srv.base, '/api/state', p.token)).json();
    assert.equal(ps.tickets.length, 0);

    /* admin sees the ticket, the guest rows, and email in the user list */
    const at = await adminToken(srv.base);
    const as = await (await get(srv.base, '/api/state', at)).json();
    assert.ok(as.tickets.some(t => t.reporter === g.empId));
    assert.ok(as.users.some(u => u.empId === g.empId));
    assert.ok('email' in as.users[0]);

    /* global guest throttle kicks in */
    let throttled = false;
    for (let i = 0; i < 70 && !throttled; i++)
      throttled = (await post(srv.base, '/api/guest', { as: 'guest' })).status === 429;
    assert.ok(throttled, 'expected a 429 within 70 guest sign-ins');
  } finally { await stop(srv); }
});

test('email linking: user_email op and uniqueness', async () => {
  const srv = await startServer();
  try{
    const at = await adminToken(srv.base);

    /* link an email to an existing (seeded) user */
    let r = await (await op(srv.base, at, { kind: 'user_email', empId: 'LH-DOC01', email: 'anitha@lakeshorehospital.org' })).json();
    assert.equal(r.ok, true);
    const st = await (await get(srv.base, '/api/state', at)).json();
    assert.equal(st.users.find(u => u.empId === 'LH-DOC01').email, 'anitha@lakeshorehospital.org');

    /* same email can't go to a second user, in user_email or user_add */
    r = await (await op(srv.base, at, { kind: 'user_email', empId: 'LH-NUR01', email: 'Anitha@lakeshorehospital.org' })).json();
    assert.equal(r.ok, false);
    r = await (await op(srv.base, at, { kind: 'user_add', user: { empId: 'LH-X1', name: 'X', role: 'staff', dept: '', email: 'anitha@lakeshorehospital.org' } })).json();
    assert.equal(r.ok, false);

    /* re-linking to the same user, format check, unlink, non-admin, unknown user */
    assert.equal((await (await op(srv.base, at, { kind: 'user_email', empId: 'LH-DOC01', email: 'anitha@lakeshorehospital.org' })).json()).ok, true);
    assert.equal((await (await op(srv.base, at, { kind: 'user_email', empId: 'LH-DOC01', email: 'not-an-email' })).json()).ok, false);
    assert.equal((await (await op(srv.base, at, { kind: 'user_email', empId: 'LH-DOC01', email: null })).json()).ok, true);
    assert.equal((await (await op(srv.base, at, { kind: 'user_email', empId: 'LH-NOPE', email: 'a@b.co' })).json()).ok, false);
    const g = await (await post(srv.base, '/api/guest', { as: 'guest' })).json();
    assert.equal((await op(srv.base, g.token, { kind: 'user_email', empId: 'LH-DOC01', email: 'evil@x.co' })).status, 403);
  } finally { await stop(srv); }
});

test('demo & SSO flags: nurse login and google-login gating', async () => {
  const srv = await startServer({ DEMO_LOGIN: '1', GOOGLE_CLIENT_ID: 'test-client-id' });
  try{
    const cfg = await (await get(srv.base, '/api/config')).json();
    assert.deepEqual(cfg, { googleClientId: 'test-client-id', demoLogin: true });

    const n = await (await post(srv.base, '/api/guest', { as: 'nurse' })).json();
    assert.equal(n.empId, 'LH-NURSE');
    assert.equal((await (await get(srv.base, '/api/me', n.token)).json()).role, 'nurse');

    /* malformed / forged credentials are rejected without touching the network */
    assert.equal((await post(srv.base, '/api/google-login', { credential: 'garbage' })).status, 401);
    assert.equal((await post(srv.base, '/api/google-login', { credential: 'a.b.c' })).status, 401);
  } finally { await stop(srv); }
});

test('cleanup: ticketless guests expire after 7 days, ticketed ones stay', async () => {
  let srv = await startServer();
  const dataDir = srv.dataDir;
  const idle = await (await post(srv.base, '/api/guest', { as: 'guest' })).json();
  const active = await (await post(srv.base, '/api/guest', { as: 'patient' })).json();
  const r = await (await op(srv.base, active.token, { kind: 'create', mod: 'fac', pri: 'P4', title: 'AC not cooling', cat: 'HVAC', zone: 'Ward 3A' })).json();
  assert.equal(r.ok, true);
  await stop(srv);

  /* backdate both sign-ins past the 7-day window */
  const db = new DatabaseSync(path.join(dataDir, 'lakeshore-one.db'));
  const old = new Date(Date.now() - 8 * 86400e3).toISOString();
  db.prepare('UPDATE users SET created_at=? WHERE emp_id IN (?,?)').run(old, idle.empId, active.empId);
  db.close();

  /* cleanup runs at startup */
  srv = await startServer({ DATA_DIR: dataDir });
  try{
    const at = await adminToken(srv.base);
    const users = (await (await get(srv.base, '/api/state', at)).json()).users.map(u => u.empId);
    assert.ok(!users.includes(idle.empId), 'idle guest should be purged');
    assert.ok(users.includes(active.empId), 'guest with a ticket must be kept');
  } finally { await stop(srv); }
});
