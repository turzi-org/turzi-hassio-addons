#!/bin/sh
# Builds this add-on and runs it against a folder standing in for Home
# Assistant's configuration and a listener standing in for the Supervisor and,
# in the second half, for the Turzi Stack: it answers the add-on's question
# with whatever is in $WORK/stack, and not at all when that file is missing.
# Needs docker and python3.   sh test.sh
set -eu
cd "$(dirname "$0")"
IMAGE=turzi-bridge-installer:test
PORT=18200
WORK="$(mktemp -d)"
CARRIED="$(sed -n 's/^version:[[:space:]]*"\(.*\)"/\1/p' config.yaml | cut -d. -f1-3)"
failed=0

docker build -q -t "$IMAGE" . >/dev/null
python3 - "$PORT" "$WORK" <<'PY' &
import os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
work = sys.argv[2]
class Listener(BaseHTTPRequestHandler):
    def do_POST(self):      # Home Assistant's Supervisor
        open(f"{work}/restarts", "a").write(f"{self.path} {self.headers.get('Authorization')}\n")
        open(f"{work}/requests", "a").write(f"POST {self.path}\n")
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"result":"ok"}')
    def do_GET(self):       # the Turzi Stack
        open(f"{work}/requests", "a").write(f"GET {self.path}\n")
        answer = open(f"{work}/stack").read().strip() if os.path.exists(f"{work}/stack") else ""
        self.send_response(200 if answer else 503); self.end_headers(); self.wfile.write(answer.encode())
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", int(sys.argv[1])), Listener).serve_forever()
PY
LISTENER=$!
trap 'kill $LISTENER 2>/dev/null; docker rm -f bridge-installer-test >/dev/null 2>&1; docker run --rm -v "$WORK":/w alpine:3.22 rm -rf /w/config /w/data; rm -rf "$WORK"' EXIT
sleep 1

