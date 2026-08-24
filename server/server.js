#!/usr/bin/env node
/* =====================================================================
   Lakeshore One — backend server (pilot / production-lite).

   Zero npm dependencies: Node.js >= 22.5 only (built-in node:sqlite).
   Run:   node server/server.js          (from the repo root or anywhere)
   Env:   PORT (default 8080)
          DATA_DIR (default <server dir>/data)  — sqlite db + secret live here

   Serves:
     /api/*        — JSON API (auth, state, ops, SSE)
     /*            — the static frontend (repo root: hub + apps, PWA)

   Security model (pilot): employee ID + PIN, scrypt-hashed server-side,
   signed bearer tokens, role checks enforced on every operation, login
   rate-limiting, full audit trail. Swap the login handler for hospital
   AD/SSO when IT is ready; everything else stays.
   ===================================================================== */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = parseInt(process.env.PORT || '8080', 10);
/* Google SSO: set GOOGLE_CLIENT_ID to the OAuth web client ID to enable the
   "Sign in with Google" button. Emails an admin has linked to an account sign
   in with that account's role. Unrecognised emails are auto-provisioned:
   GOOGLE_HOSTED_DOMAIN Workspace accounts as staff, any other verified Google
   account (e.g. Gmail) as guest — same limits as the Guest button, but with a
   persistent identity. DEMO_LOGIN=1 enables the one-tap demo nurse sign-in
   (never enable on a production instance). */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_HOSTED_DOMAIN = (process.env.GOOGLE_HOSTED_DOMAIN || '').toLowerCase();
const DEMO_LOGIN = process.env.DEMO_LOGIN === '1';
const SERVER_DIR = __dirname;
const STATIC_ROOT = path.resolve(SERVER_DIR, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(SERVER_DIR, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- secret for token signing (persisted across restarts) ---------- */
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();

/* ---------- database ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'lakeshore-one.db'));
db.exec('PRAGMA journal_mode=WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  emp_id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, dept TEXT,
  pin_hash TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, module TEXT NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL,
  title TEXT NOT NULL, descr TEXT, zone TEXT NOT NULL, priority TEXT NOT NULL,
  patient_impact INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
  reporter TEXT NOT NULL, reporter_name TEXT NOT NULL,
  assignee TEXT, assignee_name TEXT,
  created_at TEXT NOT NULL, responded_at TEXT, resolved_at TEXT,
  due_respond TEXT NOT NULL, due_resolve TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, kind TEXT NOT NULL,
  from_status TEXT, to_status TEXT, body TEXT, author TEXT NOT NULL, author_name TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS beds (
  bed_id TEXT PRIMARY KEY, ward TEXT NOT NULL, status TEXT NOT NULL,
  since TEXT, updated_by TEXT
);
CREATE TABLE IF NOT EXISTS bed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bed_id TEXT NOT NULL,
  from_st TEXT, to_st TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ot_cases (
  id TEXT PRIMARY KEY, suite TEXT NOT NULL, case_date TEXT NOT NULL, planned TEXT NOT NULL,
  dur_min INTEGER NOT NULL, procedure_name TEXT NOT NULL, surgeon TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', created_by TEXT
);
CREATE TABLE IF NOT EXISTS ot_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, stage TEXT NOT NULL,
  actor_name TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS praise (
  id INTEGER PRIMARY KEY AUTOINCREMENT, for_id TEXT, for_name TEXT NOT NULL, for_dept TEXT,
  value TEXT NOT NULL, body TEXT, author TEXT NOT NULL, author_name TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT, idea TEXT NOT NULL, theme TEXT,
  name TEXT, dept TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS applied_ops (uid TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
/* module tables: patient inputs, USG wait queue, OT bookings (added with the module apps) */
db.exec(`
CREATE TABLE IF NOT EXISTS patient_inputs (
  id TEXT PRIMARY KEY, who TEXT NOT NULL, type TEXT NOT NULL, sev TEXT, place TEXT NOT NULL,
  about TEXT NOT NULL, patient_name TEXT, uhid TEXT, descr TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'New', created_at TEXT NOT NULL, resolved_at TEXT, created_by TEXT
);
CREATE TABLE IF NOT EXISTS usg_entries (
  id TEXT PRIMARY KEY, token_no TEXT NOT NULL, name TEXT, uhid TEXT, cls TEXT NOT NULL,
  room TEXT NOT NULL, reg_at TEXT NOT NULL, start_at TEXT, end_at TEXT,
  status TEXT NOT NULL DEFAULT 'waiting', created_by TEXT
);
CREATE TABLE IF NOT EXISTS ot_bookings (
  id TEXT PRIMARY KEY, case_date TEXT NOT NULL, ot TEXT NOT NULL, start TEXT NOT NULL,
  dur_min INTEGER NOT NULL, patient TEXT NOT NULL, uhid TEXT, procedure_name TEXT NOT NULL,
  surgeon TEXT NOT NULL, anaes TEXT, prio TEXT, status TEXT NOT NULL DEFAULT 'booked', created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_pi_stage ON patient_inputs (stage, created_at);
CREATE INDEX IF NOT EXISTS idx_usg_day ON usg_entries (reg_at);
CREATE INDEX IF NOT EXISTS idx_otb_day ON ot_bookings (case_date, ot, start);
`);
/* migration: photo column on tickets (added after first release) */
try{ db.exec('ALTER TABLE tickets ADD COLUMN photo TEXT'); }catch(e){ /* exists */ }
/* migration: email column on users (Google SSO account linking) */
try{ db.exec('ALTER TABLE users ADD COLUMN email TEXT'); }catch(e){ /* exists */ }
db.exec(`
CREATE INDEX IF NOT EXISTS idx_tickets_queue ON tickets (module, status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_updates ON ticket_updates (ticket_id, at);
CREATE INDEX IF NOT EXISTS idx_bed_events ON bed_events (bed_id, at);
`);

/* ---------- domain config (mirrors the frontend) ---------- */
const RESPONDER = { it_agent:'it', facility_agent:'fac', housekeeping_agent:'hk', biomedical_agent:'bm', security_agent:'sec' };
const ROLES = ['doctor','nurse','staff','it_agent','facility_agent','housekeeping_agent','biomedical_agent','security_agent','management','quality','admin','guest','patient'];
/* guests & patients: raise/track visitor-facing desks only, no ops boards */
const isLimited = r => ['guest','patient'].includes(r);
const GUEST_MODS = ['fac','hk','sec'];
const MODS = ['it','fac','hk','bm','sec'];
const PRI = { P1:{resp:15,res:240}, P2:{resp:60,res:480}, P3:{resp:240,res:1440}, P4:{resp:1440,res:4320} };
const TICKET_STATUS = ['open','in_progress','resolved','closed'];
const BED_STATUS = ['occupied','dirty','cleaning','ready','blocked'];
const BED_WARDS = [['3A',20],['4B',16],['5A',14],['ON',16],['ICU',12],['HDU',8]];
const OT_STAGES = ['scheduled','in_ot','anaesthesia','incision','closure','out','cleaning','done'];
const OT_SUITES = ['OT-1 · Cardiac','OT-2 · Neuro','OT-3 · Ortho','OT-4 · Gen & GI','OT-5 · Onco','OT-6 · Uro & Gyn'];
const PRAISE_VALUES = ['Patient first','Team player','Went the extra mile','Calm in a crisis','Always improving'];
const canSeeAll = r => ['management','quality','admin'].includes(r);
const isClinical = r => ['doctor','nurse','staff'].includes(r);
/* module apps (patient-inputs / usg-wait / ot-schedule) */
const PI_TYPES = ['Complaint','Suggestion','Appreciation','Query'];
const PI_SEV = ['High','Medium','Low'];
const PI_STAGES = ['New','Acknowledged','In progress','Resolved','Closed'];
const USG_ROOMS = ['USG-1','USG-2','USG-3','USG-4'];
const USG_CLS = ['OP','IP','Emergency'];
const OTB_IDS = ['OT-1','OT-2','OT-3','OT-4','OT-5','OT-6'];
const OTB_STATUS = ['booked','confirmed','in_ot','done','delayed','cancelled'];
const OTB_DAY_START = 7*60, OTB_DAY_END = 21*60, OTB_TURNOVER = 20;
const toMin = hhmm => { const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm)); return m ? (+m[1])*60 + (+m[2]) : NaN; };
const toHM = min => String(Math.floor(min/60)).padStart(2,'0') + ':' + String(min%60).padStart(2,'0');

