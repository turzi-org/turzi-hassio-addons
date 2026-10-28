#!/bin/sh
# Runs run.sh itself, without docker, for the integrations other than the bridge
# (integrations.lock): a folder stands in for what the image carries, another
# for Home Assistant's configuration, a listener for the Supervisor and the Stack.
# Needs python3, wget and sha256sum.   sh test-integrations.sh
set -u
RUN="${1:-$(dirname "$0")/run.sh}"; W="$(mktemp -d)"; PORT=18231; failed=0
mk() { mkdir -p "$W/carries/$1"; printf '{"domain": "%s", "version": "%s"}\n' "$1" "$2" > "$W/carries/$1/manifest.json"; echo "# $1" > "$W/carries/$1/__init__.py"; }
mk turzi_bridge 2026.10.7; mk alarmo 1.10.22; mk local_akuvox 0.1.0
python3 - "$PORT" "$W" <<'PY' &
import os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
w=sys.argv[2]
class L(BaseHTTPRequestHandler):
    def do_POST(self):
        open(f"{w}/restarts","a").write(self.path+"\n"); self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
    def do_GET(self):
        a=open(f"{w}/stack").read().strip() if os.path.exists(f"{w}/stack") else ""
        self.send_response(200 if a else 503); self.end_headers(); self.wfile.write(a.encode())
    def log_message(self,*a): pass
HTTPServer(("127.0.0.1",int(sys.argv[1])),L).serve_forever()
PY
L=$!; trap 'kill $L 2>/dev/null; rm -rf "$W"' EXIT; sleep 1
C="$W/config/custom_components"
run() { : > "$W/restarts"; mkdir -p "$W/config" "$W/data"; echo "$1" > "$W/data/options.json"
  HOMEASSISTANT_CONFIG="$W/config" OPTIONS_FILE="$W/data/options.json" KEPT_DIR="$W/data/previous" HELD_FILE="$W/data/held" \
  CARRIES_DIR="$W/carries" SUPERVISOR_URL="http://127.0.0.1:$PORT" ASK_EVERY=1 sh "$RUN" > "$W/log" 2>&1 &
  P=$!; sleep 3; pkill -P $P 2>/dev/null; kill $P 2>/dev/null; wait $P 2>/dev/null; LOG="$(cat "$W/log")"; }
expect() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; echo "$LOG" | sed 's/^/     /'; failed=1; fi; }
r() { grep -c core/restart "$W/restarts" | tr -d ' '; }
v() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$C/$1/manifest.json" 2>/dev/null; }

run '{"restart_home_assistant": true}'
expect "options without integrations: only the bridge" '[ -d "$C/turzi_bridge" ] && [ ! -e "$C/alarmo" ] && [ "$(r)" = 1 ]'
run '{"restart_home_assistant": true, "integrations": ["alarmo", "local_akuvox"]}'
expect "listed ones are put in place, with one restart" '[ "$(v alarmo)" = 1.10.22 ] && [ "$(v local_akuvox)" = 0.1.0 ] && [ "$(r)" = 1 ] && [ ! -e "$C/alarmo.old" ] && [ ! -e "$C/alarmo.new" ]'
run '{"restart_home_assistant": true, "integrations": ["alarmo", "local_akuvox"]}'
expect "the same ones there: nothing, no restart" '[ "$(r)" = 0 ] && echo "$LOG" | grep -q "alarmo 1.10.22 is in place"'
rm -rf "$C/turzi_bridge"; echo "# edited" >> "$C/alarmo/__init__.py"
run '{"restart_home_assistant": true, "integrations": ["alarmo"]}'
expect "bridge and alarmo both changed: still one restart" '[ "$(r)" = 1 ] && ! grep -q edited "$C/alarmo/__init__.py" && [ -d "$C/turzi_bridge" ]'
sed -i.bak 's/1.10.22/1.11.0/' "$C/alarmo/manifest.json"
run '{"restart_home_assistant": true, "integrations": ["alarmo"]}'
expect "a newer one there stays" '[ "$(v alarmo)" = 1.11.0 ] && [ "$(r)" = 0 ]'
run '{"restart_home_assistant": true, "integrations": ["turzi_thermostat", "../etc", "turzi_bridge"]}'
expect "not carried, a bad name, and the bridge: nothing done" '[ "$(r)" = 0 ] && [ ! -e "$C/turzi_thermostat" ] && echo "$LOG" | grep -q "does not carry it" && echo "$LOG" | grep -q "not an integration" && [ ! -e "$W/etc" ]'
rm -rf "$C/local_akuvox"
run '{"restart_home_assistant": false, "integrations": ["local_akuvox"]}'
expect "set not to restart: put in, no restart" '[ -d "$C/local_akuvox" ] && [ "$(r)" = 0 ]'
rm -rf "$C/local_akuvox"
run "$(printf '{\n  "restart_home_assistant": true,\n  "integrations": [\n    "local_akuvox"\n  ]\n}')"
expect "options written over several lines are read" '[ -d "$C/local_akuvox" ] && [ "$(r)" = 1 ]'
# Under a Stack that says wait: an integration's change restarts once, from the loop.
echo '{"do": "wait", "version": "2026.10.7"}' > "$W/stack"; rm -rf "$C/local_akuvox"
run '{"restart_home_assistant": true, "stack_url": "http://127.0.0.1:'$PORT'", "integrations": ["local_akuvox"]}'
expect "under a Stack, a change restarts once" '[ -d "$C/local_akuvox" ] && [ "$(r)" = 1 ]'
# Under a Stack that installs a new bridge: the bridge's restart is the one.
sed -i.bak 's/2026.10.7/2026.9.0/' "$C/turzi_bridge/manifest.json"; echo '{"do": "install", "version": "2026.10.7"}' > "$W/stack"; rm -rf "$C/local_akuvox"
run '{"restart_home_assistant": true, "stack_url": "http://127.0.0.1:'$PORT'", "integrations": ["local_akuvox"]}'
expect "under a Stack installing the bridge, still one restart" '[ -d "$C/local_akuvox" ] && [ "$(v turzi_bridge)" = 2026.10.7 ] && [ "$(r)" = 1 ]'
exit $failed
