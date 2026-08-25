# Lakeshore One — backend server

A **zero-dependency** Node.js backend: authentication, role-enforced API,
SQLite storage, live updates (SSE), and static serving of the frontend —
all in one file, nothing to `npm install`.

## Requirements

- Node.js **22.13 or newer** (uses the stabilized built-in `node:sqlite`;
  tested in CI on the current 22.x and 24.x lines). `node:sqlite` first
  appeared, behind a flag and still changing, in 22.5 — use a current release.
- Nothing else. No npm packages, no external database.

## Run

```bash
npm start                           # http://localhost:8080
PORT=3000 npm start                 # custom port
npm test                            # zero-dependency smoke test (spawns a throwaway DB)
```

`npm start` runs `node server/server.js` — run that directly if you skip npm.

The smoke test (`server/smoke-test.js`) starts the server on a temp database
and checks the security- and correctness-critical paths — patient-impact
priority escalation, idempotent-op dedup, OT/admin role guards, single-use SSE
ticket auth, and PIN-reset token invalidation. Run it before deploying.

Optional environment variables:

| Variable | Effect |
|---|---|
| `GOOGLE_CLIENT_ID` | Enables **Sign in with Google** on the login page. Create an OAuth *Web application* client in Google Cloud Console, add the site's origin (`https://opslakeshore.in`) to *Authorized JavaScript origins*, and set the client ID here. The server verifies the ID token against Google's public keys — no extra packages. |
| `GOOGLE_HOSTED_DOMAIN` | e.g. `lakeshorehospital.org` — Google sign-ins from this Workspace domain that don't match an existing account are auto-provisioned as `staff`. Any other verified Google account (e.g. a personal Gmail) that isn't linked to an account gets **guest access** instead — same limits as the Guest button, but with a persistent identity (`GV-…`), so they keep the same account and ticket history across sign-ins. Emails an admin has linked (user management → Google email) always sign in with that account's full role, whatever the domain. |
| `DEMO_LOGIN=1` | Enables the one-tap **Nurse (demo)** sign-in button. Leave unset in production. |

Guest and Patient one-tap sign-in is always available: it creates an ephemeral
limited account (`GST-…` / `PAT-…`) that can only raise facility, housekeeping
and security requests and track its own tickets — no bed board, OT list, queue
or dashboard data is ever sent to those sessions. Guest accounts that raised
no requests are purged automatically after 7 days.

## Tests

```bash
node --test server/server.test.js
```

Zero-dependency integration tests (built-in `node:test`) covering the
security-sensitive surface: guest/patient access limits, role-filtered state,
demo-nurse and Google SSO gating, email linking and uniqueness, guest cleanup.

On first run it creates `server/data/` containing:
- `lakeshore-one.db` — the SQLite database (WAL mode). **Back this file up.**
- `secret.key` — token-signing secret (mode 600)

Seeded accounts (PIN set on first sign-in): `LH-ADMIN` (admin — adds real
users), `LH-DOC01`, `LH-NUR01`, `LH-IT01`, `LH-FM01`, `LH-HK01`, `LH-BM01`,
`LH-SEC01`, `LH-MGT01`.

The frontend auto-detects the server (`/api/health`) — the same pages that
run in demo mode on GitHub Pages become the live multi-user system when
served by this process. Updates stream to all open sessions over SSE.

## What the server enforces (not the browser)

- Sign-in: employee ID + PIN (scrypt-hashed, never stored in plain text),
  signed 12-hour bearer tokens, 5-attempts / 15-minute login throttle. An
  admin PIN reset bumps a per-user token epoch, so any live session for that
  user is invalidated immediately.
- The live-update stream (SSE) authenticates with a short-lived, single-use
  ticket minted from the bearer token — the long-lived token never appears in
  a URL (and therefore never in access logs).
- The patient-care-affected rule (auto-raise to at least P2) is enforced here,
  not just in the browser.
- Every operation is role-checked server-side: staff can act only on their
  own tickets; agents only on their desk's queue; bed transitions follow the
  housekeeping lifecycle; OT milestones must advance in order; admin-only
  user management. State is role-filtered too — a doctor's session never
  receives other reporters' tickets.
- Every write lands in the audit table.

## Production deployment (hospital VPS)

Any small VPS works (1 vCPU / 1 GB is plenty — e.g. DigitalOcean Bangalore
or AWS Lightsail Mumbai to keep data in India).

**Quick way** — point a DNS A record (`opslakeshore.in`) at the
server's IP, then on a fresh Ubuntu 24.04 box:

```bash
curl -fsSL https://raw.githubusercontent.com/sameeraj89/lakeshore-one/main/server/deploy.sh -o deploy.sh
sudo bash deploy.sh opslakeshore.in
```

That installs Node 22 + Caddy, sets up the systemd service, HTTPS, and a
nightly backup to `/var/backups/lakeshore-one`. Re-run it any time to pull
updates.

