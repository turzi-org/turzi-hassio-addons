#!/bin/sh
# Turzi external system API, add-on flavor.
#
# Options come from the HA add-on configuration (/data/options.json). Broker
# and database credentials do NOT: they are fetched from the Supervisor, which
# is why config.yaml declares `mqtt:need` and `mysql:need`. Copying a Mosquitto
# password into a second add-on's options would work exactly once and then
# never be rotated again.
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

# --- MQTT ----------------------------------------------------------------
# Normally the Mosquitto add-on, discovered through the Supervisor. But the
# add-on has to reach whichever broker the BRIDGE publishes to, and that is not
# always this machine: a building can be enrolled against a cloud broker, in
# which case a co-located Mosquitto is simply the wrong broker and the add-on
# would sit connected to it seeing nothing forever.
MQTT_HOST=$(jq -r '.mqtt_host // ""' "$OPTS")
if [ -n "$MQTT_HOST" ]; then
    MQTT_TLS=$(jq -r 'if .mqtt_tls then "true" else "false" end' "$OPTS")
    if [ "$MQTT_TLS" = "true" ]; then DEFAULT_MQTT_PORT=8883; else DEFAULT_MQTT_PORT=1883; fi
    MQTT_PORT=$(jq -r --argjson d "$DEFAULT_MQTT_PORT" 'if (.mqtt_port // 0) > 0 then .mqtt_port else $d end' "$OPTS")
    MQTT_USERNAME=$(jq -r '.mqtt_username // ""' "$OPTS")
    MQTT_PASSWORD=$(jq -r '.mqtt_password // ""' "$OPTS")
    echo "[external-api] Using the configured broker, not the Mosquitto add-on."
else
    MQTT=$(service mqtt Mosquitto)
    MQTT_HOST=$(echo "$MQTT" | jq -r '.data.host')
    MQTT_PORT=$(echo "$MQTT" | jq -r '.data.port')
    MQTT_USERNAME=$(echo "$MQTT" | jq -r '.data.username // ""')
    MQTT_PASSWORD=$(echo "$MQTT" | jq -r '.data.password // ""')
    MQTT_TLS=$(echo "$MQTT" | jq -r 'if .data.ssl then "true" else "false" end')
fi

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
       MQTT_HOST MQTT_PORT MQTT_USERNAME MQTT_PASSWORD MQTT_TLS
export PORT=8080

echo "[external-api] house=${TURZI_HOUSE_ID} broker=${MQTT_HOST}:${MQTT_PORT} db=${DB_NAME}"
exec node /app/dist/index.js
