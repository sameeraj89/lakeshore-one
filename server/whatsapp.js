/* =====================================================================
   Lakeshore One — WhatsApp intake channel (Meta WhatsApp Cloud API).

   Staff message the hospital's WhatsApp number in plain language
   (English / Malayalam / Manglish, photo optional). AI triage turns the
   message into a properly classified ticket in the same queues agents
   already work — module, category, priority, zone, patient impact —
   and the reporter gets ticket updates back on WhatsApp.

   Zero npm dependencies (global fetch, Node >= 22.5).

   Env:
     WHATSAPP_TOKEN         Cloud API access token (permanent, from Meta)
     WHATSAPP_PHONE_ID      Phone-number ID used to send replies
     WHATSAPP_VERIFY_TOKEN  Webhook verify token (auto-generated into
                            DATA_DIR/wa-verify.token when unset)
     WHATSAPP_APP_SECRET    Meta app secret — enables X-Hub-Signature-256
                            verification of incoming webhooks (recommended)
     ANTHROPIC_API_KEY      Enables AI triage (Claude). Without it the
                            keyword fallback below still classifies.
     ANTHROPIC_MODEL        Default: claude-opus-5

   See server/WHATSAPP.md for the full setup guide.
   ===================================================================== */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GRAPH = 'https://graph.facebook.com/v23.0';

/* ---------- taxonomy (mirrors the frontend / server.js) ---------- */
const MOD_LABEL = { it:'IT & Systems', fac:'Facility & Engineering', hk:'Housekeeping', bm:'Biomedical', sec:'Security' };
const CATS = {
  it: { incident:['Workstation / PC','HIS / EMR issue','PACS / imaging','LIS / lab system','Printer / scanner','Network / LAN down','Wi-Fi problem','Telephone / intercom','Email issue','Other IT issue'],
        request:['New HIS user / access','Access change / revoke','Password reset','New hardware','Software installation','Email ID creation','Report / data extract','Move equipment'] },
  fac:{ incident:['Electrical / power','Lights / fixtures','Plumbing / leak','AC / HVAC','Medical gas','Lift / elevator','Door / furniture / civil','Seepage / painting','Pest control','Other facility'] },
  hk: { incident:['Cleaning needed','Spill — biohazard','Spill — general','Washroom complaint','Waste not collected','Linen issue','Odour / other'] },
  bm: { incident:['Equipment breakdown','Equipment alarm issue','Calibration due / expired','Accessory / consumable','Other biomedical'] },
  sec:{ incident:['Unauthorized access','Security assistance','Lost & found','Parking issue','Visitor management','CCTV request'] }
};
const ZONES = ['Data Centre','Reception & Billing','Wards Tower','ICU Complex','OT Complex','Cath Lab',
  'Radiology & Imaging','Central Lab','Oncology Block','OP Block','Pharmacy','Emergency & Trauma',
  'Admin Block','Cafeteria','Main Gate & Parking','Other / Not sure'];
const PRI_HINT = { P1:'response in 15 min', P2:'response in 1 h', P3:'response in 4 h', P4:'response in 1 day' };

