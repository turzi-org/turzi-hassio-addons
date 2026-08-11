#!/bin/sh
# Turzi building relay, add-on flavor: options come from the HA add-on
# configuration (/data/options.json); state (credential, signing secret,
# certs) lives in the add-on's persistent /data, exactly like the
# standalone container's volume. Auto-provisions on first start with the
# single-use key from the TCM, then refreshes the bundle daily —
# renewed certificates arrive on their own.
set -eu

OPTS=/data/options.json
API_URL=$(jq -r '.api_url // empty' "$OPTS")
PROVISION_TOKEN=$(jq -r '.provision_token // empty' "$OPTS")
FRIGATE_UPSTREAM=$(jq -r '.frigate_upstream // "127.0.0.1:5000"' "$OPTS")
GO2RTC_UPSTREAM=$(jq -r '.go2rtc_upstream // "127.0.0.1:1984"' "$OPTS")
export FRIGATE_UPSTREAM GO2RTC_UPSTREAM

DATA=/data
BUNDLE_URL="${API_URL}/api/v2/edge/relay/bundle"

write_bundle() {
    jq -e '.cert and .streamSecret' "$1" > /dev/null || {
        echo "[relay] Bundle incomplete — has the cert been uploaded to the API?" >&2
        return 1
    }
    mkdir -p "$DATA/cert"
    jq -r '.streamSecret'    "$1" > "$DATA/secret"
    jq -r '.cert.fullchain'  "$1" > "$DATA/cert/fullchain.pem"
    jq -r '.cert.privkey'    "$1" > "$DATA/cert/privkey.pem"
    chmod 600 "$DATA/secret" "$DATA/cert/privkey.pem"
}

fetch_bundle() {
    curl -fsS "$BUNDLE_URL" -H "Authorization: Bearer $(cat "$DATA/credential")" \
        > /tmp/bundle.json && write_bundle /tmp/bundle.json
}

export CERT_DIR="$DATA/cert"
export STREAM_SECRET_FILE="$DATA/secret"

if [ ! -f "$DATA/credential" ]; then
    if [ -z "$API_URL" ] || [ -z "$PROVISION_TOKEN" ]; then
        echo "[relay] Not provisioned: set api_url and provision_token in the add-on configuration (key from the TCM: Integraciones → Medios del edificio)." >&2
        exit 1
    fi
    echo "[relay] Provisioning against $API_URL …"
    curl -fsS -X POST "$API_URL/api/v2/edge/relay/provision" \
        -H 'Content-Type: application/json' \
        -d "{\"token\":\"$PROVISION_TOKEN\"}" > /tmp/provision.json
    jq -r '.credential' /tmp/provision.json > "$DATA/credential"
    chmod 600 "$DATA/credential"
    write_bundle /tmp/provision.json
    rm -f /tmp/provision.json
    echo "[relay] Provisioned. The key in the add-on config is now spent (that's fine — the durable credential lives in /data)."
else
    fetch_bundle || echo "[relay] Bundle refresh failed; using stored state." >&2
fi

[ -f "$DATA/cert/fullchain.pem" ] || { echo "[relay] No cert available." >&2; exit 1; }

(
    while :; do
        sleep 86400
        if fetch_bundle; then
            kill -HUP "$(cat /tmp/nginx.pid)" 2>/dev/null || true
            echo "[relay] Bundle refreshed."
        else
            echo "[relay] Daily bundle refresh failed; keeping current state." >&2
        fi
    done
) &

envsubst '${FRIGATE_UPSTREAM} ${GO2RTC_UPSTREAM} ${CERT_DIR}' \
    < /etc/relay/nginx.conf.tmpl > /etc/relay/nginx.conf

exec /usr/local/openresty/bin/openresty -g 'daemon off;' -c /etc/relay/nginx.conf