To enable Google sign-in on the deployed service, put the env vars in
`/etc/lakeshore-one.env` — `deploy.sh` creates it once and never overwrites
it, so settings survive re-runs:

```bash
sudo nano /etc/lakeshore-one.env
# uncomment / set:
#   GOOGLE_CLIENT_ID=<client-id>.apps.googleusercontent.com
#   GOOGLE_HOSTED_DOMAIN=lakeshorehospital.org
sudo systemctl restart lakeshore-one
curl https://opslakeshore.in/api/config   # → should show your client ID
```

The equivalent manual steps:

```bash
# 1. Node 22+ (Ubuntu 24.04)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs

# 2. Get the code
git clone https://github.com/sameeraj89/lakeshore-one /opt/lakeshore-one

# 3. Run as a service (systemd)
sudo tee /etc/systemd/system/lakeshore-one.service > /dev/null <<'UNIT'
[Unit]
Description=Lakeshore One
After=network.target
[Service]
ExecStart=/usr/bin/node /opt/lakeshore-one/server/server.js
Environment=PORT=8080
EnvironmentFile=-/etc/lakeshore-one.env
Restart=always
User=www-data
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl enable --now lakeshore-one

# 4. HTTPS with Caddy (automatic certificates)
sudo apt install -y caddy
echo 'opslakeshore.in {
  reverse_proxy 127.0.0.1:8080
}' | sudo tee /etc/caddy/Caddyfile && sudo systemctl reload caddy

# 5. Let the service user write the database
sudo mkdir -p /opt/lakeshore-one/server/data
sudo chown -R www-data:www-data /opt/lakeshore-one/server/data
```

HTTPS is required for the PWA install prompt and the camera (QR) on phones.

Or with Docker: `docker build -t lakeshore-one . && docker run -d -p 8080:8080 -v lakeshore-data:/app/server/data lakeshore-one`

## Backups

Everything lives in `server/data/lakeshore-one.db`. A nightly cron copy is
enough for the pilot:
`sqlite3 server/data/lakeshore-one.db ".backup /backups/lakeshore-$(date +%F).db"`

## Scale-up path

- `docs/schema.sql` is the equivalent PostgreSQL schema when the hospital
  wants a managed database; the API surface stays the same.
- Replace `/api/login` with AD / SSO (OIDC) when IT is ready — tokens, roles
  and every other route are unchanged.
- **WhatsApp intake with AI triage is built in** — staff report incidents by
  texting the hospital's WhatsApp number, and get ticket updates back there.
  Setup guide: `server/WHATSAPP.md`. Web push remains a natural follow-on at
  the same `applyOp()` hook.

## Alternative: run it on a PC inside the hospital (₹0)

Any always-on machine on the hospital network can host this — an old desktop,
an Intel N100 mini-PC (~6 W), or a Raspberry Pi 5. The server idles at ~50 MB
RAM. Requirements: UPS-backed power, auto-start on boot, a reserved LAN IP.

**Linux box:** follow the VPS guide from step "Node 22", skip Caddy/DNS; staff
use `http://<lan-ip>:8080` on hospital Wi-Fi.

**Windows box:**
1. Install Node.js 22 LTS from nodejs.org.
2. Download this repo (Code → Download ZIP) and extract, e.g. to `C:\lakeshore-one`.
3. Test: `node C:\lakeshore-one\server\server.js` → open `http://localhost:8080`.
4. Auto-start: Task Scheduler → Create Task → trigger "At startup" →
   action `node.exe` with argument `C:\lakeshore-one\server\server.js`
   (or install NSSM to run it as a proper Windows service).
5. Reserve the machine's IP in the router/DHCP so the address never changes.

**Known limitation on plain LAN HTTP:** browsers only offer the full PWA
install over HTTPS, so staff get a home-screen shortcut instead of the
installed-app experience. Fixes: Tailscale HTTPS (per-device), or internal
DNS + internal CA certificates from hospital IT. Data never leaves the
building, and the system keeps working if the internet link drops.

**Moving between PC and VPS later:** install Node on the new machine and copy
`server/data/` across. That's the entire migration.

**Mac mini (Apple Silicon):** excellent always-on host if one is available.
1. Install Node 22 LTS (nodejs.org) and clone the repo to `/Users/Shared/lakeshore-one`.
2. Create `/Library/LaunchDaemons/in.lakeshore.one.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>in.lakeshore.one</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/node</string>
         <string>/Users/Shared/lakeshore-one/server/server.js</string></array>
  <key>EnvironmentVariables</key><dict><key>PORT</key><string>8080</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```
   Then: `sudo launchctl load -w /Library/LaunchDaemons/in.lakeshore.one.plist`
   (check the node path with `which node` — Homebrew installs to /opt/homebrew/bin/node).
3. Server-ify the Mac: Energy settings → prevent sleep + start after power
   failure; disable FileVault (or enable auto-login) so it boots unattended;
   defer automatic macOS restarts; reserve its IP in the router.