/* ---------- keyword fallback triage (also the demo-page logic) ---------- */
function heuristicTriage(text){
  const t = ' ' + String(text).toLowerCase() + ' ';
  const score = (words) => words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
  const modScores = {
    it:  score(['computer','pc','system','his ','emr','pacs','lis ','printer','network','lan','wifi','wi-fi','internet','password','login','email','phone line','intercom','software','monitor screen','server']),
    fac: score(['power','electric','light','plumb','leak','tap','water','ac ','a/c','hvac','air condition','oxygen line','medical gas','lift','elevator','door','furniture','ceiling','seepage','paint','pest','genset']),
    hk:  score(['clean','spill','blood on','vomit','washroom','toilet','bathroom','waste','garbage','dustbin','linen','bedsheet','smell','odour','odor','mop']),
    bm:  score(['ventilator','monitor alarm','infusion','syringe pump','defib','ecg','ultrasound machine','x-ray machine','equipment','calibration','probe','bipap','cpap','dialysis machine','suction']),
    sec: score(['security','unauthorized','theft','stolen','lost','found','parking','visitor','fight','cctv','guard'])
  };
  let mod = 'it', best = -1;
  for (const [m, s] of Object.entries(modScores)) if (s > best){ best = s; mod = m; }
  if (best <= 0) mod = 'fac';
  const isRequest = mod === 'it' && score(['need ','request','new user','create ','install','access to','id for','extract','provide']) > 0
    && score(['down','not working','broken','error','fail','issue','problem','slow']) === 0;
  const type = isRequest ? 'request' : 'incident';
  const cats = CATS[mod][type] || CATS[mod].incident;
  let cat = type === 'request' ? 'New hardware' : cats[cats.length - 1];
  const catWords = {
    'Email ID creation':['email id','email account','new email'], 'New HIS user / access':['his user','new user','his access','access for'],
    'Software installation':['install','software'], 'Report / data extract':['report','extract','data from'],
    'New hardware':['new pc','new computer','new printer','new monitor','hardware'], 'Access change / revoke':['revoke','change access','transfer access'],
    'Wi-Fi problem':['wifi','wi-fi'], 'Network / LAN down':['network','lan','internet'],
    'HIS / EMR issue':['his ','emr'], 'Printer / scanner':['printer','scanner','print'],
    'Password reset':['password'], 'Workstation / PC':['computer','pc ','desktop'],
    'AC / HVAC':['ac ','a/c','hvac','air condition','cooling'], 'Plumbing / leak':['leak','plumb','tap','water'],
    'Electrical / power':['power','electric','socket'], 'Lift / elevator':['lift','elevator'],
    'Medical gas':['oxygen','medical gas','o2'], 'Lights / fixtures':['light','tube','bulb'],
    'Spill — biohazard':['blood spill','blood on','blood near','vomit','biohazard','body fluid'], 'Spill — general':['spill','water on floor'],
    'Cleaning needed':['clean','dirty','mop'], 'Washroom complaint':['washroom','toilet','bathroom'],
    'Waste not collected':['waste','garbage','dustbin'], 'Linen issue':['linen','bedsheet'],
    'Equipment breakdown':['not working','broken','breakdown','dead'], 'Equipment alarm issue':['alarm','beeping'],
    'Calibration due / expired':['calibration'], 'Unauthorized access':['unauthorized','intruder'],
    'Lost & found':['lost','found','missing'], 'Parking issue':['parking'], 'CCTV request':['cctv','camera footage'],
    'Security assistance':['fight','aggressive','security help']
  };
  let bestLen = 0;   // prefer the longest keyword match; later (more specific) categories win ties
  for (const c of cats) for (const w of (catWords[c] || [])) if (t.includes(w) && w.length >= bestLen){ cat = c; bestLen = w.length; }
  const zoneAlias = [
    ['ICU Complex',['icu','intensive care','hdu']], ['OT Complex',['ot ',' ot','theatre','theater','operation']],
    ['Emergency & Trauma',['emergency','casualty','trauma',' er ']], ['Wards Tower',['ward','room 3','room 4','room 5']],
    ['Central Lab',['lab ','laboratory']], ['Radiology & Imaging',['radiology','x-ray','xray','ct ','mri','imaging','scan']],
    ['Pharmacy',['pharmacy','medical store']], ['Oncology Block',['oncology','chemo']],
    ['Cath Lab',['cath']], ['OP Block',['opd','op block','outpatient','consult']],
    ['Reception & Billing',['reception','billing','front office']], ['Admin Block',['admin','hr ','office']],
    ['Cafeteria',['cafeteria','canteen','kitchen']], ['Main Gate & Parking',['gate','parking']],
    ['Data Centre',['data centre','data center','server room']]
  ];
  const zone = ZONES.find(z => t.includes(z.toLowerCase()))
    || (zoneAlias.find(([, words]) => words.some(w => t.includes(w))) || [])[0]
    || 'Other / Not sure';
  const impact = score(['patient','icu','ot ','operation','ventilator','oxygen','o2','emergency','casualty','critical','surgery']) > 0;
  let pri = 'P3';
  if (score(['down','all ','entire','fire','flood','no power','oxygen','o2 ']) > 0) pri = 'P2';
  if (impact && score(['down','not working','alarm','leak','no power','stopped','fail']) > 0) pri = 'P1';
  else if (impact) pri = 'P2';
  if (type === 'request') pri = 'P4';
  const title = String(text).replace(/\s+/g, ' ').trim().slice(0, 120) || 'WhatsApp report';
  return { mod, type, cat, title, zone, pri, impact, confidence:'low' };
}

