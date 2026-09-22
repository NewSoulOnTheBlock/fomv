#!/usr/bin/env bash
#
# Ship the follow server to a host, from a workstation.
#
# rsync rather than a git clone on the server. The repository is private, and a
# deploy key for it sitting on a machine that signs other people's trades buys
# convenience at the cost of widening what a compromise of that machine
# reaches. This way the server never holds a credential for anything but its
# own job.
#
# Only what the process runs is sent. The front end deploys separately, the
# Anchor program is not used at runtime, and the tests are not either.
#
#   deploy/push.sh root@host
set -euo pipefail

TARGET=${1:?usage: push.sh user@host}
APP_DIR=/opt/fomv/app
REPO_ROOT="$(cd "$(dirname "$0")"/.. && pwd)"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

log "Syncing source to $TARGET"
# --delete so a file removed from the repo is removed from the server, and the
# running code is always exactly a commit rather than a commit plus whatever
# was there before. The exclusions protect the two things the server owns.
rsync -az --delete \
  --exclude 'node_modules' \
  --exclude 'state' \
  --exclude '.env' \
  "$REPO_ROOT"/package.json \
  "$REPO_ROOT"/bun.lock \
  "$REPO_ROOT"/tsconfig.json \
  "$TARGET":"$APP_DIR"/

rsync -az --delete --exclude 'node_modules' \
  "$REPO_ROOT"/src/ "$TARGET":"$APP_DIR"/src/

log "Installing dependencies"
# --production: the server runs TypeScript through bun directly, so nothing
# here is built and the dev dependencies are never reached.
# rsync writes as the ssh user, so everything it lands arrives owned by root
# with the workstation's uid on the plain files. Claim the lot for the service
# account -- but never .env or state/, which the server owns and this script
# has no business touching.
ssh "$TARGET" "cd $APP_DIR && bun install --frozen-lockfile --production 2>&1 | tail -3 && \
  find $APP_DIR -mindepth 1 -maxdepth 1 ! -name .env ! -name state -exec chown -R fomv:fomv {} +"

log "Restarting, if it was already running"
# Started for the first time by hand after the environment is filled in; from
# then on a push restarts it. `is-active` keeps this script from starting a
# service that was deliberately stopped.
ssh "$TARGET" 'systemctl is-active --quiet fomv && systemctl restart fomv && echo "  restarted" || echo "  not running; start it with: systemctl start fomv"'

log "Done"
