#!/bin/sh
# Puts the bridge this add-on carries where Home Assistant loads it from, and
# asks for a restart when that changed anything.
#
# Installed by hand, it does that when it starts, and then waits: see
# config.yaml for why it keeps running.
#
# Where its bridges are reached through Turzi Stacks, it asks each of them
# first, once a minute, and acts only when they agree: install the bridge it
# carries, put the previous one back, or wait (turzi-apps/TURZI_SUPERVISOR.md
# §6.2, #1163). The bridge is always this add-on's own: the Stacks give the
# moment, never the code.
set -eu

SOURCE=/opt/turzi/turzi_bridge
CONFIG="${HOMEASSISTANT_CONFIG:-/homeassistant}"
TARGET="$CONFIG/custom_components/turzi_bridge"
SUPERVISOR="${SUPERVISOR_URL:-http://supervisor}"
OPTIONS="${OPTIONS_FILE:-/data/options.json}"
KEPT="${KEPT_DIR:-/data/previous}"      # the bridge that was replaced, to put it back
HELD="${HELD_FILE:-/data/held}"         # versions that were tried in this building and were not well
ASK_EVERY="${ASK_EVERY:-60}"
TAB="$(printf '\t')"

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

# $1 = the folder to put in place. Written beside the bridge and swapped in,
# so Home Assistant never finds half a bridge. With `keep`, the one it
# replaces is kept, to be put back if the new one is not well.
place() {
  mkdir -p "$CONFIG/custom_components"
  rm -rf "$TARGET.new" "$TARGET.old"
  cp -R "$1" "$TARGET.new"
  if [ -d "$TARGET" ]; then mv "$TARGET" "$TARGET.old"; fi
  mv "$TARGET.new" "$TARGET"
  if [ "${2:-}" = keep ] && [ -d "$TARGET.old" ]; then
    rm -rf "$KEPT" "$TARGET.old/__pycache__"
    mkdir -p "$(dirname "$KEPT")"
    mv "$TARGET.old" "$KEPT"
  fi
  rm -rf "$TARGET.old"
}

restart_home_assistant() {
  if restarts; then
    log "restarting Home Assistant, which is how it loads the bridge"
    # In the background: the call answers when Home Assistant is back.
    ( wget -q -T 900 -O /dev/null --header "Authorization: Bearer ${SUPERVISOR_TOKEN:-}" --post-data '' "$SUPERVISOR/core/restart" \
        && log "Home Assistant restarted" || log "the restart was refused or did not finish: restart Home Assistant by hand" ) &
  else
    log "Home Assistant was not restarted, as this add-on is set: it runs the new bridge after its next restart"
  fi
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
}

ENTRIES="$CONFIG/.storage/core.config_entries"

