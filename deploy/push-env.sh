#!/usr/bin/env bash
#
# Copy the server's share of a local .env to the host.
#
#   deploy/push-env.sh root@host [source]     (source defaults to ./.env)
#
# # What it does and does not send
#
# Only the keys the follow server reads. `VITE_*` are build-time values for the
# front end and have no meaning on the server; sending them would put the
# browser's configuration on a machine that signs trades, for no reason.
#
# `PRIVY_APP_ID` is derived from `VITE_PRIVY_APP_ID` when it is absent. They are
# the same value -- Privy issues one app id and the prefix only decides whether
# Vite inlines it -- and a file that has the client name but not the server one
# is the ordinary state of a project that built the front end first.
#
# # Why it merges rather than overwrites
#
# The server owns values the workstation has never seen: `FOMV_ADMIN_TOKEN` was
# generated on the box and has never left it. Overwriting the file would
# silently rotate it and lock the operator out of their own inbox.
#
# Values travel over ssh stdin, never as arguments. An argument is visible in
# the process list to every user on both machines for as long as the command
# runs.
set -euo pipefail

TARGET=${1:?usage: push-env.sh user@host [source-env]}
SRC=${2:-"$(cd "$(dirname "$0")"/.. && pwd)/.env"}
REMOTE=/opt/fomv/app/.env

[ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 1; }

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# The keys the server actually reads. Anything else in the source is ignored.
# One line: BSD awk rejects a newline inside a -v assignment, and this script
# has to run on the machine the developer is sitting at.
SERVER_KEYS="SOLANA_RPC_URL SOLANA_TX_RPC_URL PRIVY_APP_ID PRIVY_APP_SECRET PRIVY_AUTHORIZATION_PRIVATE_KEY FOMV_TREASURY FOMV_ALLOWED_ORIGINS FOMV_ADMIN_TOKEN FOMV_TRADE_FEE_BPS FOMV_LEADER_SHARE_BPS FOMV_DB_PATH FOMV_POLL_INTERVAL_SEC FOMV_PRICE_FEED BIRDEYE_API_KEY PORT MODE"

log "Selecting"
# Last occurrence wins, matching how a shell would source the file, so a
# duplicated key does not send the stale copy.
PAYLOAD=$(
  awk -v keys="$SERVER_KEYS" '
    BEGIN { n = split(keys, a, / +/); for (i = 1; i <= n; i++) if (a[i] != "") want[a[i]] = 1 }
    /^[A-Za-z_][A-Za-z0-9_]*=/ {
      eq = index($0, "="); k = substr($0, 1, eq - 1); v = substr($0, eq + 1)
      if (v == "") next
      if (k in want) { val[k] = v; next }
      # The server has no use for the browser app id under its own name, but it
      # does need the same value under the unprefixed one.
      if (k == "VITE_PRIVY_APP_ID") vite_app_id = v
    }
    END {
      if (!("PRIVY_APP_ID" in val) && vite_app_id != "") val["PRIVY_APP_ID"] = vite_app_id
      for (k in val) print k "=" val[k]
    }
  ' "$SRC"
)

[ -n "$PAYLOAD" ] || { echo "  nothing to send" >&2; exit 1; }
printf '%s\n' "$PAYLOAD" | cut -d= -f1 | sort | sed 's/^/  /'

log "Applying on $TARGET"
# The merge script is copied first and the values are piped afterwards. Doing
# both with one ssh invocation does not work: a heredoc and a pipe compete for
# the same stdin, the heredoc wins, and the remote python reads its own source
# where it expected the data -- applying nothing and reporting success.
scp -q "$(dirname "$0")"/merge-env.py "$TARGET":/root/fomv-deploy/merge-env.py
printf '%s\n' "$PAYLOAD" | ssh "$TARGET" "python3 /root/fomv-deploy/merge-env.py $REMOTE"

ssh "$TARGET" "chown fomv:fomv $REMOTE && chmod 600 $REMOTE"

log "Still empty on the server"
ssh "$TARGET" "grep -E '^[A-Z_]+=\$' $REMOTE | cut -d= -f1 | sed 's/^/  /' || echo '  (none)'"
