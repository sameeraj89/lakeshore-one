# WhatsApp intake — setup guide

Staff message the hospital's WhatsApp number in plain language (English,
Malayalam or Manglish, photo optional). AI triage classifies the message into
the correct desk, category, ITIL priority, campus zone and patient-impact
flag, and files it as a normal Lakeshore One ticket. Ticket updates flow back
to the reporter on WhatsApp.

Try the flow first: the **`whatsapp/`** page in this repo is a browser
simulator of the whole conversation — good for showing management before any
Meta setup.

## How it works

```
Staff phone ──▶ Meta WhatsApp Cloud API ──▶ POST /api/whatsapp/webhook
                                                 │
                              AI triage (Claude API; keyword fallback)
                                                 │
                              applyOp('create') — same role-checked path
                              as the app; SLA clock, audit trail, SSE
                                                 │
Agent works the ticket in Lakeshore One ──▶ reporter notified on WhatsApp
```

- **Identity**: the first message from an unknown number must be an employee
  ID (as provisioned by the admin). The number is then linked — every later
  report is filed under that user, exactly as if they used the app.
  Links are stored in the `wa_links` table; the audit trail records linking.
- **Triage**: with `ANTHROPIC_API_KEY` set, Claude reads the message
  (any language, typos and all) and returns a classification constrained to
  the real taxonomy — the code clamps every field, so a bad answer can never
  create a malformed ticket. Patient impact always forces at least P2.
  Without a key, a keyword classifier still routes sensibly.
- **Photos**: a JPEG image with a caption becomes ticket photo evidence
  (same 900 KB cap as the app).
- **Commands**: `STATUS` (my tickets), `CANCEL <no.>` (withdraw),
  `CLOSE <no.>` (confirm a resolved fix), `HELP`.
- **Safety rails**: webhook signature verification (`X-Hub-Signature-256`),
  webhook dedup by WhatsApp message ID (Meta retries), 8 messages/minute
  per number rate limit, always-200 responses so Meta never retry-storms.

## Setup (about 30 minutes)

### 1. Meta / WhatsApp Cloud API

1. Create a Meta Business Portfolio at business.facebook.com (hospital name).
2. At developers.facebook.com create an **App** → type *Business* → add the
   **WhatsApp** product.
3. You get a **test number** immediately — good for the pilot (up to 5
   recipient numbers). For production, add a real phone number the hospital
   owns (a number NOT currently registered on the WhatsApp app) and complete
   business verification.
4. Note two values from *WhatsApp → API setup*:
   - **Phone number ID** → `WHATSAPP_PHONE_ID`
   - a **permanent access token** → `WHATSAPP_TOKEN`
     (create a System User in Business Settings → assign the app →
     generate token with `whatsapp_business_messaging` permission;
     the token shown on the API-setup page expires in 24 h — don't use it)
5. From *App settings → Basic*, copy the **App secret** → `WHATSAPP_APP_SECRET`.

### 2. Point the webhook at the server

The server must be reachable over HTTPS (the Caddy setup from
`server/README.md` already is).

1. Start the server once — it prints the verify token it generated
   (or set your own via `WHATSAPP_VERIFY_TOKEN`).
2. In the Meta app: *WhatsApp → Configuration → Webhook* →
   - Callback URL: `https://ops.yourdomain.in/api/whatsapp/webhook`
   - Verify token: the value from step 1
   - Click *Verify and save*, then **subscribe to the `messages` field**.

### 3. Environment

```bash
WHATSAPP_TOKEN=EAAG…            # permanent system-user token
WHATSAPP_PHONE_ID=1234567890
WHATSAPP_APP_SECRET=abc…        # enables signature verification (recommended)
WHATSAPP_VERIFY_TOKEN=…         # optional; auto-generated otherwise
ANTHROPIC_API_KEY=sk-ant-…      # enables AI triage (console.anthropic.com)
ANTHROPIC_MODEL=claude-opus-5   # optional override
```

With systemd, add them to the unit:

```ini
[Service]
Environment=WHATSAPP_TOKEN=…
Environment=WHATSAPP_PHONE_ID=…
Environment=WHATSAPP_APP_SECRET=…
Environment=ANTHROPIC_API_KEY=…
```

then `sudo systemctl daemon-reload && sudo systemctl restart lakeshore-one`.

### 4. Test

From a phone added as a test recipient: message the number → you're asked
for your employee ID → send it → send *"AC leaking in ICU corridor near
bed 7"* → the ticket appears in the Facility queue in Lakeshore One within
seconds, and the confirmation lands back on WhatsApp.

## Costs (pilot scale)

- **WhatsApp**: since July 2025 Meta prices per *template* message, not per
  conversation. Everything this integration sends inside the 24-hour
  customer-service window that a staff message opens (confirmations, status
  updates, replies) is **free**. Reporters re-open the window every time
  they message.
- **AI triage**: one Claude call per report — fractions of a rupee per
  ticket at pilot volumes.

## Known limits (honest list)

- **The 24-hour window**: a status update sent more than 24 h after the
  reporter's last message is rejected by Meta. Fix when it matters: create a
  pre-approved *utility template* (e.g. `ticket_update`) in WhatsApp Manager
  and send that instead — hook point is `sendText()` in `server/whatsapp.js`.
  At hospital SLA speeds (P1–P3 resolve within 24 h) this rarely triggers.
- **Voice notes** are declined with a polite ask for text. Adding
  transcription is a natural v2 (audio download + a transcription API).
- **One number per employee, one employee per number** — re-linking simply
  overwrites (`INSERT OR REPLACE`). An admin PIN-reset does not unlink.
- **The demo page** (`whatsapp/`) uses the keyword classifier in the
  browser; the server uses Claude when a key is configured. Wording of
  replies is kept identical so the demo is faithful.