/* ---------- seed ---------- */
function seed(){
  const n = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (n === 0){
    const ins = db.prepare('INSERT INTO users (emp_id,name,role,dept,pin_hash,active,created_at) VALUES (?,?,?,?,NULL,1,?)');
    const now = new Date().toISOString();
    for (const [id, name, role, dept] of [
      ['LH-ADMIN','Sameeraj Rao','admin','Corporate'],
      ['LH-IT01','Ajith Kumar','it_agent','Information Technology'],
      ['LH-FM01','Suresh Nair','facility_agent','Engineering & Maintenance'],
      ['LH-HK01','Beena Thomas','housekeeping_agent','Housekeeping'],
      ['LH-BM01','Rahul Menon','biomedical_agent','Biomedical Engineering'],
      ['LH-SEC01','Vinod PS','security_agent','Security'],
      ['LH-DOC01','Dr. Anitha Menon','doctor','Cardiology'],
      ['LH-NUR01','Nisha Varghese','nurse','Nursing'],
      ['LH-MGT01','Hospital Director','management','Administration']
    ]) ins.run(id, name, role, dept, now);
  }
  if (db.prepare('SELECT COUNT(*) c FROM beds').get().c === 0){
    const ins = db.prepare('INSERT INTO beds (bed_id,ward,status,since,updated_by) VALUES (?,?,?,NULL,NULL)');
    for (const [ward, count] of BED_WARDS)
      for (let i = 1; i <= count; i++){
        const id = ward + '-' + String(i).padStart(2,'0');
        let h = 0; for (const ch of id) h = (h*31 + ch.charCodeAt(0))|0;
        h = Math.abs(h) % 20;
        const st = h < 13 ? 'occupied' : h < 16 ? 'ready' : h < 18 ? 'dirty' : h < 19 ? 'cleaning' : 'blocked';
        ins.run(id, ward, st);
      }
  }
  if (!db.prepare("SELECT value FROM meta WHERE key='seq'").get())
    db.prepare("INSERT INTO meta VALUES ('seq','100')").run();
}
seed();
function nextSeq(){
  const v = parseInt(db.prepare("SELECT value FROM meta WHERE key='seq'").get().value, 10) + 1;
  db.prepare("UPDATE meta SET value=? WHERE key='seq'").run(String(v));
  return v;
}
function audit(actor, action){
  db.prepare('INSERT INTO audit (actor,action,at) VALUES (?,?,?)').run(actor, action, new Date().toISOString());
}

/* ---------- crypto helpers ---------- */
function hashPin(pin){
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pin, salt, 32).toString('hex');
  return salt + ':' + h;
}
function verifyPin(pin, stored){
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const calc = crypto.scryptSync(pin, salt, 32);
  const want = Buffer.from(h, 'hex');
  return calc.length === want.length && crypto.timingSafeEqual(calc, want);
}
function sign(empId){
  const payload = Buffer.from(JSON.stringify({ e: empId, x: Date.now() + 12*3600e3 })).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verifyToken(token){
  if (!token) return null;
  const [payload, mac] = String(token).split('.');
  if (!payload || !mac) return null;
  const want = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try{
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (p.x < Date.now()) return null;
    const u = db.prepare('SELECT * FROM users WHERE emp_id=? AND active=1').get(p.e);
    return u || null;
  }catch(e){ return null; }
}

/* ---------- Google SSO (ID-token verification, no dependencies) ---------- */
let googleCertsCache = { keys: null, until: 0 };
async function googleCerts(){
  if (googleCertsCache.keys && googleCertsCache.until > Date.now()) return googleCertsCache.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('cert fetch failed');
  const j = await r.json();
  googleCertsCache = { keys: j.keys, until: Date.now() + 3600e3 };
  return j.keys;
}
async function verifyGoogleToken(credential){
  try{
    const [h, p, sig] = String(credential).split('.');
    if (!h || !p || !sig) return null;
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    const jwk = (await googleCerts()).find(k => k.kid === header.kid);
    if (!jwk || header.alg !== 'RS256') return null;
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    if (!crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), key, Buffer.from(sig, 'base64url'))) return null;
    if (!['https://accounts.google.com','accounts.google.com'].includes(payload.iss)) return null;
    if (payload.aud !== GOOGLE_CLIENT_ID) return null;
    if (!(payload.exp * 1000 > Date.now())) return null;
    if (!payload.email || payload.email_verified !== true) return null;
    return payload;
  }catch(e){ return null; }
}

