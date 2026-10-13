#!/bin/sh
# Puts the bridge this add-on carries where Home Assistant loads it from, and
# asks for a restart when that changed anything. Then it waits: see config.yaml
# for why it keeps running.
set -eu

SOURCE=/opt/turzi/turzi_bridge
CONFIG="${HOMEASSISTANT_CONFIG:-/homeassistant}"
TARGET="$CONFIG/custom_components/turzi_bridge"
SUPERVISOR="${SUPERVISOR_URL:-http://supervisor}"
OPTIONS="${OPTIONS_FILE:-/data/options.json}"

log() { echo "[turzi-bridge-installer] $*"; }
version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1/manifest.json" 2>/dev/null || true; }
# Every file's name and content in one line, leaving out what Python writes
# beside them as it runs. BusyBox's diff cannot leave a folder out.
print_of() { ( cd "$1" && find . -type f ! -path '*/__pycache__/*' | sort | xargs sha256sum | sha256sum ); }
# True when $1 is a later version than $2.
later() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]; }

carried="$(version "$SOURCE")"
installed="$(version "$TARGET")"
stack="$(sed -n 's/.*"stack_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$OPTIONS" 2>/dev/null || true)"
if [ -n "$stack" ]; then log "set up by the Turzi Stack at $stack"; fi

if [ ! -d "$CONFIG" ]; then
  log "Home Assistant's configuration folder is not at $CONFIG: nothing was done"
elif [ -n "$installed" ] && later "$installed" "$carried"; then
  # Somebody put a newer bridge there, by hand or with HACS. Theirs stays.
  log "the bridge there is $installed, newer than the $carried this add-on carries: left as it is"
elif [ -d "$TARGET" ] && [ "$(print_of "$SOURCE")" = "$(print_of "$TARGET")" ]; then
  log "the bridge $carried is in place"
else
  # Written beside it and swapped in, so Home Assistant never finds half a bridge.
  mkdir -p "$CONFIG/custom_components"
  rm -rf "$TARGET.new" "$TARGET.old"
  cp -R "$SOURCE" "$TARGET.new"
  if [ -d "$TARGET" ]; then mv "$TARGET" "$TARGET.old"; fi
  mv "$TARGET.new" "$TARGET"
  rm -rf "$TARGET.old"
  log "the bridge $carried was put in place${installed:+, replacing $installed}"

  if grep -q '"restart_home_assistant"[[:space:]]*:[[:space:]]*false' "$OPTIONS" 2>/dev/null; then
    log "Home Assistant was not restarted, as this add-on is set: it runs the new bridge after its next restart"
  else
    log "restarting Home Assistant, which is how it loads the bridge"
    # In the background: the call answers when Home Assistant is back.
    ( wget -q -T 900 -O /dev/null --header "Authorization: Bearer ${SUPERVISOR_TOKEN:-}" --post-data '' "$SUPERVISOR/core/restart" \
        && log "Home Assistant restarted" || log "the restart was refused or did not finish: restart Home Assistant by hand" ) &
  fi
fi

# tail and not sleep: it ends at once when the add-on is stopped.
exec tail -f /dev/null
