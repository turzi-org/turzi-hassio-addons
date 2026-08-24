#!/bin/sh
# Turzi external system API, add-on flavor.
#
# Options come from the HA add-on configuration (/data/options.json). The
# Home Assistant connection and the database credentials do NOT: both come from
# the Supervisor. Copying a password into a second add-on's options would work
# exactly once and then never be rotated again.
set -eu

# Standalone mode: no Supervisor, so the environment is already complete (a
# plain `docker run` or the compose file). One image, one entrypoint, two
# deployments — the alternative is two Dockerfiles that drift.
if [ -z "${SUPERVISOR_TOKEN:-}" ] || [ ! -f /data/options.json ]; then
    echo "[external-api] No Supervisor detected — using the environment as given."
    exec node /app/dist/index.js
fi

OPTS=/data/options.json
SUP="http://supervisor"
AUTH="Authorization: Bearer ${SUPERVISOR_TOKEN}"

# Check the file before reading options out of it. Every per-option error below
# assumes jq failed because the option is missing; if jq actually failed because
# the file was unreadable or malformed, that assumption turns one root cause
# into a confident, wrong message about whichever option happened to be read
# first. Diagnose the file loudly here, so the messages after it can be trusted.
if [ ! -r "$OPTS" ]; then
    echo "[external-api] Cannot read $OPTS" >&2
    ls -l "$OPTS" >&2 2>/dev/null || echo "[external-api]   (it does not exist)" >&2
    echo "[external-api]   Running as uid $(id -u); the Supervisor writes this file as root." >&2
    exit 1
fi
if ! jq -e . "$OPTS" >/dev/null 2>&1; then
    echo "[external-api] $OPTS is not valid JSON:" >&2
    jq . "$OPTS" >/dev/null || true
    exit 1
fi

need() {
    # jq -e makes an absent or null value an error rather than the string
    # "null" silently becoming a hostname.
    jq -er "$2" "$OPTS" 2>/dev/null || {
        echo "[external-api] Missing required option: $1" >&2
        exit 1
    }
}

# Trimmed, not just checked for emptiness. A pasted id with a stray space
# would otherwise be accepted verbatim and produce topics like
# "house/ abc /state/#" — which subscribe cleanly, match nothing, and leave the
# add-on reporting zero entities with no error anywhere. Silent is the worst
# failure mode for the one option nobody can guess.
TURZI_HOUSE_ID=$(jq -er '.house_id | select(type == "string") | gsub("^\\s+|\\s+$"; "") | select(. != "")' "$OPTS" 2>/dev/null) || {
    echo "[external-api] Missing required option: house_id" >&2
    echo "[external-api]   It is the topic namespace the Turzi bridge was enrolled with." >&2
    echo "[external-api]   Find it in Settings > Devices & Services > turzi Bridge: the entry" >&2
    echo "[external-api]   is titled 'turzi Bridge for Home Assistant - <house_id>'." >&2
    exit 1
}
API_KEYS=$(need api_keys '.api_keys | select(length > 0) | join(",")')
ALLOWED_ENTITIES=$(jq -r '.allowed_entities // [] | join(",")' "$OPTS")
ALLOWED_DOMAINS=$(jq -r '.allowed_domains // [] | join(",")' "$OPTS")
COMMAND_CONFIRM_TIMEOUT_MS=$(jq -r '.confirm_timeout_ms // 4000' "$OPTS")
LOG_REQUESTS=$(jq -r '.log_requests // false' "$OPTS")
DB_NAME=$(jq -r '.database // "turzi_external_api"' "$OPTS")
DB_URL_OVERRIDE=$(jq -r '.db_url // ""' "$OPTS")

if [ -z "$ALLOWED_ENTITIES" ]; then
    echo "[external-api] WARNING: allowed_entities is empty — this key can reach EVERY entity the bridge exposes." >&2
fi

service() {
    curl -fsS -H "$AUTH" "$SUP/services/$1" 2>/dev/null || {
        echo "[external-api] Supervisor has no '$1' service. Is the $2 add-on installed and started?" >&2
        exit 1
    }
}

# --- Home Assistant ------------------------------------------------------
# The Supervisor proxies Home Assistant's WebSocket API and accepts the add-on
# token for it, so there is nothing to configure and no long-lived token to
# create, store or rotate. Requires `homeassistant_api: true` in config.yaml.
HA_WS_URL="ws://supervisor/core/websocket"
HA_TOKEN="${SUPERVISOR_TOKEN}"

# --- Database, from the MariaDB add-on -----------------------------------
if [ -n "$DB_URL_OVERRIDE" ]; then
    DATABASE_URL="$DB_URL_OVERRIDE"
else
    SQL=$(service mysql MariaDB)
    # @uri percent-encodes: the MariaDB add-on generates passwords that can
    # contain characters a URI would otherwise read as structure.
    SQL_HOST=$(echo "$SQL" | jq -r '.data.host')
    SQL_PORT=$(echo "$SQL" | jq -r '.data.port')
    SQL_USER=$(echo "$SQL" | jq -r '.data.username | @uri')
    SQL_PASS=$(echo "$SQL" | jq -r '.data.password | @uri')
    DATABASE_URL="mysql://${SQL_USER}:${SQL_PASS}@${SQL_HOST}:${SQL_PORT}/${DB_NAME}"
fi

export TURZI_HOUSE_ID API_KEYS ALLOWED_ENTITIES ALLOWED_DOMAINS \
       COMMAND_CONFIRM_TIMEOUT_MS LOG_REQUESTS DATABASE_URL \
       HA_WS_URL HA_TOKEN
export PORT=8080

echo "[external-api] site=${TURZI_HOUSE_ID} home-assistant=supervisor-proxy db=${DB_NAME}"
exec node /app/dist/index.js