/* ---------- guest sign-in throttle (global, coarse) ---------- */
let guestWindow = { start: 0, n: 0 };
function guestThrottled(){
  const now = Date.now();
  if (now - guestWindow.start > 3600e3) guestWindow = { start: now, n: 0 };
  guestWindow.n += 1;
  return guestWindow.n > 60;
}

/* ---------- login rate limiting ---------- */
const attempts = new Map();   // empId -> {n, until}
function throttled(empId){
  const a = attempts.get(empId);
  if (a && a.until > Date.now()) return true;
  return false;
}
function noteFailure(empId){
  const a = attempts.get(empId) || { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= 5){ a.until = Date.now() + 15*60e3; a.n = 0; }
  attempts.set(empId, a);
}

/* ---------- suggestion-box throttle (unauthenticated endpoint) ---------- */
const ideaLast = new Map();   // ip -> last accepted submission (ms)
function ideaThrottled(ip){
  const last = ideaLast.get(ip) || 0;
  if (Date.now() - last < 30e3) return true;
  ideaLast.set(ip, Date.now());
  if (ideaLast.size > 5000) ideaLast.clear();
  return false;
}

/* ---------- SSE ---------- */
const sseClients = new Set();
function broadcast(){
  for (const res of sseClients){
    try{ res.write('data: changed\n\n'); }catch(e){ sseClients.delete(res); }
  }
}

