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

need() {
    # jq -e makes an absent or null value an error rather than the string
    # "null" silently becoming a hostname.
    jq -er "$2" "$OPTS" 2>/dev/null || {
        echo "[external-api] Missing required option: $1" >&2
        exit 1
    }
}

TURZI_HOUSE_ID=$(need house_id '.house_id | select(. != "")')
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

# --- MQTT, from the Mosquitto add-on -------------------------------------
MQTT=$(service mqtt Mosquitto)
MQTT_HOST=$(echo "$MQTT" | jq -r '.data.host')
MQTT_PORT=$(echo "$MQTT" | jq -r '.data.port')
MQTT_USERNAME=$(echo "$MQTT" | jq -r '.data.username // ""')
MQTT_PASSWORD=$(echo "$MQTT" | jq -r '.data.password // ""')
MQTT_TLS=$(echo "$MQTT" | jq -r 'if .data.ssl then "true" else "false" end')

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
