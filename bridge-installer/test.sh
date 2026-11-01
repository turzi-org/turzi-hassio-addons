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
STACK_A=18201; STACK_B=18202
WORK="$(mktemp -d)"
CARRIED="$(sed -n 's/^version:[[:space:]]*"\(.*\)"/\1/p' config.yaml | cut -d. -f1-3)"
failed=0

docker build -q -t "$IMAGE" . >/dev/null
python3 - "$PORT" "$WORK" "$STACK_A" "$STACK_B" <<'PY' &
import os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
work = sys.argv[2]
class Listener(BaseHTTPRequestHandler):
    def do_POST(self):      # Home Assistant's Supervisor
        open(f"{work}/restarts", "a").write(f"{self.path} {self.headers.get('Authorization')}\n")
        open(f"{work}/requests", "a").write(f"POST {self.path}\n")
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"result":"ok"}')
    def do_GET(self):       # a Turzi Stack, by its port
        port = self.server.server_address[1]
        open(f"{work}/requests", "a").write(f"GET {port} {self.path}\n")
        f = f"{work}/stack-{port}"
        answer = open(f).read().strip() if os.path.exists(f) else ""
        self.send_response(200 if answer else 503); self.end_headers(); self.wfile.write(answer.encode())
    def log_message(self, *a): pass
