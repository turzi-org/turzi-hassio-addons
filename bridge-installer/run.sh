#!/bin/sh
# Puts the bridge this add-on carries where Home Assistant loads it from, and
# asks for a restart when that changed anything.
#
# Installed by hand, it does that when it starts, and then waits: see
# config.yaml for why it keeps running.
#
# Set up by a Turzi Stack, it asks the Stack first, once a minute, and does
# what it is told: install the bridge it carries, put the previous one back,
# or wait (turzi-apps/TURZI_SUPERVISOR.md §6.2). The bridge is always this
# add-on's own: the Stack gives the moment, never the code.
set -eu

CARRIES="${CARRIES_DIR:-/opt/turzi}"   # what this installer carries, one folder per integration
SOURCE="$CARRIES/turzi_bridge"
CONFIG="${HOMEASSISTANT_CONFIG:-/homeassistant}"
TARGET="$CONFIG/custom_components/turzi_bridge"
SUPERVISOR="${SUPERVISOR_URL:-http://supervisor}"
OPTIONS="${OPTIONS_FILE:-/data/options.json}"
KEPT="${KEPT_DIR:-/data/previous}"      # the bridge that was replaced, to put it back
HELD="${HELD_FILE:-/data/held}"         # versions that were tried in this building and were not well
ASK_EVERY="${ASK_EVERY:-60}"

log() { echo "[turzi-bridge-installer] $*"; }
version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1/manifest.json" 2>/dev/null || true; }
# Every file's name and content in one line, leaving out what Python writes
# beside them as it runs. BusyBox's diff cannot leave a folder out.
print_of() { ( cd "$1" && find . -type f ! -path '*/__pycache__/*' | sort | xargs sha256sum | sha256sum ); }
# True when $1 is a later version than $2.
later() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1)" = "$1" ]; }
# One text field of a one-line JSON answer.
field() { printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"; }
restarts() { ! grep -q '"restart_home_assistant"[[:space:]]*:[[:space:]]*false' "$OPTIONS" 2>/dev/null; }
held() { grep -qx "$1" "$HELD" 2>/dev/null; }

# $1 = the folder to put at $2, written beside it and swapped in. What was
# there is left at $2.old, for the caller to keep or remove.
swap() {
  mkdir -p "$CONFIG/custom_components"
  rm -rf "$2.new" "$2.old"
  cp -R "$1" "$2.new"
  if [ -d "$2" ]; then mv "$2" "$2.old"; fi
  mv "$2.new" "$2"
}

# $1 = the folder to put in place. Written beside the bridge and swapped in,
# so Home Assistant never finds half a bridge. With `keep`, the one it
# replaces is kept, to be put back if the new one is not well.
place() {
  swap "$1" "$TARGET"
  if [ "${2:-}" = keep ] && [ -d "$TARGET.old" ]; then
    rm -rf "$KEPT" "$TARGET.old/__pycache__"
    mkdir -p "$(dirname "$KEPT")"
    mv "$TARGET.old" "$KEPT"
  fi
  rm -rf "$TARGET.old"
}

restart_home_assistant() {
  owed=""
  if restarts; then
    log "restarting Home Assistant, which is how it loads the bridge"
    # In the background: the call answers when Home Assistant is back.
    ( wget -q -T 900 -O /dev/null --header "Authorization: Bearer ${SUPERVISOR_TOKEN:-}" --post-data '' "$SUPERVISOR/core/restart" \
        && log "Home Assistant restarted" || log "the restart was refused or did not finish: restart Home Assistant by hand" ) &
  else
    log "Home Assistant was not restarted, as this add-on is set: it runs the new bridge after its next restart"
  fi
}

# The other integrations this installer carries (integrations.lock), each one
# the add-on's options list: put in place when the add-on starts, which is
# after every update of it, by hand or by the Turzi Stack. One that is newer
# there, put in with HACS or by hand, stays. One the options stop listing is
# left where it is: its configuration in Home Assistant may still use it. A
# change owes Home Assistant one restart, shared with the bridge's.
chosen() {
  tr -d '\n' < "$OPTIONS" 2>/dev/null | sed -n 's/.*"integrations"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | tr -d '" ' | tr ',' '\n'
}
others() {
  for name in $(chosen); do
    case "$name" in
      turzi_bridge) continue ;;
      *[!a-z0-9_]*|"") log "\"$name\" in the options is not an integration's name: left out"; continue ;;
    esac
    from="$CARRIES/$name"; to="$CONFIG/custom_components/$name"
    if [ ! -f "$from/manifest.json" ]; then
      log "$name is asked for, and this installer does not carry it"; continue
    fi
    have="$(version "$to")"; carries="$(version "$from")"
    if [ -n "$have" ] && later "$have" "$carries"; then
      log "$name there is $have, newer than the $carries this add-on carries: left as it is"
    elif [ -d "$to" ] && [ "$(print_of "$from")" = "$(print_of "$to")" ]; then
      log "$name $carries is in place"
    else
      swap "$from" "$to"; rm -rf "$to.old"
      log "$name $carries was put in place${have:+, replacing $have}"
      owed=yes
    fi
  done
}

