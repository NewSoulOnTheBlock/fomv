#!/usr/bin/env bash
#
# Prepare a fresh Ubuntu box to run the FOMV follow server.
#
# Idempotent: safe to re-run after a change, and re-running is how the unit
# gets updated. It installs the runtime, the service account and the web front,
# and it deliberately does *not* start anything -- the process refuses to boot
# without four secrets that only the operator has, and a unit that crash-loops
# on a missing variable is worse than one that was never started.
#
# Run as root on the target:  bash install.sh
set -euo pipefail

APP_USER=fomv
APP_DIR=/opt/fomv/app

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

log "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# nginx and certbot terminate TLS; the app is never exposed directly. rsync is
# how code arrives, because the repository is private and putting a deploy key
# for it on a trading server buys nothing.
apt-get install -y -qq --no-install-recommends \
  nginx certbot python3-certbot-nginx ufw curl unzip rsync ca-certificates

log "Bun"
# System-wide rather than per-user: the service account has no login shell, so
# a bun living in its home directory would be awkward to update and invisible
# to anyone debugging over ssh.
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
fi
bun --version

log "Service account"
# A system user with no shell and no password. The process signs swaps on other
# people's wallets; it should not be able to log in anywhere.
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /opt/"$APP_USER" \
          --shell /usr/sbin/nologin "$APP_USER"
fi

log "Directories"
mkdir -p "$APP_DIR"/state
# The database is the one thing here that cannot be rebuilt from the repo: it
# holds who consented, where each cursor reached, and what is owed.
chown -R "$APP_USER":"$APP_USER" /opt/"$APP_USER"
chmod 750 /opt/"$APP_USER"

log "Environment file"
if [ ! -f "$APP_DIR"/.env ]; then
  install -o "$APP_USER" -g "$APP_USER" -m 600 /dev/null "$APP_DIR"/.env
  cat > "$APP_DIR"/.env <<'ENVEOF'
# FOMV follow server. Filled by the operator; never committed, never synced.
#
# The four below have no safe default and the process exits at start without
# them. Everything else has one.

# A real provider. Free endpoints are not sufficient and the system says so
# rather than degrading: api.mainnet-beta refuses batched transaction reads and
# publicnode refuses the indexed methods the safety checks need.
SOLANA_RPC_URL=
PRIVY_APP_ID=
PRIVY_APP_SECRET=
FOMV_TREASURY=

# Signs delegated transactions. Without it Privy will not act on the server's
# behalf, so the mirror loop plans trades and never lands one.
PRIVY_AUTHORIZATION_PRIVATE_KEY=

# Archival history is the expensive half; point it somewhere separate if the
# main endpoint is metered differently.
SOLANA_TX_RPC_URL=

# Explicit, never "*": these endpoints carry a bearer token and a wildcard
# would let any page spend a user's session.
FOMV_ALLOWED_ORIGINS=

# Guards the trader-listing inbox. Absent means the endpoint is not served at
# all rather than served openly. Generate with: openssl rand -hex 32
FOMV_ADMIN_TOKEN=

# Better candle coverage than the keyless default. Optional.
BIRDEYE_API_KEY=

FOMV_DB_PATH=/opt/fomv/app/state/follow.sqlite
PORT=8080
FOMV_POLL_INTERVAL_SEC=10

# Dry-run quotes, plans and prints exactly what it would have done, and signs
# nothing. Leave it here until a full day of cycle logs has been read.
MODE=dry-run
ENVEOF
  chown "$APP_USER":"$APP_USER" "$APP_DIR"/.env
  chmod 600 "$APP_DIR"/.env
  echo "  created $APP_DIR/.env — fill it in before starting"
else
  echo "  $APP_DIR/.env exists, left alone"
fi

log "Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
# The app listens on loopback's 8080 through nginx; nothing should reach it
# from outside.
ufw --force enable >/dev/null
ufw status | head -8

log "systemd unit"
install -m 644 "$(dirname "$0")"/fomv.service /etc/systemd/system/fomv.service
systemctl daemon-reload
systemctl enable fomv.service >/dev/null
echo "  enabled (not started)"

log "Done"
cat <<'NEXT'
  Next, in order:
    1. Fill /opt/fomv/app/.env
    2. Sync the code            (deploy/push.sh from a workstation)
    3. Point a DNS A record at this host
    4. bash deploy/web.sh <api-host>   — nginx vhost and a certificate
    5. systemctl start fomv && journalctl -fu fomv
NEXT
