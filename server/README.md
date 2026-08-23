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

On first run it creates `server/data/` containing:
- `lakeshore-one.db` — the SQLite database (WAL mode). **Back this file up.**
- `secret.key` — token-signing secret (mode 600)

Seeded accounts (PIN set on first sign-in): `LH-ADMIN` (admin — adds real
users), `LH-DOC01`, `LH-IT01`, `LH-FM01`, `LH-HK01`, `LH-BM01`, `LH-SEC01`,
`LH-MGT01`.

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

Any small VPS works (1 vCPU / 1 GB is plenty). Recommended setup:

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
Restart=always
User=www-data
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl enable --now lakeshore-one

# 4. HTTPS with Caddy (automatic certificates)
sudo apt install -y caddy
echo 'ops.yourdomain.in {
  reverse_proxy 127.0.0.1:8080
}' | sudo tee /etc/Caddyfile && sudo systemctl reload caddy
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
- Notifications (WhatsApp / web push) hook naturally into `applyOp()` where
  `broadcast()` is called.

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