BRIDGE="$WORK/config/custom_components/turzi_bridge"
there() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$BRIDGE/manifest.json" 2>/dev/null; }
set_version() { docker run --rm -v "$WORK/config":/c alpine:3.22 sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"$1\"/" /c/custom_components/turzi_bridge/manifest.json; }
run() {   # $1 = the options file's content
  : > "$WORK/restarts"; : > "$WORK/requests"; mkdir -p "$WORK/config" "$WORK/data"; echo "$1" > "$WORK/data/options.json"
  docker rm -f bridge-installer-test >/dev/null 2>&1 || true
  docker run -d --init --name bridge-installer-test --network host -e SUPERVISOR_URL="http://127.0.0.1:$PORT" -e SUPERVISOR_TOKEN=lab-token -e ASK_EVERY=1 \
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

run '{"restart_home_assistant": true, "stack_url": "http://10.0.0.5"}'
expect "it says which Turzi Stack set it up, when one did" 'echo "$LOG" | grep -q "set up by the Turzi Stack at http://10.0.0.5$"'

set_version 2099.1.0
run "$ON"
expect "a newer bridge is left as it is" '[ "$(there)" = 2099.1.0 ] && [ "$(restarts)" = 0 ]'

set_version "$(echo "$CARRIED" | cut -d. -f1-2).100"
run "$ON"
expect "and versions are compared as numbers, not as text" '[ "$(there)" = "$(echo "$CARRIED" | cut -d. -f1-2).100" ] && [ "$(restarts)" = 0 ]'

# — set up by a Turzi Stack: it asks first —
WITH="{\"restart_home_assistant\": true, \"stack_url\": \"http://127.0.0.1:$PORT\"}"
WITH_OFF="{\"restart_home_assistant\": false, \"stack_url\": \"http://127.0.0.1:$PORT/\"}"
OLD=2026.9.0
wipe() { docker run --rm -v "$WORK":/w alpine:3.22 sh -c 'rm -rf /w/config/custom_components/turzi_bridge /w/data/previous /w/data/held'; rm -f "$WORK/stack"; }
says() { echo "{\"do\": \"$1\", \"version\": \"$2\", \"why\": \"${3:-}\", \"held\": \"${4:-}\"}" > "$WORK/stack"; }
again() { : > "$WORK/restarts"; : > "$WORK/requests"; sleep 3; LOG="$(docker logs bridge-installer-test 2>&1)"; }   # the same add-on, a little later
kept() { docker run --rm -v "$WORK/data":/d alpine:3.22 sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' /d/previous/manifest.json 2>/dev/null; }
line() { grep -n "$1" "$WORK/requests" | head -n 1 | cut -d: -f1; }

wipe; says install "$CARRIED" "nothing there"
run "$WITH"
expect "with no bridge there and the Stack saying so, it puts its own in place and restarts" '[ "$(there)" = "$CARRIED" ] && [ "$(restarts)" = 1 ]'
expect "it asked with what was there, what it carries and whether it may restart" 'head -n 1 "$WORK/requests" | grep -q "^GET /api/bridge?have=&carried=$CARRIED&restart=on$"'

set_version "$OLD"; says wait "$CARRIED" "a call is in progress"
run "$WITH"
expect "an older bridge is NOT replaced while the Stack says to wait" '[ "$(there)" = "$OLD" ] && [ "$(restarts)" = 0 ]'
expect "it says why, once, and keeps asking" '[ "$(echo "$LOG" | grep -c "says to wait (a call is in progress)")" = 1 ] && [ "$(grep -c "have=$OLD" "$WORK/requests")" -ge 2 ]'

says install "$CARRIED"; again
expect "when the Stack says install, it is replaced, with one restart" '[ "$(there)" = "$CARRIED" ] && [ "$(restarts)" = 1 ] && [ ! -e "$BRIDGE.old" ] && [ ! -e "$BRIDGE.new" ]'
expect "the bridge it replaced is kept" '[ "$(kept)" = "$OLD" ]'
expect "and the Stack is told it is in place before Home Assistant is restarted" '[ -n "$(line "have=$CARRIED")" ] && [ "$(line "have=$CARRIED")" -lt "$(line "POST /core/restart")" ]'

says put_back "$OLD" "" "$CARRIED"; again
expect "told to put the previous one back, it does, with one restart, and says so to the Stack" '[ "$(there)" = "$OLD" ] && [ "$(restarts)" = 1 ] && grep -q "have=$OLD" "$WORK/requests"'
expect "the version that was not well is written down" 'grep -qx "$CARRIED" "$WORK/data/held"'

says put_back 2025.1.0; again
expect "asked for a bridge it does not keep, it leaves the one there" '[ "$(there)" = "$OLD" ] && [ "$(restarts)" = 0 ] && echo "$LOG" | grep -q "2025.1.0 back, and it is not kept here"'

says install 2099.1.0; again
expect "asked for a bridge it does not carry, it installs nothing" '[ "$(there)" = "$OLD" ] && [ "$(restarts)" = 0 ] && echo "$LOG" | grep -q "asks for the bridge 2099.1.0"'

set_version 2099.1.0; says install "$CARRIED"; again
expect "told to install over a newer bridge, it does not: only the kept one ever replaces a newer one" '[ "$(there)" = 2099.1.0 ] && [ "$(restarts)" = 0 ] && echo "$LOG" | grep -q "2099.1.0, newer than"'
set_version "$OLD"

rm -f "$WORK/stack"; again
expect "when the Stack does not answer, the bridge there stays" '[ "$(there)" = "$OLD" ] && [ "$(restarts)" = 0 ] && echo "$LOG" | grep -q "does not answer: the bridge there stays"'

says wait "$CARRIED" "held" "2026.10.6 2026.10.7"; again
expect "the versions the Stack holds are kept, one a line" '[ "$(wc -l < "$WORK/data/held" | tr -d " ")" -ge 1 ] && grep -qx 2026.10.6 "$WORK/data/held" && grep -qx 2026.10.7 "$WORK/data/held"'
started=$(date +%s); docker stop bridge-installer-test >/dev/null
expect "it still stops at once when asked" '[ $(( $(date +%s) - started )) -lt 5 ]'

wipe
run "$WITH"
expect "with no bridge and a Stack that does not answer, it puts its own in place: nothing to lose" '[ "$(there)" = "$CARRIED" ] && [ "$(restarts)" = 1 ]'

wipe; echo "$CARRIED" > "$WORK/data/held"
run "$WITH"
expect "but never a version that was not well in this building" '[ -z "$(there)" ] && [ "$(restarts)" = 0 ]'

wipe; says install "$CARRIED" "nothing there"
run "$WITH_OFF"
expect "set not to restart, it tells the Stack so, and a first bridge goes in with no restart" '[ "$(there)" = "$CARRIED" ] && [ "$(restarts)" = 0 ] && grep -q "restart=off" "$WORK/requests"'

# — installed by hand, a version that was not well here stays out too —
set_version "$OLD"; echo "$CARRIED" > "$WORK/data/held"
run "$ON"
expect "by itself, it does not install a version that was not well in this building" '[ "$(there)" = "$OLD" ] && [ "$(restarts)" = 0 ] && echo "$LOG" | grep -q "was not well"'

[ "$failed" = 0 ] && echo "ALL PASSED" || { echo "SOME FAILED"; exit 1; }
