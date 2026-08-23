# Lakeshore One — backend server

A **zero-dependency** Node.js backend: authentication, role-enforced API,
SQLite storage, live updates (SSE), and static serving of the frontend —
all in one file, nothing to `npm install`.

## Requirements

- Node.js **22.5 or newer** (uses the built-in `node:sqlite`)
- Nothing else. No npm packages, no external database.

## Run

```bash
node server/server.js               # http://localhost:8080
PORT=3000 node server/server.js     # custom port
```

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
  signed 12-hour bearer tokens, 5-attempts / 15-minute login throttle.
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