/* ---------- operations (server-authoritative, role-checked) ---------- */
function applyOp(op, u){
  const at = new Date().toISOString();
  const role = u.role, empId = u.emp_id, name = u.name;
  if (op.uid){
    if (db.prepare('SELECT uid FROM applied_ops WHERE uid=?').get(op.uid)) return { ok:true, dedup:true };
    db.prepare('INSERT INTO applied_ops (uid,at) VALUES (?,?)').run(String(op.uid).slice(0,40), at);
  }
  const s = (v, n) => String(v ?? '').slice(0, n);

  switch (op.kind){
    case 'create': {
      if (!MODS.includes(op.mod) || !PRI[op.pri] || !op.title) return { ok:false, error:'invalid ticket' };
      if (isLimited(role) && !GUEST_MODS.includes(op.mod))
        return { ok:false, error:'Guests can raise facility, housekeeping and security requests only.' };
      const seq = nextSeq(), id = 'LSO-' + seq;
      const p = PRI[op.pri];
      let photo = null;
      if (typeof op.photo === 'string' && op.photo.startsWith('data:image/jpeg;base64,') && op.photo.length <= 900000)
        photo = op.photo;
      db.prepare(`INSERT INTO tickets (id,module,type,category,title,descr,zone,priority,patient_impact,status,
        reporter,reporter_name,created_at,due_respond,due_resolve,photo)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, op.mod, op.type === 'request' ? 'request' : 'incident', s(op.cat,60), s(op.title,160), s(op.desc,2000),
        s(op.zone,60), op.pri, op.impact ? 1 : 0, 'open', empId, name, at,
        new Date(Date.now() + p.resp*60e3).toISOString(), new Date(Date.now() + p.res*60e3).toISOString(), photo);
      audit(empId, `raised ${id} (${op.mod} · ${s(op.cat,60)} · ${op.pri})`);
      return { ok:true, id };
    }
    case 'comment': {
      const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(String(op.ticket));
      if (!t) return { ok:false, error:'no such ticket' };
      const allowed = t.reporter === empId || canSeeAll(role) || RESPONDER[role] === t.module;
      if (!allowed) return { ok:false, error:'not allowed' };
      db.prepare('INSERT INTO ticket_updates (ticket_id,kind,body,author,author_name,at) VALUES (?,?,?,?,?,?)')
        .run(t.id, 'comment', s(op.text,500), empId, name, at);
      return { ok:true };
    }
    case 'assign': {
      const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(String(op.ticket));
      if (!t) return { ok:false, error:'no such ticket' };
      if (!(canSeeAll(role) || RESPONDER[role] === t.module)) return { ok:false, error:'not allowed' };
      db.prepare('UPDATE tickets SET assignee=?, assignee_name=? WHERE id=?').run(empId, name, t.id);
      db.prepare('INSERT INTO ticket_updates (ticket_id,kind,author,author_name,at) VALUES (?,?,?,?,?)')
        .run(t.id, 'assign', empId, name, at);
      audit(empId, 'took ownership of ' + t.id);
      return { ok:true };
    }
    case 'status': {
      const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(String(op.ticket));
      if (!t || !TICKET_STATUS.includes(op.to) || t.status === op.to) return { ok:false, error:'invalid transition' };
      const agent = RESPONDER[role] === t.module, boss = canSeeAll(role), mine = t.reporter === empId;
      let allowed = false;
      if (op.to === 'in_progress') allowed = (agent || boss) && t.status === 'open';
      else if (op.to === 'resolved') allowed = (agent || boss) && t.status === 'in_progress';
      else if (op.to === 'closed') allowed = (t.status === 'resolved' && (mine || agent || boss)) ||
                                             (t.status === 'open' && mine);
      else if (op.to === 'open') allowed = t.status === 'resolved' && (mine || agent || boss);
      if (!allowed) return { ok:false, error:'not allowed for your role at this state' };
      db.prepare('INSERT INTO ticket_updates (ticket_id,kind,from_status,to_status,body,author,author_name,at) VALUES (?,?,?,?,?,?,?,?)')
        .run(t.id, 'status', t.status, op.to, s(op.text,500), empId, name, at);
      const respondedAt = (op.to === 'in_progress' && !t.responded_at) ? at : t.responded_at;
      const resolvedAt = op.to === 'resolved' ? at : (op.to === 'open' ? null : t.resolved_at);
      db.prepare('UPDATE tickets SET status=?, responded_at=?, resolved_at=? WHERE id=?')
        .run(op.to, respondedAt, resolvedAt, t.id);
      audit(empId, `moved ${t.id} to ${op.to}`);
      return { ok:true };
    }
    case 'bed': {
      const b = db.prepare('SELECT * FROM beds WHERE bed_id=?').get(String(op.bed));
      if (!b || !BED_STATUS.includes(op.to) || b.status === op.to) return { ok:false, error:'invalid bed change' };
      const hk = role === 'housekeeping_agent', fac = role === 'facility_agent',
            boss = ['management','admin'].includes(role), clin = isClinical(role);
      const t = { from: b.status, to: op.to };
      let allowed = false;
      if (t.from === 'occupied' && t.to === 'dirty') allowed = clin || boss;
      else if (t.from === 'dirty' && t.to === 'cleaning') allowed = hk || boss;
      else if (t.from === 'cleaning' && t.to === 'ready') allowed = hk || boss;
      else if (t.from === 'ready' && t.to === 'occupied') allowed = clin || boss;
      else if (t.to === 'blocked' && t.from !== 'occupied') allowed = fac || boss;
      else if (t.from === 'blocked' && t.to === 'ready') allowed = fac || boss;
      if (!allowed) return { ok:false, error:'not allowed for your role at this state' };
      db.prepare('INSERT INTO bed_events (bed_id,from_st,to_st,actor,at) VALUES (?,?,?,?,?)')
        .run(b.bed_id, b.status, op.to, empId, at);
      db.prepare('UPDATE beds SET status=?, since=?, updated_by=? WHERE bed_id=?').run(op.to, at, name, b.bed_id);
      audit(empId, `bed ${b.bed_id} → ${op.to}`);
      return { ok:true };
    }
    case 'ot_add': {
      if (!(isClinical(role) || canSeeAll(role))) return { ok:false, error:'not allowed' };
      if (!OT_SUITES.includes(op.suite) || !op.procedure || !op.surgeon) return { ok:false, error:'invalid case' };
      const seq = nextSeq(), id = 'OTC-' + seq;
      db.prepare('INSERT INTO ot_cases (id,suite,case_date,planned,dur_min,procedure_name,surgeon,status,created_by) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, op.suite, s(op.date,10), s(op.planned,5), Math.min(720, parseInt(op.durMin)||120),
             s(op.procedure,120), s(op.surgeon,60), 'scheduled', empId);
      audit(empId, `scheduled ${id} (${op.suite} ${s(op.planned,5)} · ${s(op.procedure,120)})`);
      return { ok:true, id };
    }
    case 'ot_move': {
      if (!(isClinical(role) || canSeeAll(role))) return { ok:false, error:'not allowed' };
      const c = db.prepare('SELECT * FROM ot_cases WHERE id=?').get(String(op.case));
      if (!c || c.status === op.to) return { ok:false, error:'no such case' };
      const validNext = op.to === 'cancelled'
        ? c.status === 'scheduled'
        : OT_STAGES[OT_STAGES.indexOf(c.status) + 1] === op.to;
      if (!validNext) return { ok:false, error:'invalid stage transition' };
      db.prepare('UPDATE ot_cases SET status=? WHERE id=?').run(op.to, c.id);
      db.prepare('INSERT INTO ot_milestones (case_id,stage,actor_name,at) VALUES (?,?,?,?)').run(c.id, op.to, name, at);
      audit(empId, `${c.id} → ${op.to}`);
      return { ok:true };
    }
    case 'praise': {
      if (isLimited(role)) return { ok:false, error:'not allowed' };
      const forName = s(op.forName, 60), value = s(op.value, 40);
      if (!forName || !PRAISE_VALUES.includes(value)) return { ok:false, error:'invalid praise' };
      let forId = op.forId ? s(op.forId, 20).toUpperCase() : null;
      if (forId && !db.prepare('SELECT emp_id FROM users WHERE emp_id=? AND active=1').get(forId)) forId = null;
      if (forId === empId || forName === name) return { ok:false, error:'you cannot praise yourself' };
      db.prepare('INSERT INTO praise (for_id,for_name,for_dept,value,body,author,author_name,at) VALUES (?,?,?,?,?,?,?,?)')
        .run(forId, forName, s(op.forDept,60), value, s(op.text,500), empId, name, at);
      audit(empId, `praised ${forName} (${value})`);
      return { ok:true };
    }
    case 'praise_del': {
      if (!canSeeAll(role)) return { ok:false, error:'management only' };
      const pid = parseInt(String(op.id || '').replace(/^PRS-/, ''), 10);
      const row = Number.isInteger(pid) ? db.prepare('SELECT * FROM praise WHERE id=?').get(pid) : null;
      if (!row) return { ok:false, error:'no such praise' };
      db.prepare('DELETE FROM praise WHERE id=?').run(pid);
      audit(empId, `removed praise PRS-${pid} for ${row.for_name} (from ${row.author_name})`);
      return { ok:true };
    }
    case 'user_add': {
      if (role !== 'admin') return { ok:false, error:'admin only' };
      const nu = op.user || {};
      const eid = s(nu.empId,20).toUpperCase();
      if (!eid || !nu.name || !ROLES.includes(nu.role)) return { ok:false, error:'invalid user' };
      if (db.prepare('SELECT emp_id FROM users WHERE emp_id=?').get(eid)) return { ok:false, error:'employee ID exists' };
      const email = nu.email ? s(nu.email,80).toLowerCase() : null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok:false, error:'invalid email' };
      db.prepare('INSERT INTO users (emp_id,name,role,dept,pin_hash,active,created_at,email) VALUES (?,?,?,?,NULL,1,?,?)')
        .run(eid, s(nu.name,60), nu.role, s(nu.dept,60), at, email);
      audit(empId, `added user ${eid} (${s(nu.name,60)}, ${nu.role})`);
      return { ok:true };
    }
    case 'user_toggle': {
      if (role !== 'admin') return { ok:false, error:'admin only' };
      if (op.empId === empId) return { ok:false, error:'cannot deactivate yourself' };
      db.prepare('UPDATE users SET active=? WHERE emp_id=?').run(op.active ? 1 : 0, String(op.empId));
      audit(empId, (op.active ? 'reactivated ' : 'deactivated ') + op.empId);
      return { ok:true };
    }
    case 'pin_reset': {
      if (role !== 'admin') return { ok:false, error:'admin only' };
      db.prepare('UPDATE users SET pin_hash=NULL WHERE emp_id=?').run(String(op.empId));
      audit(empId, 'reset PIN for ' + op.empId);
      return { ok:true };
    }
    /* ----- Patient Inputs (voice of the patient) ----- */
    case 'pi_add': {
      /* any signed-in identity may capture an input — including guests & patients themselves */
      if (!PI_TYPES.includes(op.type) || !op.desc) return { ok:false, error:'invalid input' };
      const sev = op.type === 'Complaint' ? (PI_SEV.includes(op.sev) ? op.sev : 'Medium') : null;
      const id = 'PI-' + nextSeq();
      db.prepare(`INSERT INTO patient_inputs (id,who,type,sev,place,about,patient_name,uhid,descr,stage,created_at,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,'New',?,?)`).run(
        id, s(op.who,40), op.type, sev, s(op.where,60), s(op.about,60),
        s(op.name,60), s(op.uhid,20), s(op.desc,2000), at, empId);
      audit(empId, `logged patient input ${id} (${op.type}${sev ? ' · ' + sev : ''} · ${s(op.about,60)})`);
      return { ok:true, id };
    }
    case 'pi_stage': {
      /* triage board is the Patient Experience team's — management / quality / admin only */
      if (!canSeeAll(role)) return { ok:false, error:'Patient Experience team (quality / management) only' };
      const it = db.prepare('SELECT * FROM patient_inputs WHERE id=?').get(String(op.id));
      if (!it) return { ok:false, error:'no such input' };
      if (PI_STAGES.indexOf(op.to) !== PI_STAGES.indexOf(it.stage) + 1) return { ok:false, error:'invalid stage transition' };
      db.prepare('UPDATE patient_inputs SET stage=?, resolved_at=? WHERE id=?')
        .run(op.to, op.to === 'Resolved' ? at : it.resolved_at, it.id);
      audit(empId, `${it.id} → ${op.to}`);
      return { ok:true };
    }

    /* ----- USG wait queue ----- */
    case 'usg_add': {
      if (isLimited(role)) return { ok:false, error:'staff sign-in required' };
      if (!USG_ROOMS.includes(op.room) || !USG_CLS.includes(op.cls)) return { ok:false, error:'invalid entry' };
      const day = at.slice(0,10);
      if (db.prepare("SELECT value FROM meta WHERE key='usg_day'").get()?.value !== day){
        db.prepare("INSERT INTO meta (key,value) VALUES ('usg_day',?) ON CONFLICT(key) DO UPDATE SET value=?").run(day, day);
        db.prepare("INSERT INTO meta (key,value) VALUES ('usg_seq','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
      }
      const n = parseInt(db.prepare("SELECT value FROM meta WHERE key='usg_seq'").get().value, 10) + 1;
      db.prepare("UPDATE meta SET value=? WHERE key='usg_seq'").run(String(n));
      const tokenNo = 'U-' + String(n).padStart(2,'0');
      const id = 'USG-' + nextSeq();
      db.prepare(`INSERT INTO usg_entries (id,token_no,name,uhid,cls,room,reg_at,status,created_by)
        VALUES (?,?,?,?,?,?,?,'waiting',?)`).run(id, tokenNo, s(op.name,60), s(op.uhid,20), op.cls, op.room, at, empId);
      audit(empId, `USG token ${tokenNo} → ${op.room} (${op.cls})`);
      return { ok:true, id, tokenNo };
    }
    case 'usg_move': {
      if (isLimited(role)) return { ok:false, error:'staff sign-in required' };
      const e = db.prepare('SELECT * FROM usg_entries WHERE id=?').get(String(op.id));
      if (!e) return { ok:false, error:'no such entry' };
      const valid = (op.to === 'scanning' && e.status === 'waiting') ||
                    (op.to === 'done' && e.status === 'scanning') ||
                    (op.to === 'noshow' && e.status === 'waiting');
      if (!valid) return { ok:false, error:'invalid transition' };
      db.prepare('UPDATE usg_entries SET status=?, start_at=COALESCE(start_at,?), end_at=? WHERE id=?')
        .run(op.to, op.to === 'scanning' ? at : null, op.to === 'done' ? at : e.end_at, e.id);
      audit(empId, `USG ${e.token_no} → ${op.to}`);
      return { ok:true };
    }

    /* ----- OT bookings (planning board; the live stage board stays on ot_cases) ----- */
    case 'otb_add': {
      if (!(isClinical(role) || canSeeAll(role))) return { ok:false, error:'not allowed' };
      const start = toMin(op.start), dur = Math.min(720, parseInt(op.durMin) || 0);
      const date = s(op.date,10);
      if (!OTB_IDS.includes(op.ot) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(start) || dur < 15 ||
          !op.patient || !op.procedure || !op.surgeon) return { ok:false, error:'invalid booking' };
      if (start < OTB_DAY_START || start + dur > OTB_DAY_END)
        return { ok:false, error:'outside the OT day (07:00–21:00)' };
      const clash = db.prepare("SELECT * FROM ot_bookings WHERE case_date=? AND ot=? AND status!='cancelled'").all(date, op.ot)
        .find(c => start < toMin(c.start) + c.dur_min + OTB_TURNOVER && toMin(c.start) < start + dur + OTB_TURNOVER);
      if (clash) return { ok:false, error:'table clash with ' + clash.id + ' (' + clash.start + '–' +
        toHM(toMin(clash.start) + clash.dur_min) + ' + turnover) — pick another slot' };
      const id = 'OTB-' + nextSeq();
      db.prepare(`INSERT INTO ot_bookings (id,case_date,ot,start,dur_min,patient,uhid,procedure_name,surgeon,anaes,prio,status,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'booked',?)`).run(
        id, date, op.ot, toHM(start), dur, s(op.patient,60), s(op.uhid,20), s(op.procedure,120),
        s(op.surgeon,60), s(op.anaes,20), op.prio === 'Emergency' ? 'Emergency' : 'Elective', empId);
      audit(empId, `booked ${id} (${op.ot} ${date} ${toHM(start)} · ${s(op.procedure,120)})`);
      return { ok:true, id };
    }
    case 'otb_move': {
      if (!(isClinical(role) || canSeeAll(role))) return { ok:false, error:'not allowed' };
      const c = db.prepare('SELECT * FROM ot_bookings WHERE id=?').get(String(op.id));
      if (!c || !OTB_STATUS.includes(op.to)) return { ok:false, error:'no such booking' };
      const from = c.status, to = op.to;
      const valid = (to === 'confirmed' && from === 'booked') ||
                    (to === 'in_ot' && ['confirmed','delayed'].includes(from)) ||
                    (to === 'done' && from === 'in_ot') ||
                    (to === 'delayed' && ['booked','confirmed'].includes(from)) ||
                    (to === 'cancelled' && ['booked','confirmed','delayed'].includes(from));
      if (!valid) return { ok:false, error:'invalid transition' };
      const start = to === 'delayed' ? toHM(Math.min(OTB_DAY_END - c.dur_min, toMin(c.start) + 30)) : c.start;
      db.prepare('UPDATE ot_bookings SET status=?, start=? WHERE id=?').run(to, start, c.id);
      audit(empId, `${c.id} → ${to}`);
      return { ok:true };
    }

    default:
      return { ok:false, error:'unknown op' };
  }
}

/* ---------- module state (patient-inputs / usg-wait / ot-schedule apps) ---------- */
function moduleState(mod, u){
  const iso = d => new Date(d).toISOString();
  if (mod === 'pi'){
    /* the full board (patient names, UHIDs) is Patient Experience only; others see their own captures */
    const rows = canSeeAll(u.role)
      ? db.prepare('SELECT * FROM patient_inputs WHERE created_at>=? ORDER BY created_at DESC LIMIT 500')
          .all(iso(Date.now() - 90*86400e3))
      : db.prepare('SELECT * FROM patient_inputs WHERE created_by=? ORDER BY created_at DESC LIMIT 200').all(u.emp_id);
    return { full: canSeeAll(u.role), items: rows };
  }
  if (mod === 'usg'){
    if (isLimited(u.role)) return null;
    return { full:true, items: db.prepare('SELECT * FROM usg_entries WHERE reg_at>=? ORDER BY reg_at LIMIT 1000')
      .all(iso(Date.now() - 7*86400e3)) };
  }
  if (mod === 'otb'){
    if (isLimited(u.role)) return null;
    const from = iso(Date.now() - 10*86400e3).slice(0,10);
    return { full:true, items: db.prepare('SELECT * FROM ot_bookings WHERE case_date>=? ORDER BY case_date, start LIMIT 1000').all(from) };
  }
  return null;
}

/* ---------- state projection (role-filtered, matches the client shape) ---------- */
function buildState(u){
  const role = u.role;
  const seq = parseInt(db.prepare("SELECT value FROM meta WHERE key='seq'").get().value, 10);
  let tickets;
  if (canSeeAll(role))
    tickets = db.prepare('SELECT * FROM tickets ORDER BY created_at DESC LIMIT 500').all();
  else if (RESPONDER[role])
    tickets = db.prepare('SELECT * FROM tickets WHERE module=? OR reporter=? ORDER BY created_at DESC LIMIT 500')
      .all(RESPONDER[role], u.emp_id);
  else
    tickets = db.prepare('SELECT * FROM tickets WHERE reporter=? ORDER BY created_at DESC LIMIT 200').all(u.emp_id);
  const updStmt = db.prepare('SELECT * FROM ticket_updates WHERE ticket_id=? ORDER BY at');
  const tix = tickets.map(t => ({
    id:t.id, uid:t.id, hasPhoto:!!t.photo, mod:t.module, type:t.type, cat:t.category, title:t.title, desc:t.descr,
    zone:t.zone, pri:t.priority, impact:!!t.patient_impact, status:t.status,
    reporter:t.reporter, reporterName:t.reporter_name, assignee:t.assignee, assigneeName:t.assignee_name,
    createdAt:t.created_at, respondedAt:t.responded_at, resolvedAt:t.resolved_at,
    dueRespond:t.due_respond, dueResolve:t.due_resolve,
    updates: updStmt.all(t.id).map(x => ({ uid:String(x.id), type:x.kind, from:x.from_status, to:x.to_status,
      by:x.author, byName:x.author_name, text:x.body || '', at:x.at }))
  }));
  /* guests & patients never receive the bed board or OT list (patient privacy) */
  const beds = {};
  let bedlog = [], cases = [];
  if (!isLimited(role)){
    for (const b of db.prepare('SELECT * FROM beds').all())
      beds[b.bed_id] = { status:b.status, since:b.since, by:b.updated_by };
    bedlog = db.prepare('SELECT bed_id bed, from_st "from", to_st "to", at FROM bed_events ORDER BY id DESC LIMIT 600').all().reverse();
    const cutoff = new Date(Date.now() - 2*86400e3).toISOString().slice(0,10);
    const msStmt = db.prepare('SELECT * FROM ot_milestones WHERE case_id=? ORDER BY at');
    cases = db.prepare('SELECT * FROM ot_cases WHERE case_date>=? ORDER BY case_date, planned').all(cutoff)
      .map(c => ({ id:c.id, suite:c.suite, date:c.case_date, planned:c.planned, durMin:c.dur_min,
        procedure:c.procedure_name, surgeon:c.surgeon, status:c.status,
        milestones: msStmt.all(c.id).map(m => ({ to:m.stage, at:m.at, by:m.actor_name })) }));
  }
  let users;
  if (role === 'admin')
    users = db.prepare('SELECT * FROM users ORDER BY emp_id').all()
      .map(x => ({ empId:x.emp_id, name:x.name, role:x.role, dept:x.dept, email:x.email || null, active:!!x.active,
                   pinHash: x.pin_hash ? 'set' : null }));
  else
    users = [{ empId:u.emp_id, name:u.name, role:u.role, dept:u.dept, active:true, pinHash:'set' }];
  /* praise wall + a minimal people directory (for the recipient picker) — staff only,
     never sent to guest/patient sessions */
  let praise = [], people = [];
  if (!isLimited(role)){
    praise = db.prepare(`SELECT id, for_id forId, for_name forName, for_dept forDept, value,
      body text, author "by", author_name byName, at FROM praise ORDER BY id DESC LIMIT 200`).all()
      .map(x => ({ ...x, id:'PRS-' + x.id, text:x.text || '', forDept:x.forDept || '' }));
    people = db.prepare("SELECT emp_id empId, name, dept FROM users WHERE active=1 AND role NOT IN ('guest','patient') ORDER BY name").all();
  }
  const auditRows = canSeeAll(role)
    ? db.prepare('SELECT actor "by", action, at FROM audit ORDER BY id DESC LIMIT 40').all()
    : [];
  return { seq, ops:[], users, tickets:tix, beds, bedlog, ot:{ cases }, praise, people, audit:auditRows };
}

/* ---------- HTTP plumbing ---------- */
function json(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type':'application/json', 'Cache-Control':'no-store' });
  res.end(body);
}
function readBody(req){
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => { try{ resolve(data ? JSON.parse(data) : {}); }catch(e){ reject(e); } });
    req.on('error', reject);
  });
}
function bearer(req, url){
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return url.searchParams.get('token');
}
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.webmanifest':'application/manifest+json',
  '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.txt':'text/plain' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try{
    /* ---- API ---- */
    if (p === '/api/health') return json(res, 200, { ok:true, service:'lakeshore-one' });

    if (p === '/api/config')
      return json(res, 200, { googleClientId: GOOGLE_CLIENT_ID || null, demoLogin: DEMO_LOGIN });

    if (p === '/api/guest' && req.method === 'POST'){
      const { as } = await readBody(req);
      if (!['guest','patient','nurse'].includes(as)) return json(res, 400, { error:'invalid sign-in type' });
      if (as === 'nurse'){
        if (!DEMO_LOGIN) return json(res, 403, { error:'Nurse demo sign-in is disabled on this server — sign in with your employee ID.' });
        let u = db.prepare("SELECT * FROM users WHERE emp_id='LH-NURSE'").get();
        if (!u){
          db.prepare("INSERT INTO users (emp_id,name,role,dept,pin_hash,active,created_at) VALUES ('LH-NURSE','Demo Nurse','nurse','Nursing','locked',1,?)")
            .run(new Date().toISOString());
        } else if (!u.active) return json(res, 403, { error:'Demo nurse account is deactivated.' });
        audit('LH-NURSE', 'demo nurse sign-in');
        return json(res, 200, { token:sign('LH-NURSE'), empId:'LH-NURSE' });
      }
      if (guestThrottled()) return json(res, 429, { error:'Too many guest sign-ins right now — try again later.' });
      const seq = nextSeq();
      const eid = (as === 'patient' ? 'PAT-' : 'GST-') + seq;
      const name = as === 'patient' ? 'Patient · ' + seq : 'Guest · ' + seq;
      /* pin_hash 'locked' can never verify, so guest IDs are unusable at the PIN login */
      db.prepare('INSERT INTO users (emp_id,name,role,dept,pin_hash,active,created_at) VALUES (?,?,?,?,?,1,?)')
        .run(eid, name, as, 'Visitor', 'locked', new Date().toISOString());
      audit(eid, as + ' sign-in (no account)');
      broadcast();
      return json(res, 200, { token:sign(eid), empId:eid });
    }

    if (p === '/api/google-login' && req.method === 'POST'){
      if (!GOOGLE_CLIENT_ID) return json(res, 404, { error:'Google sign-in is not configured on this server.' });
      const { credential } = await readBody(req);
      const g = await verifyGoogleToken(credential);
      if (!g) return json(res, 401, { error:'Google sign-in could not be verified — try again.' });
      const email = g.email.toLowerCase();
      let u = db.prepare('SELECT * FROM users WHERE email IS NOT NULL AND lower(email)=? AND active=1').get(email);
      if (!u){
        /* a deactivated account with this email stays blocked — never silently re-created */
        if (db.prepare('SELECT emp_id FROM users WHERE email IS NOT NULL AND lower(email)=?').get(email))
          return json(res, 403, { error:'This account has been deactivated. Contact IT / admin.' });
        /* auto-provision: hospital Workspace domain → staff; any other verified
           Google account → guest access (same limits as the Guest button), with a
           persistent identity so they get the same account back every sign-in */
        const hosted = !!(GOOGLE_HOSTED_DOMAIN &&
          ((g.hd || '').toLowerCase() === GOOGLE_HOSTED_DOMAIN || email.endsWith('@' + GOOGLE_HOSTED_DOMAIN)));
        if (!hosted && guestThrottled()) return json(res, 429, { error:'Too many sign-ups right now — try again later.' });
        let eid = ((hosted ? 'G-' : 'GV-') + email.split('@')[0]).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
        if (db.prepare('SELECT emp_id FROM users WHERE emp_id=?').get(eid)) eid = eid.slice(0, 14) + '-' + nextSeq();
        db.prepare('INSERT INTO users (emp_id,name,role,dept,pin_hash,active,created_at,email) VALUES (?,?,?,?,?,1,?,?)')
          .run(eid, String(g.name || email).slice(0, 60), hosted ? 'staff' : 'guest', hosted ? '' : 'Visitor',
               'locked', new Date().toISOString(), email);
        audit(eid, 'auto-provisioned via Google SSO (' + email + (hosted ? '' : ' · guest access') + ')');
        u = db.prepare('SELECT * FROM users WHERE emp_id=?').get(eid);
      }
      audit(u.emp_id, 'signed in with Google (' + email + ')');
      return json(res, 200, { token:sign(u.emp_id), empId:u.emp_id });
    }

    if (p === '/api/login' && req.method === 'POST'){
      const { empId, pin } = await readBody(req);
      const eid = String(empId || '').toUpperCase().trim();
      if (throttled(eid)) return json(res, 429, { error:'Too many attempts — try again in 15 minutes.' });
      const u = db.prepare('SELECT * FROM users WHERE emp_id=? AND active=1').get(eid);
      if (!u) { noteFailure(eid); return json(res, 401, { error:'Unknown or inactive employee ID.' }); }
      if (u.pin_hash === null) return json(res, 200, { needPin:true });
      if (!pin || !verifyPin(String(pin), u.pin_hash)){
        noteFailure(eid);
        return json(res, 401, { error:'Wrong PIN. Ask an admin to reset it if forgotten.' });
      }
      attempts.delete(eid);
      return json(res, 200, { token:sign(eid), empId:eid });
    }

    if (p === '/api/set-pin' && req.method === 'POST'){
      const { empId, pin } = await readBody(req);
      const eid = String(empId || '').toUpperCase().trim();
      const u = db.prepare('SELECT * FROM users WHERE emp_id=? AND active=1').get(eid);
      if (!u) return json(res, 401, { error:'Unknown employee ID.' });
      if (u.pin_hash !== null) return json(res, 403, { error:'PIN already set — sign in, or ask an admin to reset it.' });
      if (!/^\d{4,6}$/.test(String(pin || ''))) return json(res, 400, { error:'PIN must be 4–6 digits.' });
      db.prepare('UPDATE users SET pin_hash=? WHERE emp_id=?').run(hashPin(String(pin)), eid);
      audit(eid, 'set their PIN');
      broadcast();
      return json(res, 200, { token:sign(eid), empId:eid });
    }

    /* staff suggestion box — deliberately open so ideas can be anonymous */
    if (p === '/api/idea' && req.method === 'POST'){
      const ip = req.socket.remoteAddress || '?';
      if (ideaThrottled(ip)) return json(res, 429, { error:'One idea per 30 seconds — please try again shortly.' });
      const b = await readBody(req);
      const idea = String(b.idea || '').trim();
      if (idea.length < 10 || idea.length > 1000) return json(res, 400, { error:'Idea must be 10–1000 characters.' });
      const s = (v, n) => String(v ?? '').trim().slice(0, n);
      db.prepare('INSERT INTO ideas (idea,theme,name,dept,at) VALUES (?,?,?,?,?)')
        .run(idea, s(b.theme,40), s(b.name,60), s(b.dept,60), new Date().toISOString());
      audit(s(b.name,60) || 'anonymous', 'shared a workplace idea (' + s(b.theme,40) + ')');
      return json(res, 200, { ok:true });
    }

    /* authenticated routes */
    if (p.startsWith('/api/')){
      const u = verifyToken(bearer(req, url));
      if (!u) return json(res, 401, { error:'Sign in required.' });

      if (p === '/api/me') return json(res, 200, { empId:u.emp_id, name:u.name, role:u.role, dept:u.dept });
      if (p === '/api/state') return json(res, 200, buildState(u));
      if (p === '/api/mod-state'){
        const st = moduleState(url.searchParams.get('mod'), u);
        if (!st) return json(res, 403, { error:'not allowed' });
        return json(res, 200, st);
      }
      if (p === '/api/ideas'){
        if (!canSeeAll(u.role)) return json(res, 403, { error:'not allowed' });
        return json(res, 200, { ideas: db.prepare('SELECT * FROM ideas ORDER BY id DESC LIMIT 200').all() });
      }
      if (p.startsWith('/api/photo/')){
        const t = db.prepare('SELECT module,reporter,photo FROM tickets WHERE id=?').get(p.slice(11));
        if (!t || !t.photo) return json(res, 404, { error:'no photo' });
        const visible = t.reporter === u.emp_id || canSeeAll(u.role) || RESPONDER[u.role] === t.module;
        if (!visible) return json(res, 403, { error:'not allowed' });
        return json(res, 200, { photo: t.photo });
      }
      if (p === '/api/op' && req.method === 'POST'){
        const { op } = await readBody(req);
        if (!op || typeof op !== 'object') return json(res, 400, { error:'missing op' });
        const result = applyOp(op, u);
        if (result.ok) broadcast();
        return json(res, result.ok ? 200 : 403, result);
      }
      if (p === '/api/events'){
        res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-store', Connection:'keep-alive' });
        res.write('retry: 3000\n\n');
        sseClients.add(res);
        const ping = setInterval(() => { try{ res.write(': ping\n\n'); }catch(e){} }, 25000);
        req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
        return;
      }
      return json(res, 404, { error:'not found' });
    }

    /* ---- static frontend ---- */
    let rel = decodeURIComponent(p);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(STATIC_ROOT, rel));
    if (!file.startsWith(STATIC_ROOT) || file.startsWith(SERVER_DIR) || path.basename(file).startsWith('.git')){
      res.writeHead(404); return res.end('not found');
    }
    fs.readFile(file, (err, data) => {
      if (err){ res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  }catch(e){
    json(res, 500, { error:'server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Lakeshore One server → http://localhost:${PORT}  (data: ${DATA_DIR})`);
});