# Installed by hand: the bridge goes in when the add-on starts.
by_itself() {
  if [ -n "$installed" ] && later "$installed" "$carried"; then
    # Somebody put a newer bridge there, by hand or with HACS. Theirs stays.
    log "the bridge there is $installed, newer than the $carried this add-on carries: left as it is"
  elif [ -d "$TARGET" ] && [ "$(print_of "$SOURCE")" = "$(print_of "$TARGET")" ]; then
    log "the bridge $carried is in place"
  elif held "$carried"; then
    log "the bridge $carried was tried in this building and was not well: the one there stays"
  else
    place "$SOURCE"
    log "the bridge $carried was put in place${installed:+, replacing $installed}"
    restart_home_assistant
  fi
  if [ -n "$owed" ]; then restart_home_assistant; fi
}

ask() {   # what is there now -> the Stack's answer, or nothing when it does not answer
  wget -q -T 10 -O - "$stack/api/bridge?have=$1&carried=$carried&restart=$(restarts && echo on || echo off)" 2>/dev/null || true
}

# Set up by a Turzi Stack: it decides when.
follow_the_stack() {
  said=""
  while :; do
    installed="$(version "$TARGET")"
    answer="$(ask "$installed")"
    what="$(field "$answer" do)"; about="$(field "$answer" version)"; why="$(field "$answer" why)"
    # The versions that were not well here, as the Stack keeps them: never installed by this add-on alone.
    if [ -n "$answer" ]; then field "$answer" held | tr ' ' '\n' > "$HELD" 2>/dev/null || true; fi
    now="$what $about $why"
    case "$what" in
      install)
        if [ -n "$installed" ] && later "$installed" "$carried"; then
          # Whatever the Stack says, a newer bridge is never replaced by an older one from here.
          if [ "$now" != "$said" ]; then log "the bridge there is $installed, newer than the $carried this add-on carries: left as it is"; fi
        elif [ "$about" = "$carried" ] && [ "$installed" != "$carried" ]; then
          place "$SOURCE" keep
          log "the bridge $carried was put in place${installed:+, replacing $installed}, as the Turzi Stack said"
          # Told before the restart: the Stack waits for the bridge to leave and come back from here.
          ask "$carried" >/dev/null
          restart_home_assistant
        elif [ "$about" != "$carried" ] && [ "$now" != "$said" ]; then
          log "the Turzi Stack asks for the bridge $about, and this add-on carries $carried: update the add-on"
        fi ;;
      put_back)
        if [ "$installed" = "$about" ]; then
          :
        elif [ -d "$KEPT" ] && [ "$(version "$KEPT")" = "$about" ]; then
          place "$KEPT"
          log "the bridge $about was put back${installed:+, in place of $installed}, as the Turzi Stack said: $installed was not well here"
          ask "$about" >/dev/null
          restart_home_assistant
        elif [ "$now" != "$said" ]; then
          log "the Turzi Stack asks for the bridge $about back, and it is not kept here: the one there stays"
        fi ;;
      wait)
        if [ "$now" != "$said" ]; then log "the bridge there is ${installed:-none}; the Turzi Stack says to wait${why:+ ($why)}"; fi ;;
      *)
        if [ -z "$installed" ] && ! held "$carried"; then
          # A Home Assistant with no bridge has nothing to lose by getting one.
          place "$SOURCE"
          log "the Turzi Stack at $stack does not answer, and there is no bridge: $carried was put in place"
          restart_home_assistant
        elif [ "$now" != "$said" ]; then
          log "the Turzi Stack at $stack does not answer: the bridge there stays as it is"
        fi ;;
    esac
    # What others() put in place, when this answer did not restart Home Assistant already.
    if [ -n "$owed" ]; then restart_home_assistant; fi
    said="$now"
    sleep "$ASK_EVERY" & wait $!
  done
}

trap 'exit 0' TERM INT
carried="$(version "$SOURCE")"
installed="$(version "$TARGET")"
stack="$(sed -n 's/.*"stack_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$OPTIONS" 2>/dev/null || true)"
stack="${stack%/}"

owed=""
if [ ! -d "$CONFIG" ]; then
  log "Home Assistant's configuration folder is not at $CONFIG: nothing was done"
elif others; [ -n "$stack" ]; then
  log "set up by the Turzi Stack at $stack"
  follow_the_stack
else
  by_itself
fi

# tail and not sleep: it ends at once when the add-on is stopped.
exec tail -f /dev/null
