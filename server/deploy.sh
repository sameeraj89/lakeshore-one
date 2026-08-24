#!/usr/bin/env bash
# Lakeshore One — one-shot VPS deploy (Ubuntu 24.04, run as root).
#
#   sudo bash deploy.sh ops.yourdomain.in
#
# Prerequisite: a DNS A record for that domain already pointing at this
# machine's public IP (Caddy needs it to obtain the HTTPS certificate).
#
# What it does: installs Node 22 + Caddy, clones/updates this repo into
# /opt/lakeshore-one, runs the server as a systemd service under www-data,
# puts Caddy in front for automatic HTTPS, and adds a nightly SQLite backup
# to /var/backups/lakeshore-one. Safe to re-run — reuse it to pull updates.
set -euo pipefail

DOMAIN="${1:?Usage: sudo bash deploy.sh <domain>   (DNS A record must already point at this server)}"
REPO="https://github.com/sameeraj89/lakeshore-one"
DIR=/opt/lakeshore-one

[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash deploy.sh $DOMAIN"; exit 1; }

echo "==> Installing packages (git, caddy, sqlite3)"
apt-get update -q
DEBIAN_FRONTEND=noninteractive apt-get install -yq ca-certificates curl git caddy sqlite3

echo "==> Ensuring Node.js >= 22.5 (needed for built-in node:sqlite)"
if ! command -v node >/dev/null 2>&1 || \
   ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -yq nodejs
fi
node --version

echo "==> Fetching the code into $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone "$REPO" "$DIR"
fi
mkdir -p "$DIR/server/data"
chown -R www-data:www-data "$DIR/server/data"

echo "==> Server settings file (survives re-runs of this script)"
if [ ! -f /etc/lakeshore-one.env ]; then
  cat > /etc/lakeshore-one.env <<'ENV'
# Lakeshore One server settings — edit, then: systemctl restart lakeshore-one
# Google SSO: OAuth web client ID (leave empty to hide the Google button)
#GOOGLE_CLIENT_ID=
# Auto-provision staff for this Workspace domain (optional)
#GOOGLE_HOSTED_DOMAIN=
# One-tap demo nurse sign-in — never enable on a production instance
#DEMO_LOGIN=1
ENV
  chmod 600 /etc/lakeshore-one.env
fi

echo "==> Installing systemd service"
cat > /etc/systemd/system/lakeshore-one.service <<UNIT
[Unit]
Description=Lakeshore One
After=network.target

[Service]
ExecStart=/usr/bin/node $DIR/server/server.js
Environment=PORT=8080
EnvironmentFile=-/etc/lakeshore-one.env
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now lakeshore-one
systemctl restart lakeshore-one

echo "==> Configuring Caddy for https://$DOMAIN"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	reverse_proxy 127.0.0.1:8080
}
CADDY
systemctl enable --now caddy
systemctl reload caddy

echo "==> Nightly database backup -> /var/backups/lakeshore-one (kept 30 days)"
mkdir -p /var/backups/lakeshore-one
cat > /etc/cron.daily/lakeshore-one-backup <<'CRON'
#!/bin/sh
sqlite3 /opt/lakeshore-one/server/data/lakeshore-one.db \
  ".backup /var/backups/lakeshore-one/lakeshore-$(date +%F).db"
find /var/backups/lakeshore-one -name 'lakeshore-*.db' -mtime +30 -delete
CRON
chmod +x /etc/cron.daily/lakeshore-one-backup

echo "==> Checking health"
sleep 2
curl -fsS http://127.0.0.1:8080/api/health && echo
echo
echo "Done. Once DNS has propagated, open:  https://$DOMAIN"
echo "First sign-in: LH-ADMIN (you set the PIN on first login, then add real users)."
echo "Google SSO / demo settings: edit /etc/lakeshore-one.env, then: systemctl restart lakeshore-one"
echo "Certificate errors in the first minute are normal while Caddy provisions HTTPS."