/* ---------- AI triage (Claude API, raw HTTP — zero-dependency) ---------- */
function triageToolSchema(){
  return {
    name: 'triage',
    description: 'Record the classification of a hospital staff incident/request message into the service-desk taxonomy.',
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        mod:   { type:'string', enum: Object.keys(CATS), description:'Responding desk: it / fac (facility & engineering) / hk (housekeeping) / bm (biomedical) / sec (security)' },
        type:  { type:'string', enum:['incident','request'], description:'incident = something is broken; request = staff needs something (IT desk only; other desks use incident)' },
        cat:   { type:'string', description:'Category — must be one of the listed categories for the chosen desk and type' },
        title: { type:'string', description:'Short English title for the ticket, max 100 chars, actionable (e.g. "Wi-Fi down at ICU nursing station")' },
        zone:  { type:'string', enum: ZONES, description:'Campus zone; use "Other / Not sure" when the message does not indicate one' },
        pri:   { type:'string', enum:['P1','P2','P3','P4'], description:'P1 patient care blocked right now; P2 care/department badly degraded; P3 inconvenient but working; P4 routine' },
        impact:{ type:'boolean', description:'true when patient care is affected or at risk' }
      },
      required: ['mod','type','cat','title','zone','pri','impact']
    }
  };
}
function triageSystemPrompt(){
  const catLines = Object.entries(CATS).map(([m, byType]) =>
    Object.entries(byType).map(([ty, list]) => `${m} ${ty}: ${list.join(' | ')}`).join('\n')).join('\n');
  return `You triage staff messages for the service desk of VPS Lakeshore Hospital, Kochi (tertiary care).
Messages come in over WhatsApp from doctors, nurses and staff. They may be in English, Malayalam, or Manglish (Malayalam in Latin script), terse, or contain typos. A photo caption may be all the text you get.

Call the triage tool exactly once with your classification.

Desks and their categories (cat MUST be copied verbatim from this list for the chosen mod+type):
${catLines}

Rules:
- type "request" exists only on the it desk; every other desk is "incident".
- Priority: P1 = patient care blocked right now (HIS down house-wide, O2 alarm, ICU power, ventilator failure). P2 = care or a department badly degraded, or any incident where patient care is affected. P3 = inconvenient but working. P4 = routine requests.
- If impact is true, priority must be P1 or P2.
- Zones: pick the closest match; "Wards Tower" for ward mentions, "OT Complex" for operating theatres, "Emergency & Trauma" for casualty/ER. Use "Other / Not sure" rather than guessing.
- Title: plain English, specific, under 100 characters. Translate if the message is not in English.`;
}
async function aiTriage(text, hasPhoto, cfg){
  const body = {
    model: cfg.model,
    max_tokens: 2000,
    system: [{ type:'text', text: triageSystemPrompt(), cache_control:{ type:'ephemeral' } }],
    tools: [triageToolSchema()],
    messages: [{ role:'user', content: `WhatsApp message from staff${hasPhoto ? ' (a photo was attached)' : ''}:\n\n${String(text).slice(0, 2000)}` }]
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type':'application/json', 'x-api-key':cfg.apiKey, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000)
  });
  if (!res.ok) throw new Error('anthropic ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const msg = await res.json();
  const call = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'triage');
  if (!call) throw new Error('no triage tool call in response (stop_reason ' + msg.stop_reason + ')');
  return sanitizeTriage(call.input);
}
/* clamp AI output onto the real taxonomy so a bad value can never break a ticket */
function sanitizeTriage(x){
  const out = {};
  out.mod = CATS[x.mod] ? x.mod : 'fac';
  out.type = (x.type === 'request' && CATS[out.mod].request) ? 'request' : 'incident';
  const cats = CATS[out.mod][out.type];
  out.cat = cats.includes(x.cat) ? x.cat : cats[cats.length - 1];
  out.zone = ZONES.includes(x.zone) ? x.zone : 'Other / Not sure';
  out.pri = ['P1','P2','P3','P4'].includes(x.pri) ? x.pri : 'P3';
  out.impact = !!x.impact;
  if (out.impact && (out.pri === 'P3' || out.pri === 'P4')) out.pri = 'P2';   // patient-care rule, enforced in code
  out.title = String(x.title || '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'WhatsApp report';
  out.confidence = 'ai';
  return out;
}

/* ===================================================================== */
module.exports = function initWhatsApp({ db, dataDir, applyOp, broadcast, audit }){
  const cfg = {
    token: process.env.WHATSAPP_TOKEN || '',
    phoneId: process.env.WHATSAPP_PHONE_ID || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5'
  };
  /* verify token: env, else generated once and persisted next to the db */
  let verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || '';
  if (!verifyToken){
    const f = path.join(dataDir, 'wa-verify.token');
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(12).toString('hex'), { mode: 0o600 });
    verifyToken = fs.readFileSync(f, 'utf8').trim();
  }

  db.exec(`
  CREATE TABLE IF NOT EXISTS wa_links (
    phone TEXT PRIMARY KEY, emp_id TEXT NOT NULL, linked_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS wa_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, wamid TEXT UNIQUE, phone TEXT NOT NULL,
    direction TEXT NOT NULL, body TEXT, ticket_id TEXT, at TEXT NOT NULL
  );`);

  const sendable = !!(cfg.token && cfg.phoneId);
  console.log(sendable
    ? `WhatsApp intake: enabled (webhook /api/whatsapp/webhook, verify token: ${verifyToken})${cfg.apiKey ? ' + AI triage (' + cfg.model + ')' : ' — keyword triage only (set ANTHROPIC_API_KEY for AI triage)'}`
    : 'WhatsApp intake: not configured (set WHATSAPP_TOKEN and WHATSAPP_PHONE_ID) — see server/WHATSAPP.md');

  /* ---------- outbound ---------- */
  async function sendText(phone, text){
    if (!sendable) return;
    try{
      const res = await fetch(`${GRAPH}/${cfg.phoneId}/messages`, {
        method: 'POST',
        headers: { 'content-type':'application/json', authorization:'Bearer ' + cfg.token },
        body: JSON.stringify({ messaging_product:'whatsapp', to: phone, type:'text', text:{ body: text.slice(0, 4000) } }),
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) console.error('wa send failed', res.status, (await res.text()).slice(0, 300));
      else db.prepare('INSERT INTO wa_messages (phone,direction,body,at) VALUES (?,?,?,?)')
             .run(phone, 'out', text.slice(0, 1000), new Date().toISOString());
    }catch(e){ console.error('wa send error', e.message); }
  }

  /* ---------- media (photo evidence on tickets) ---------- */
  async function fetchImage(mediaId){
    const meta = await fetch(`${GRAPH}/${mediaId}`, {
      headers: { authorization:'Bearer ' + cfg.token }, signal: AbortSignal.timeout(15000) });
    if (!meta.ok) return null;
    const { url, mime_type } = await meta.json();
    if (!url || !/^image\/jpe?g$/.test(mime_type || '')) return null;
    const img = await fetch(url, { headers: { authorization:'Bearer ' + cfg.token }, signal: AbortSignal.timeout(20000) });
    if (!img.ok) return null;
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.length > 650000) return null;          // ticket photo cap is ~900k as base64
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  }

  /* ---------- inbound rate limit (protects the AI spend) ---------- */
  const recent = new Map();   // phone -> [timestamps]
  function overLimit(phone){
    const now = Date.now();
    const list = (recent.get(phone) || []).filter(t => now - t < 60e3);
    list.push(now);
    recent.set(phone, list);
    return list.length > 8;
  }

  /* ---------- helpers ---------- */
  const linkedUser = phone => {
    const l = db.prepare('SELECT emp_id FROM wa_links WHERE phone=?').get(phone);
    if (!l) return null;
    return db.prepare('SELECT * FROM users WHERE emp_id=? AND active=1').get(l.emp_id) || null;
  };
  const logIn = (wamid, phone, body, ticketId) =>
    db.prepare('INSERT INTO wa_messages (wamid,phone,direction,body,ticket_id,at) VALUES (?,?,?,?,?,?)')
      .run(wamid || null, phone, 'in', String(body || '').slice(0, 1000), ticketId || null, new Date().toISOString());

  function statusReply(u){
    const rows = db.prepare(
      "SELECT id,title,status,priority FROM tickets WHERE reporter=? AND status IN ('open','in_progress','resolved') ORDER BY created_at DESC LIMIT 5").all(u.emp_id);
    if (!rows.length) return 'You have no open tickets. Describe a problem in one message to raise one.';
    const lab = { open:'Open', in_progress:'In progress' };
    return 'Your tickets:\n' + rows.map(r =>
      `• ${r.id} (${r.priority}) — ${r.title}\n   ${r.status === 'resolved' ? 'Resolved ✔ (reply CLOSE ' + r.id.replace('LSO-','') + ' to confirm)' : lab[r.status]}`).join('\n');
  }

  const HELP = 'Lakeshore One on WhatsApp 🏥\n\nJust describe the problem in one message — what and where. You can attach a photo. AI files it to the right desk with the right priority.\n\nCommands:\nSTATUS — your open tickets\nCANCEL <no.> — withdraw a ticket you raised\nCLOSE <no.> — confirm a resolved ticket is fixed\nHELP — this message';

  /* ---------- the conversation ---------- */
  async function handleMessage(phone, msg){
    const wamid = msg.id;
    if (wamid && db.prepare('SELECT id FROM wa_messages WHERE wamid=?').get(wamid)) return;   // Meta retries webhooks

    let text = '', photo = null;
    if (msg.type === 'text') text = msg.text && msg.text.body || '';
    else if (msg.type === 'image'){
      text = (msg.image && msg.image.caption) || '';
      try{ photo = await fetchImage(msg.image.id); }catch(e){ /* photo optional */ }
    } else {
      logIn(wamid, phone, '[' + msg.type + ']');
      return sendText(phone, 'I can read text and photos only. Please describe the problem in a text message (a photo with a caption also works).');
    }
    logIn(wamid, phone, text || '[photo]');
    if (overLimit(phone)) return;   // silent drop beyond 8 msgs/min

    const u = linkedUser(phone);

    /* not linked yet → the message should be an employee ID */
    if (!u){
      const eid = text.trim().toUpperCase().replace(/\s+/g, '');
      const emp = /^[A-Z0-9-]{3,20}$/.test(eid) ? db.prepare('SELECT * FROM users WHERE emp_id=? AND active=1').get(eid) : null;
      if (emp){
        db.prepare('INSERT OR REPLACE INTO wa_links (phone,emp_id,linked_at) VALUES (?,?,?)')
          .run(phone, emp.emp_id, new Date().toISOString());
        audit(emp.emp_id, 'linked WhatsApp number ****' + phone.slice(-4));
        broadcast();
        return sendText(phone, `Welcome, ${emp.name} ✔\n\nThis number is now linked to ${emp.emp_id}. Describe any problem in one message (photo optional) and it becomes a ticket automatically.\n\nReply HELP for commands.`);
      }
      return sendText(phone, 'Welcome to Lakeshore One — the VPS Lakeshore service desk on WhatsApp.\n\nFirst, reply with your employee ID (e.g. LH-DOC01) to link this number. Ask IT if you don’t have one.');
    }

    const cmd = text.trim().toUpperCase();
    if (cmd === 'HELP' || cmd === 'HI' || cmd === 'HELLO') return sendText(phone, HELP);
    if (cmd === 'STATUS') return sendText(phone, statusReply(u));

    const mCancel = cmd.match(/^(CANCEL|CLOSE)\s+(?:LSO-)?(\d+)$/);
    if (mCancel){
      const id = 'LSO-' + mCancel[2];
      const r = applyOp({ kind:'status', ticket:id, to:'closed', text:'Closed by reporter via WhatsApp' }, u);
      if (r.ok){ broadcast(); notifyAgents(id); return sendText(phone, `${id} closed ✔`); }
      return sendText(phone, `Couldn't close ${id} — ${r.error}. Reply STATUS to see your tickets.`);
    }

    if (text.trim().length < 8 && !photo)
      return sendText(phone, 'Please describe the problem in a bit more detail — what is wrong and where (e.g. "AC leaking in ICU corridor near bed 7").');

    /* ---- triage: AI first, keyword fallback ---- */
    let tri;
    if (cfg.apiKey){
      try{ tri = await aiTriage(text || 'Photo attached, no caption.', !!photo, cfg); }
      catch(e){ console.error('AI triage failed, using fallback:', e.message); }
    }
    if (!tri) tri = heuristicTriage(text || 'photo report');

    const desc = (text ? text + '\n\n' : '') + '— reported via WhatsApp' + (tri.confidence === 'ai' ? ', AI-triaged' : ', keyword-triaged');
    const r = applyOp({ kind:'create', mod:tri.mod, type:tri.type, cat:tri.cat, title:tri.title,
      desc, zone:tri.zone, pri:tri.pri, impact:tri.impact, photo }, u);
    if (!r.ok) return sendText(phone, 'Sorry — the ticket could not be created (' + r.error + '). Please try again or use the app.');
    db.prepare('UPDATE wa_messages SET ticket_id=? WHERE wamid=?').run(r.id, wamid || '');
    broadcast();

    return sendText(phone,
      `✅ Ticket ${r.id} raised\n` +
      `${MOD_LABEL[tri.mod]} · ${tri.cat}\n` +
      `Priority ${tri.pri} — ${PRI_HINT[tri.pri]}\n` +
      `Zone: ${tri.zone}${tri.impact ? '\n⚠ Marked patient-care affected' : ''}\n\n` +
      `"${tri.title}"\n\n` +
      `You'll get updates here. STATUS = your tickets · CANCEL ${r.id.replace('LSO-','')} = withdraw.`);
  }

  /* placeholder for future agent-side pings (e.g. P1 alerts to on-call) */
  function notifyAgents(){ /* intentionally quiet in the pilot */ }

  /* ---------- webhook plumbing ---------- */
  function readRaw(req){
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', c => { data += c; if (data.length > 2e6) req.destroy(); });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }
  async function handleWebhook(req, res, url){
    if (req.method === 'GET'){   // Meta verification handshake
      if (url.searchParams.get('hub.mode') === 'subscribe' &&
          url.searchParams.get('hub.verify_token') === verifyToken){
        res.writeHead(200, { 'Content-Type':'text/plain' });
        return res.end(url.searchParams.get('hub.challenge') || '');
      }
      res.writeHead(403); return res.end('bad verify token');
    }
    if (req.method !== 'POST'){ res.writeHead(405); return res.end(); }

    const raw = await readRaw(req);
    if (cfg.appSecret){
      const sig = String(req.headers['x-hub-signature-256'] || '');
      const want = 'sha256=' + crypto.createHmac('sha256', cfg.appSecret).update(raw).digest('hex');
      const a = Buffer.from(sig), b = Buffer.from(want);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)){
        res.writeHead(401); return res.end('bad signature');
      }
    }
    /* always 200 fast — Meta retries aggressively on anything else */
    res.writeHead(200, { 'Content-Type':'application/json' });
    res.end('{"ok":true}');

    let payload; try{ payload = JSON.parse(raw); }catch(e){ return; }
    try{
      for (const entry of payload.entry || [])
        for (const change of entry.changes || []){
          const v = change.value || {};
          for (const msg of v.messages || []){
            const phone = String(msg.from || '').replace(/\D/g, '');
            if (!phone) continue;
            handleMessage(phone, msg).catch(e => console.error('wa handle error', e.message));
          }
          /* v.statuses = delivery receipts — ignored */
        }
    }catch(e){ console.error('wa webhook error', e.message); }
  }

  /* ---------- ticket-update notifications back to the reporter ---------- */
  const STATUS_TEXT = {
    in_progress: t => `🔧 ${t.id} is being worked on${t.assignee_name ? ' by ' + t.assignee_name : ''}.`,
    resolved:    t => `✅ ${t.id} marked resolved: "${t.title}"\n\nIf it's fixed, reply CLOSE ${t.id.replace('LSO-','')}. If not, tell an agent in the app or call the desk.`,
    closed:      t => `${t.id} closed. Thank you for reporting.`,
    open:        t => `↩ ${t.id} was reopened.`
  };
  function onOp(op, actor){
    if (!sendable) return;
    try{
      if (!['status','comment','assign'].includes(op.kind)) return;
      const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(String(op.ticket));
      if (!t || t.reporter === actor.emp_id) return;   // don't echo the reporter's own action
      const link = db.prepare('SELECT phone FROM wa_links WHERE emp_id=?').get(t.reporter);
      if (!link) return;
      let text = null;
      if (op.kind === 'status' && STATUS_TEXT[op.to]) text = STATUS_TEXT[op.to](t);
      else if (op.kind === 'assign') text = `👤 ${t.id} taken up by ${actor.name}.`;
      else if (op.kind === 'comment') text = `💬 ${actor.name} on ${t.id}: ${String(op.text || '').slice(0, 300)}`;
      if (text) sendText(link.phone, text).catch(() => {});
    }catch(e){ console.error('wa notify error', e.message); }
  }

  return { handleWebhook, onOp, enabled: sendable };
};
