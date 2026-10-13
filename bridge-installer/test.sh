#!/bin/sh
# Builds this add-on and runs it against a folder standing in for Home
# Assistant's configuration and a listener standing in for the Supervisor.
# Needs docker and python3.   sh test.sh
set -eu
cd "$(dirname "$0")"
IMAGE=turzi-bridge-installer:test
PORT=18200
WORK="$(mktemp -d)"
CARRIED="$(sed -n 's/^version:[[:space:]]*"\(.*\)"/\1/p' config.yaml | cut -d. -f1-3)"
failed=0

docker build -q -t "$IMAGE" . >/dev/null
python3 - "$PORT" "$WORK/restarts" <<'PY' &
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class Supervisor(BaseHTTPRequestHandler):
    def do_POST(self):
        open(sys.argv[2], "a").write(f"{self.path} {self.headers.get('Authorization')}\n")
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"result":"ok"}')
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", int(sys.argv[1])), Supervisor).serve_forever()
PY
LISTENER=$!
trap 'kill $LISTENER 2>/dev/null; docker rm -f bridge-installer-test >/dev/null 2>&1; docker run --rm -v "$WORK":/w alpine:3.22 rm -rf /w/config /w/data; rm -rf "$WORK"' EXIT
sleep 1

BRIDGE="$WORK/config/custom_components/turzi_bridge"
there() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$BRIDGE/manifest.json" 2>/dev/null; }
set_version() { docker run --rm -v "$WORK/config":/c alpine:3.22 sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"$1\"/" /c/custom_components/turzi_bridge/manifest.json; }
run() {   # $1 = the options file's content
  : > "$WORK/restarts"; mkdir -p "$WORK/config" "$WORK/data"; echo "$1" > "$WORK/data/options.json"
  docker rm -f bridge-installer-test >/dev/null 2>&1 || true
  docker run -d --init --name bridge-installer-test --network host -e SUPERVISOR_URL="http://127.0.0.1:$PORT" -e SUPERVISOR_TOKEN=lab-token \
    -v "$WORK/config":/homeassistant -v "$WORK/data":/data "$IMAGE" >/dev/null
  sleep 3
  LOG="$(docker logs bridge-installer-test 2>&1)"
}
expect() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; echo "     $LOG"; failed=1; fi; }
restarts() { wc -l < "$WORK/restarts" | tr -d ' '; }
ON='{"restart_home_assistant": true}'; OFF='{"restart_home_assistant": false}'

run "$ON"
expect "with no bridge there, it puts its own in place" '[ "$(there)" = "$CARRIED" ] && [ -f "$BRIDGE/__init__.py" ]'
expect "and asks for one restart, as itself" '[ "$(restarts)" = 1 ] && grep -q "^/core/restart Bearer lab-token$" "$WORK/restarts"'
expect "it keeps running" '[ "$(docker inspect -f "{{.State.Running}}" bridge-installer-test)" = true ]'
started=$(date +%s); docker stop bridge-installer-test >/dev/null
expect "and stops at once when asked" '[ $(( $(date +%s) - started )) -lt 5 ]'

# What Home Assistant leaves beside the bridge once it has run it.
docker run --rm -v "$WORK/config":/c alpine:3.22 sh -c 'mkdir -p /c/custom_components/turzi_bridge/__pycache__ && echo x > /c/custom_components/turzi_bridge/__pycache__/__init__.cpython-313.pyc'
run "$ON"
expect "with the same bridge there, nothing changes and nothing restarts" '[ "$(restarts)" = 0 ] && echo "$LOG" | grep -q "is in place"'

set_version 2026.9.0
run "$ON"
expect "an older bridge is replaced, with a restart" '[ "$(there)" = "$CARRIED" ] && [ "$(restarts)" = 1 ] && [ ! -e "$BRIDGE.old" ] && [ ! -e "$BRIDGE.new" ]'

docker run --rm -v "$WORK/config":/c alpine:3.22 sh -c 'echo "# edited" >> /c/custom_components/turzi_bridge/const.py'
run "$ON"
expect "the same version with a file that differs is put right" '[ "$(restarts)" = 1 ] && ! grep -q "^# edited" "$BRIDGE/const.py"'

set_version 2026.9.0
run "$OFF"
expect "set not to restart, it replaces and leaves the restart to you" '[ "$(there)" = "$CARRIED" ] && [ "$(restarts)" = 0 ]'

set_version 2099.1.0
run "$ON"
expect "a newer bridge is left as it is" '[ "$(there)" = 2099.1.0 ] && [ "$(restarts)" = 0 ]'

set_version "$(echo "$CARRIED" | cut -d. -f1-2).100"
run "$ON"
expect "and versions are compared as numbers, not as text" '[ "$(there)" = "$(echo "$CARRIED" | cut -d. -f1-2).100" ] && [ "$(restarts)" = 0 ]'

[ "$failed" = 0 ] && echo "ALL PASSED" || { echo "SOME FAILED"; exit 1; }
