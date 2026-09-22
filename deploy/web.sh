#!/usr/bin/env bash
#
# Put nginx and a certificate in front of FOMV.
#
# Run as root on the target, once, after a DNS A record for the host points
# here:  bash web.sh fomv.example.com
set -euo pipefail

HOST=${1:?usage: web.sh <host>}
SRC="$(dirname "$0")"/nginx-fomv.conf

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

log "Checking DNS"
# certbot's HTTP challenge needs this name to already resolve here. Failing now
# with a clear reason beats failing inside certbot with a rate limit attached.
RESOLVED=$(getent ahostsv4 "$HOST" | awk '{print $1}' | head -1 || true)
PUBLIC=$(curl -fsS --max-time 8 https://api.ipify.org || echo "?")
echo "  $HOST -> ${RESOLVED:-nothing}"
echo "  this host  -> $PUBLIC"
if [ -z "$RESOLVED" ]; then
  echo "  refusing: the name does not resolve yet. Add the A record and re-run." >&2
  exit 1
fi
if [ "$RESOLVED" != "$PUBLIC" ] && [ "$PUBLIC" != "?" ]; then
  echo "  refusing: it resolves elsewhere, so the challenge would fail." >&2
  exit 1
fi

log "Web root"
mkdir -p /opt/fomv/web
if [ ! -f /opt/fomv/web/index.html ]; then
  # A holding page, so the domain answers with something coherent between the
  # certificate being issued and the first front-end push.
  cat > /opt/fomv/web/index.html <<'HOLD'
<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>FOMV</title><meta name="robots" content="noindex">
<style>html{background:#0a0a0c;color:#8e8e96;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
body{margin:0;display:grid;place-items:center;min-height:100vh}</style>
</head><body><p>FOMV — not deployed yet.</p></body></html>
HOLD
fi
chown -R www-data:www-data /opt/fomv/web
chmod 755 /opt/fomv

log "nginx vhost"
sed "s/FOMV_HOST/$HOST/g" "$SRC" > /etc/nginx/sites-available/fomv
ln -sfn /etc/nginx/sites-available/fomv /etc/nginx/sites-enabled/fomv
# Ubuntu's catch-all answers on port 80 for any name, which means it can serve
# the certificate challenge from the wrong server block.
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

log "Certificate"
# www is included only when it already points here. Asking for a name that
# resolves elsewhere fails the challenge and spends an attempt against the
# rate limit, which is a poor way to discover a DNS record was never changed.
DOMAINS=(-d "$HOST")
WWW_RESOLVED=$(getent ahostsv4 "www.$HOST" | awk '{print $1}' | head -1 || true)
if [ "$WWW_RESOLVED" = "$PUBLIC" ]; then
  DOMAINS+=(-d "www.$HOST")
  echo "  including www.$HOST"
else
  echo "  skipping www.$HOST — it resolves to ${WWW_RESOLVED:-nothing}, not here"
fi

# --redirect: nothing should reach this over plain http. Every authenticated
# route carries a bearer token.
certbot --nginx "${DOMAINS[@]}" --redirect --agree-tos \
        --register-unsafely-without-email --non-interactive
systemctl reload nginx

log "Renewal"
# Proves it can renew, rather than discovering in ninety days that it cannot.
certbot renew --dry-run 2>&1 | tail -3

log "Done"
echo "  https://$HOST/            the site"
echo "  https://$HOST/api/health  the follow server, once it is started"
