#!/usr/bin/env bash
#
# Build the front end and ship it.
#
#   deploy/push-web.sh root@host
#
# Built here rather than on the server. The build needs the dev dependencies,
# a few hundred megabytes of them, and installing that on a box whose job is to
# hold RPC connections and sign trades is a poor trade for a directory of
# static files that can be produced anywhere.
set -euo pipefail

TARGET=${1:?usage: push-web.sh user@host}
REPO_ROOT="$(cd "$(dirname "$0")"/.. && pwd)"
WEB_ROOT=/opt/fomv/web

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

log "Regenerating site data"
# The roster and every audit are static JSON read at runtime. Building without
# this ships whatever was in the working tree, which is how a stale audit gets
# published without anyone deciding to.
( cd "$REPO_ROOT" && bun run build:appdata )

log "Checking build-time configuration"
# Vite inlines VITE_* at build time. There is no runtime configuration to fix
# afterwards: a build made without an app id ships a site where sign-in is
# permanently dead, and it looks exactly like a working one until somebody
# tries to click it. Vite reads app/.env.production automatically; this only
# says out loud what is missing from it.
ENV_FILE="$REPO_ROOT"/app/.env.production
MISSING=()
for v in VITE_PRIVY_APP_ID VITE_PRIVY_SIGNER_ID VITE_CALENDLY_URL; do
  if ! grep -qE "^$v=.+" "$ENV_FILE" 2>/dev/null; then MISSING+=("$v"); fi
done
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "  not set in app/.env.production:"
  for v in "${MISSING[@]}"; do
    case "$v" in
      VITE_PRIVY_APP_ID)    echo "    $v      — sign-in will be unavailable" ;;
      VITE_PRIVY_SIGNER_ID) echo "    $v   — nobody can authorise trade signing" ;;
      VITE_CALENDLY_URL)    echo "    $v     — the apply funnel ends without a calendar" ;;
    esac
  done
  echo "  building anyway; the site works, those parts will not."
else
  echo "  all set"
fi

log "Building"
# Same origin as the API, so the front end calls /api and there is no CORS,
# no preflight and no second host to keep in step. Set on the command line so
# it wins over anything in .env.production -- the origin is decided by where
# this is being deployed, not by a file.
( cd "$REPO_ROOT"/app && VITE_FOMV_API=/api bun run build )

log "Syncing to $TARGET"
# --delete, so a file that left the build leaves the server. Vite's output is
# content-hashed, and without this every old bundle accumulates for ever.
rsync -az --delete "$REPO_ROOT"/app/dist/ "$TARGET":"$WEB_ROOT"/
ssh "$TARGET" "chown -R www-data:www-data $WEB_ROOT"

log "Done"
