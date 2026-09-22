#!/usr/bin/env bash
#
# Put nginx and a certificate in front of the follow server.
#
# Run as root on the target, once, after a DNS A record for the host points
# here:  bash web.sh api.example.com
#
# TLS is not optional dressing. The front end is served from an https origin
# and a browser refuses a plain-http request from one as mixed content, so the
# API is unreachable from the product until this runs.
set -euo pipefail

API_HOST=${1:?usage: web.sh <api-host>}
SRC="$(dirname "$0")"/nginx-fomv-api.conf

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

log "Checking DNS"
# certbot's HTTP challenge needs this host to already resolve here. Failing now
# with a clear reason beats failing inside certbot with a rate limit attached.
RESOLVED=$(getent ahostsv4 "$API_HOST" | awk '{print $1}' | head -1 || true)
PUBLIC=$(curl -fsS --max-time 8 https://api.ipify.org || echo "?")
echo "  $API_HOST -> ${RESOLVED:-nothing}"
echo "  this host  -> $PUBLIC"
if [ -z "$RESOLVED" ]; then
  echo "  refusing: the name does not resolve yet. Add the A record and re-run." >&2
  exit 1
fi
if [ "$RESOLVED" != "$PUBLIC" ] && [ "$PUBLIC" != "?" ]; then
  echo "  warning: it resolves somewhere else. The certificate challenge will fail." >&2
fi

log "nginx vhost"
sed "s/FOMV_API_HOST/$API_HOST/g" "$SRC" > /etc/nginx/sites-available/fomv-api
ln -sfn /etc/nginx/sites-available/fomv-api /etc/nginx/sites-enabled/fomv-api
# Ubuntu ships a catch-all that answers on port 80 for any name. Leaving it
# enabled means the certificate challenge can be served by the wrong vhost.
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

log "Certificate"
# --redirect so http is permanently sent to https. Nothing should ever reach
# this API unencrypted: every authenticated route carries a bearer token.
certbot --nginx -d "$API_HOST" --redirect --agree-tos --register-unsafely-without-email --non-interactive
systemctl reload nginx

log "Renewal"
# Certbot installs a timer; this proves it can actually renew rather than
# discovering in ninety days that it cannot.
systemctl list-timers --no-pager 2>/dev/null | grep -i certbot || true
certbot renew --dry-run 2>&1 | tail -3

log "Done"
echo "  https://$API_HOST/health should answer once the service is started."