# The Turzi Stacks this Home Assistant's bridges are reached through, one a
# line as «address<TAB>entry's title» (#1163). Each bridge entry made through a
# Stack keeps the address its Stack is dialled at; an entry with none is on
# Turzi's cloud and has no Stack to ask. A Stack still in clear is in the
# entry's API URL as a bare IP. Read again before each round, so a bridge
# added, moved or removed changes who is asked.
stacks() {
  [ -f "$ENTRIES" ] || return 0
  jq -r '.data.entries[]? | select(.domain == "turzi_bridge")
    | ((.data.api_address // "") as $a
       | ((.data.api_base_url // "") | (capture("^http://(?<h>[0-9.]+)(:[0-9]+)?/") | .h) // "") as $clear
       | (if $a != "" then $a else $clear end)) as $addr
    | select($addr != "") | "\($addr)\t\(.title // .entry_id)"' "$ENTRIES" 2>/dev/null | sort -u -t "$TAB" -k1,1 || true
}

# What is there now -> one Stack's answer, or nothing when it does not answer.
# $2 is the Stack's address, $3 what holds this Home Assistant, for it to show.
ask() {
  wget -q -T 10 -O - "http://$2/api/bridge?have=$1&carried=$carried&restart=$(restarts && echo on || echo off)${3:-}" 2>/dev/null || true
}

uri() { jq -rn --arg v "$1" '$v | @uri'; }

# The same to every Stack that answered this round: the bridge there changed.
tell_all() { printf '%s\n' "$answered" | while IFS= read -r a; do if [ -n "$a" ]; then ask "$1" "$a" >/dev/null; fi; done; }

# Set up by Turzi Stacks: they decide when, together. One Home Assistant runs
# one bridge for every community it serves, so its version is every one of
# their Stacks' decision: it is replaced only when all of them say so, with the
# same version (#1163). A Stack that does not answer holds the rest, and every
# Stack that answers is told which one, to show it.
follow_the_stacks() {
  said=""; quiet_since=""
  while :; do
    installed="$(version "$TARGET")"
    list="$(stacks)"
    if [ -z "$list" ]; then
      if [ -z "$said" ]; then by_itself; said="by itself"; fi
      sleep "$ASK_EVERY" & wait $!
      continue
    fi
    answered=""; silent=""; first=""; installs=""; backs=""; waits=""; why_all=""; held_all=""
    while IFS="$TAB" read -r addr title; do
      answer="$(ask "$installed" "$addr")"
      if [ -z "$answer" ]; then silent="$silent${silent:+, }$title ($addr)"; first="${first:-$title$TAB$addr}"; continue; fi
      what="$(field "$answer" do)"; about="$(field "$answer" version)"; why="$(field "$answer" why)"
      held_all="$held_all $(field "$answer" held)"
      # A Stack that did not set this Home Assistant up has no say in it: it says so with
      # "set_up_here": false (Supervisor 0.11.27), and before that only in its why.
      if printf '%s' "$answer" | grep -q '"set_up_here"[[:space:]]*:[[:space:]]*false' \
        || { [ "$what" = wait ] && [ "$why" = "not a Home Assistant this Stack set up" ]; }; then continue; fi
      answered="$answered$addr
"
      case "$what" in
        install) installs="$installs $about" ;;
        put_back) backs="$backs $about" ;;
        *) waits="$waits $addr"; why_all="$why_all${why_all:+; }$title: ${why:-wait}" ;;
      esac
    done <<STACKS
$list
STACKS
    # The versions that were not well here, as the Stacks keep them: never installed by this add-on alone.
    if [ -n "$answered" ]; then printf '%s\n' $held_all | sort -u > "$HELD" 2>/dev/null || true; fi
    installs="$(printf '%s\n' $installs | sort -u | tr '\n' ' ' | sed 's/ *$//')"
    backs="$(printf '%s\n' $backs | sort -u | tr '\n' ' ' | sed 's/ *$//')"
    if [ -n "$silent" ]; then
      quiet_since="${quiet_since:-$(date +%s)}"
      # Every Stack that answers is told which one holds this Home Assistant, and since when, to show it.
      # As data, for the Stack to report and the TCM to word: the first that is silent, if several are.
      holder="&held_by=$(uri "${first%%"$TAB"*}")&held_by_address=$(uri "${first#*"$TAB"}")&held_by_since=$quiet_since"
      printf '%s' "$answered" | while IFS= read -r a; do if [ -n "$a" ]; then ask "$installed" "$a" "$holder" >/dev/null; fi; done
    else
      quiet_since=""
    fi

    now=""
    if [ -z "$installed" ] && [ -z "$answered" ]; then
      if held "$carried"; then
        now="no Turzi Stack answers, and the bridge $carried was not well here: none is put in place"
      else
        # A Home Assistant with no bridge has nothing to lose by getting one.
        place "$SOURCE"
        log "no Turzi Stack answers, and there is no bridge: $carried was put in place"
        restart_home_assistant
      fi
    elif [ -n "$backs" ]; then
      case "$backs" in
        *" "*) now="the Turzi Stacks ask for different bridges back ($backs): the bridge there stays" ;;
        "$installed") ;;
        *)
          # Back to the bridge every Stack agreed on before: the one this add-on kept when it replaced it.
          if [ -d "$KEPT" ] && [ "$(version "$KEPT")" = "$backs" ]; then
            place "$KEPT"
            log "the bridge $backs was put back${installed:+, in place of $installed}, as a Turzi Stack said: $installed was not well here"
            tell_all "$backs"
            restart_home_assistant
          else
            now="a Turzi Stack asks for the bridge $backs back, and it is not kept here: the one there stays"
          fi ;;
      esac
    elif [ -n "$silent" ]; then
      now="no answer from the Turzi Stack of $silent: the bridge there stays as it is"
    elif [ -n "$waits" ]; then
      now="the bridge there is ${installed:-none}; the Turzi Stacks say to wait ($why_all)"
    elif [ -n "$installs" ]; then
      case "$installs" in
        *" "*) now="the Turzi Stacks ask for different bridges ($installs): the bridge there stays" ;;
        *)
          if [ -n "$installed" ] && later "$installed" "$carried"; then
            # Whatever the Stacks say, a newer bridge is never replaced by an older one from here.
            now="the bridge there is $installed, newer than the $carried this add-on carries: left as it is"
          elif [ "$installs" = "$carried" ] && [ "$installed" != "$carried" ]; then
            place "$SOURCE" keep
            log "the bridge $carried was put in place${installed:+, replacing $installed}, as the Turzi Stacks said"
            # Told before the restart: each Stack waits for its bridge to leave and come back from here.
            tell_all "$carried"
            restart_home_assistant
          elif [ "$installs" != "$carried" ]; then
            now="the Turzi Stacks ask for the bridge $installs, and this add-on carries $carried: update the add-on"
          fi ;;
      esac
    fi
    if [ -n "$now" ] && [ "$now" != "$said" ]; then log "$now"; fi
    said="${now:-quiet}"
    sleep "$ASK_EVERY" & wait $!
  done
}

trap 'exit 0' TERM INT
carried="$(version "$SOURCE")"
installed="$(version "$TARGET")"
if [ ! -d "$CONFIG" ]; then
  log "Home Assistant's configuration folder is not at $CONFIG: nothing was done"
else
  # `stack_url` is no longer read: a Home Assistant's Stacks are the ones its bridges name (#1163).
  stacks | while IFS="$TAB" read -r addr title; do log "the bridge «$title» is reached through the Turzi Stack at $addr"; done
  follow_the_stacks
fi

# tail and not sleep: it ends at once when the add-on is stopped.
exec tail -f /dev/null