servers = [ThreadingHTTPServer(("127.0.0.1", int(p)), Listener) for p in sys.argv[3:5]]
for server in servers: threading.Thread(target=server.serve_forever, daemon=True).start()
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Listener).serve_forever()
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
run_quick() {   # the same, without the wait
  : > "$WORK/restarts"; : > "$WORK/requests"; mkdir -p "$WORK/config" "$WORK/data"; echo "$1" > "$WORK/data/options.json"
  docker rm -f bridge-installer-test >/dev/null 2>&1 || true
  docker run -d --init --name bridge-installer-test --network host -e SUPERVISOR_URL="http://127.0.0.1:$PORT" -e SUPERVISOR_TOKEN=lab-token -e ASK_EVERY=1 \
    -v "$WORK/config":/homeassistant -v "$WORK/data":/data "$IMAGE" >/dev/null
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

# — reached through Turzi Stacks: it asks every Stack its bridges name, and acts when they agree (#1163) —
# The add-on keeps asking while the test changes things: a Stack's new answer is always set
# BEFORE the bridge there is changed, or a round in between acts on the old answer.
OLD=2026.9.0
A="127.0.0.1:$STACK_A"; B="127.0.0.1:$STACK_B"
# $@ = «address title» pairs, one bridge entry each, or "cloud" for an entry with no Stack.
entries() {
  json=""
  while [ $# -gt 0 ]; do
    if [ "$1" = cloud ]; then e='{"domain":"turzi_bridge","title":"Nube","entry_id":"c","data":{"api_base_url":"https://api.dev.turzi.com/api/v2"}}'; shift
    else e="{\"domain\":\"turzi_bridge\",\"title\":\"$2\",\"entry_id\":\"$2\",\"data\":{\"api_address\":\"$1\",\"api_base_url\":\"https://x.stack.turzi.cloud:8126/api/v2\"}}"; shift 2; fi
    json="$json${json:+,}$e"
  done
  mkdir -p "$WORK/config"
  docker run --rm -v "$WORK/config":/c alpine:3.22 sh -c "mkdir -p /c/.storage && echo '{\"data\":{\"entries\":[$json,{\"domain\":\"mqtt\",\"data\":{}}]}}' > /c/.storage/core.config_entries"
}
wipe() { docker rm -f bridge-installer-test >/dev/null 2>&1 || true; docker run --rm -v "$WORK":/w alpine:3.22 sh -c 'rm -rf /w/config/custom_components/turzi_bridge /w/data/previous /w/data/held /w/config/.storage'; rm -f "$WORK"/stack-*; }
# $1 = the Stack's port, then what it says. Without a file it does not answer.
says() { echo "{\"do\": \"$2\", \"version\": \"$3\", \"why\": \"${4:-}\", \"held\": \"${5:-}\"}" > "$WORK/stack-$1"; }
silent() { rm -f "$WORK/stack-$1"; }
asked() { grep -c "^GET $1 /api/bridge" "$WORK/requests" 2>/dev/null || true; }
# Waits until every Stack named was asked at least $1 times since the files were emptied (the
# add-on asks each one a second), at most 20 s, instead of a fixed sleep that may end mid-round.
asked_each() {
  n=$1; shift; i=0
  while [ $i -lt 40 ]; do
    ok=1; for p in "$@"; do [ "$(asked "$p")" -ge "$n" ] || ok=0; done
    [ $ok = 1 ] && break
    sleep 0.5; i=$((i + 1))
  done
  sleep 0.5   # the last round's restart call, in the background
  LOG="$(docker logs bridge-installer-test 2>&1)"
}
start() { run_quick "$1"; asked_each 2 "$@"; }
# What the Stacks say changed: two whole rounds from now.
later_on() { : > "$WORK/restarts"; : > "$WORK/requests"; asked_each 3 "$@"; }
kept() { docker run --rm -v "$WORK/data":/d alpine:3.22 sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' /d/previous/manifest.json 2>/dev/null; }
keep_as() { docker run --rm -v "$WORK/data":/d -v "$WORK/config":/c alpine:3.22 sh -c "rm -rf /d/previous && cp -R /c/custom_components/turzi_bridge /d/previous && sed -i 's/\"version\": *\"[^\"]*\"/\"version\": \"$1\"/' /d/previous/manifest.json"; }
line() { grep -n "$1" "$WORK/requests" | head -n 1 | cut -d: -f1; }

wipe; entries "$A" "Dev Smoke Test"; says "$STACK_A" install "$CARRIED" "nothing there"
run_quick "$ON"; asked_each 2 "$STACK_A"
expect "with no bridge there and its Stack saying so, it puts its own in place and restarts" '[ "$(there)" = "$CARRIED" ] && [ "$(restarts)" = 1 ]'
expect "it names the Stack each bridge is reached through" 'echo "$LOG" | grep -q "«Dev Smoke Test» is reached through the Turzi Stack at $A"'
expect "it asked with what was there, what it carries and whether it may restart" 'grep -q "^GET $STACK_A /api/bridge?have=&carried=$CARRIED&restart=on$" "$WORK/requests"'

says "$STACK_A" wait "$CARRIED" "a call is in progress"; set_version "$OLD"; later_on "$STACK_A"
expect "an older bridge is NOT replaced while the Stack says to wait" '[ "$(there)" = "$OLD" ] && [ "$(restarts)" = 0 ]'
expect "it says why, once, and keeps asking" '[ "$(echo "$LOG" | grep -c "there is $OLD; the Turzi Stacks say to wait (Dev Smoke Test: a call is in progress)")" = 1 ] && [ "$(asked "$STACK_A")" -ge 3 ]'

says "$STACK_A" install "$CARRIED"; later_on "$STACK_A"
expect "when the Stack says install, it is replaced, with one restart" '[ "$(there)" = "$CARRIED" ] && [ "$(restarts)" = 1 ] && [ ! -e "$BRIDGE.old" ] && [ ! -e "$BRIDGE.new" ]'
expect "the bridge it replaced is kept" '[ "$(kept)" = "$OLD" ]'
expect "and the Stack is told it is in place before Home Assistant is restarted" '[ -n "$(line "have=$CARRIED")" ] && [ "$(line "have=$CARRIED")" -lt "$(line "POST /core/restart")" ]'

says "$STACK_A" put_back "$OLD" "" "$CARRIED"; later_on "$STACK_A"
expect "told to put the previous one back, it does, with one restart" '[ "$(there)" = "$OLD" ] && [ "$(restarts)" = 1 ] && grep -q "have=$OLD" "$WORK/requests"'
expect "the version that was not well is written down" 'grep -qx "$CARRIED" "$WORK/data/held"'

says "$STACK_A" put_back 2025.1.0; later_on "$STACK_A"
expect "asked for a bridge it does not keep, it leaves the one there" '[ "$(there)" = "$OLD" ] && [ "$(restarts)" = 0 ] && echo "$LOG" | grep -q "2025.1.0 back, and it is not kept here"'

says "$STACK_A" install 2099.1.0; later_on "$STACK_A"
expect "asked for a bridge it does not carry, it installs nothing" '[ "$(there)" = "$OLD" ] && [ "$(restarts)" = 0 ] && echo "$LOG" | grep -q "ask for the bridge 2099.1.0"'

set_version 2099.1.0; says "$STACK_A" install "$CARRIED"; later_on "$STACK_A"
expect "told to install over a newer bridge, it does not" '[ "$(there)" = 2099.1.0 ] && [ "$(restarts)" = 0 ] && echo "$LOG" | grep -q "2099.1.0, newer than"'
says "$STACK_A" wait "$CARRIED" "hold on"; sleep 1.5; set_version "$OLD"   # waiting, so the older bridge is not replaced at once

silent "$STACK_A"; later_on "$STACK_A"
expect "when the Stack does not answer, the bridge there stays" '[ "$(there)" = "$OLD" ] && [ "$(restarts)" = 0 ] && echo "$LOG" | grep -q "no answer from the Turzi Stack of Dev Smoke Test ($A)"'

says "$STACK_A" wait "$CARRIED" "held" "2026.10.6 2026.10.7"; later_on "$STACK_A"
expect "the versions the Stack holds are kept, one a line" 'grep -qx 2026.10.6 "$WORK/data/held" && grep -qx 2026.10.7 "$WORK/data/held"'
started=$(date +%s); docker stop bridge-installer-test >/dev/null
expect "it still stops at once when asked" '[ $(( $(date +%s) - started )) -lt 5 ]'

# — two communities in one Home Assistant, each through its own Stack —
wipe; entries "$A" "Dev Smoke Test" "$B" "QA"; says "$STACK_A" install "$CARRIED" "nothing there"; says "$STACK_B" install "$CARRIED" "nothing there"
run_quick "$ON"; asked_each 2 "$STACK_A" "$STACK_B"
says "$STACK_A" install "$CARRIED"; says "$STACK_B" wait "$CARRIED" "a call is in progress"; set_version "$OLD"; later_on "$STACK_A" "$STACK_B"
expect "it asks both Stacks, and one saying wait holds the other's install" '[ "$(there)" = "$OLD" ] && [ "$(restarts)" = 0 ] && echo "$LOG" | grep -q "QA: a call is in progress"'

says "$STACK_B" install "$CARRIED"; later_on "$STACK_A" "$STACK_B"
expect "when both say install, it is replaced once, and both are told" '[ "$(there)" = "$CARRIED" ] && [ "$(restarts)" = 1 ] && grep -q "^GET $STACK_A .*have=$CARRIED" "$WORK/requests" && grep -q "^GET $STACK_B .*have=$CARRIED" "$WORK/requests"'

says "$STACK_A" install "$CARRIED"; says "$STACK_B" install 2099.1.0; set_version "$OLD"; later_on "$STACK_A" "$STACK_B"
expect "Stacks that agree on different versions: it waits" '[ "$(there)" = "$OLD" ] && [ "$(restarts)" = 0 ] && echo "$LOG" | grep -q "ask for different bridges ("'

says "$STACK_A" install "$CARRIED"; says "$STACK_B" wait "$CARRIED"; set_version "$CARRIED"; keep_as "$OLD"; says "$STACK_B" put_back "$OLD"; later_on "$STACK_A" "$STACK_B"
expect "one put-back against one install: it is put back" '[ "$(there)" = "$OLD" ] && [ "$(restarts)" = 1 ]'

says "$STACK_A" put_back 2026.8.0; says "$STACK_B" put_back 2026.8.1; later_on "$STACK_A" "$STACK_B"
expect "two Stacks asking for different bridges back: it waits and says so" '[ "$(there)" = "$OLD" ] && [ "$(restarts)" = 0 ] && echo "$LOG" | grep -q "different bridges back"'

says "$STACK_A" install "$CARRIED"; silent "$STACK_B"; later_on "$STACK_A" "$STACK_B"
expect "a Stack that does not answer holds the other's install" '[ "$(there)" = "$OLD" ] && [ "$(restarts)" = 0 ] && echo "$LOG" | grep -q "no answer from the Turzi Stack of QA ($B)"'
expect "and the Stack that answers is told which one holds it, and since when" 'grep -q "^GET $STACK_A .*&held_by=QA&held_by_address=127.0.0.1%3A$STACK_B&held_by_since=[0-9][0-9]*$" "$WORK/requests"'

echo '{"do": "wait", "version": null, "why": "not a Home Assistant this Stack set up", "held": "", "set_up_here": false}' > "$WORK/stack-$STACK_B"; later_on "$STACK_A" "$STACK_B"
expect "a Stack that did not set this Home Assistant up has no say" '[ "$(there)" = "$CARRIED" ] && [ "$(restarts)" = 1 ]'
# The Stack says wait while the older bridge goes in, or it would be replaced before the round that counts.
says "$STACK_A" wait "$CARRIED" "hold on"; sleep 1.5; set_version "$OLD"; sleep 1.5
echo '{"do": "wait", "version": null, "why": "something else", "held": "", "set_up_here": false}' > "$WORK/stack-$STACK_B"; says "$STACK_A" install "$CARRIED"; later_on "$STACK_A" "$STACK_B"
expect "it reads that from set_up_here, whatever the why says" '[ "$(there)" = "$CARRIED" ] && [ "$(restarts)" = 1 ]'

wipe; entries "$A" "Dev Smoke Test" cloud; says "$STACK_A" install "$CARRIED" "nothing there"
run_quick "$ON"; asked_each 2 "$STACK_A"
expect "an entry with no Stack address is skipped" '[ "$(there)" = "$CARRIED" ] && ! echo "$LOG" | grep -q "«Nube»"'

# — no Stack answers —
wipe; entries "$A" "Dev Smoke Test"
run_quick "$ON"; asked_each 2 "$STACK_A"
expect "with no bridge and a Stack that does not answer, it puts its own in place: nothing to lose" '[ "$(there)" = "$CARRIED" ] && [ "$(restarts)" = 1 ]'

wipe; entries "$A" "Dev Smoke Test"; mkdir -p "$WORK/data"; echo "$CARRIED" > "$WORK/data/held"
run_quick "$ON"; asked_each 2 "$STACK_A"
expect "but never a version that was not well in this building" '[ -z "$(there)" ] && [ "$(restarts)" = 0 ]'

wipe; entries "$A" "Dev Smoke Test"; says "$STACK_A" install "$CARRIED" "nothing there"
run_quick "$OFF"; asked_each 2 "$STACK_A"
expect "set not to restart, it tells the Stack so, and a first bridge goes in with no restart" '[ "$(there)" = "$CARRIED" ] && [ "$(restarts)" = 0 ] && grep -q "restart=off" "$WORK/requests"'

# — installed by hand, a version that was not well here stays out too —
wipe; run "$ON"; set_version "$OLD"; echo "$CARRIED" > "$WORK/data/held"
run "$ON"
expect "by itself, it does not install a version that was not well in this building" '[ "$(there)" = "$OLD" ] && [ "$(restarts)" = 0 ] && echo "$LOG" | grep -q "was not well"'

[ "$failed" = 0 ] && echo "ALL PASSED" || { echo "SOME FAILED"; exit 1; }
