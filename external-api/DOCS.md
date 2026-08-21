# Turzi External System API

Lets an external system — an access-control panel, a BMS, a customer's own
software — read and operate the entities this Home Assistant exposes, over a
plain REST API. It talks to HA the same way the Turzi app does: by publishing
Turzi Protocol commands to MQTT and reading the state the Turzi bridge
publishes there. Every action and every observed state is written to MariaDB.

This is a stopgap. When Turzi v2 goes live, its API exposes the same devices to
external systems with real identity and per-entity authorization, and this
add-on is removed.

## Before you install

Three things must already be running:

1. **Mosquitto broker** add-on — started. This add-on takes its broker
   credentials from it automatically; you will not type them anywhere.
2. **MariaDB** add-on — started, with a database for this add-on to use
   (see [Database](#database)).
3. **Turzi Bridge** — the HA integration, connected and exposing the entities
   you want reachable. Nothing here can see an entity the bridge does not
   publish.

## Configuration

### `house_id` (required)

The topic namespace the bridge was enrolled with. Everything this add-on reads
and publishes lives under `house/<house_id>/`.

If you get it wrong, nothing breaks loudly — the add-on starts, connects, and
reports zero entities, because it is listening to a namespace nobody publishes
to. Check `entities_known` on `/health` after starting.

### `api_keys` (required)

One `label:secret` entry per calling system:

```yaml
api_keys:
  - "acme-access-control:a-long-random-secret-at-least-16-chars"
```

The **label is not decoration**. It is stamped into every command as the actor,
so it appears in this add-on's log *and* in the Home Assistant logbook next to
the door that opened. Name it after the system, not `key1`.

Generate secrets with something like `openssl rand -hex 32`. The field rejects
anything under 16 characters, and commas cannot appear in a secret.

### `allowed_entities` (strongly recommended)

```yaml
allowed_entities:
  - cover.garage
  - lock.front_door
```

**Leave this empty and the caller can reach every entity the bridge exposes** —
on a real building, every door in it. The Mosquitto add-on's credentials are
broad by design, so this list is the only thing scoping what the external
system can touch. Set it.

To discover entity ids, start the add-on with the list empty and read
`GET /api/v1/entities`, then narrow it and restart.

### `allowed_domains`

Defaults to the same domains the Turzi v2 API relays (`lock`, `cover`,
`alarm_control_panel`, `light`, `switch`, `climate`, …). Set it only to narrow
further.

### `mqtt_host`, `mqtt_port`, `mqtt_tls`, `mqtt_username`, `mqtt_password`

Leave empty and the broker comes from the Mosquitto add-on through the
Supervisor, which is right whenever the bridge publishes to this machine.

Set them when it does not. A building enrolled against a cloud broker publishes
there, not to a co-located Mosquitto — and pointed at the wrong broker this
add-on connects happily, subscribes successfully, and sees nothing at all
forever. `entities_known: 0` on `/health` with a `house_id` you know is correct
is what that looks like.

Check which broker the bridge uses under Settings → Devices & Services →
turzi Bridge before assuming they share one.

### `database`, `db_url`

`database` is the MariaDB database name, default `turzi_external_api`. Host and
credentials come from the MariaDB add-on through the Supervisor.

`db_url` bypasses that entirely — set it to a full
`mysql://user:password@host:3306/dbname` if you would rather point somewhere
else, or if the discovered user has no rights on your database.

### `confirm_timeout_ms`, `log_requests`

How long a command waits for the bridge's acknowledgment and state echo before
answering `accepted` (default 4000 ms), and whether to log every HTTP request.

## Database

Add a database for this add-on in the **MariaDB add-on's** configuration, and a
login with rights on it. If the user the Supervisor hands out has no rights on
`turzi_external_api`, the add-on will fail to start with a permissions error
from MariaDB — set `db_url` to a user that does, and you are past it.

Three tables are created on first start:

| Table | What it holds |
|---|---|
| `command_log` | Every command this add-on issued: who, what, when, and how it ended. |
| `state_log` | Every state the bridge published — including changes this API did not cause, which is the only way a wall button or an HA automation is visible. |
| `availability_log` | When the bridge went away and came back, so a gap in the state log can be explained. |

Nothing prunes them. `state_log` is the one that grows; if the box is small,
delete old rows on a schedule and leave the other two alone — they are small,
and they are the ones that answer "who opened this door".

## Using it

The API listens on port **8080**. Leave the port closed unless the external
system needs to reach it over the LAN, and put a reverse proxy in front if it
has to cross anything untrusted — the add-on speaks plain HTTP, and the API
keys open doors.

```bash
# What can I see?
curl -H "Authorization: Bearer $KEY" http://homeassistant.local:8080/api/v1/entities

# Open a gate
curl -X POST -H "Authorization: Bearer $KEY" \
  http://homeassistant.local:8080/api/v1/entities/cover/garage/open

# Anything else Home Assistant can do
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"set_cover_position","parameters":{"position":70}}' \
  http://homeassistant.local:8080/api/v1/entities/cover/garage/command

# Who opened what
curl -H "Authorization: Bearer $KEY" \
  "http://homeassistant.local:8080/api/v1/log/commands?limit=20"
```

A command does not return until the bridge has acknowledged it and the entity's
new state has come back, so `"status": "confirmed"` means the thing actually
moved. Full endpoint and status-code reference in the
[repository README](https://github.com/turzi-org/turzi-external-api).

## Bridge version

The add-on works out which protocol the core speaks by watching, not by asking
you. A v1.1 bridge publishes a retained availability topic; a v1.0 one has no
such topic, so five seconds of silence after connecting is the answer.

`GET /health` reports the verdict as `protocol`: `v1.1`, `v1.0-assumed`, or
`detecting` in the first few seconds.

Against a **v1.0 core** it degrades rather than failing, and says so once in the
log at startup. Commands publish at QoS 2 instead of QoS 1 — a v1.0 core does
not deduplicate on `command_id`, so a QoS 1 redelivery could actuate a door
twice — and a command is confirmed from the state echo alone, since no
acknowledgment is coming. Three things are genuinely unavailable until the
bridge is upgraded:

- **Rejections are invisible.** Without acks, a command the core refused looks
  exactly like one it never received.
- **No offline detection.** With no availability topic, `HOUSE_OFFLINE` can
  never fire; commands publish into the void and come back `accepted`.
- **No attribution.** `state_log.origin_type` is `unknown` on every row, so the
  log cannot tell this API apart from a resident or an automation.

That last one is why command responses carry an `attribution` field:
`command_id` means the core echoed our own id back, which is proof this command
caused this change; `inferred` means we matched the first change on the entity
while the command was in flight, which is the best a v1.0 core allows and is
not proof — a wall button pressed in the same moment would look identical.

## Troubleshooting

**`protocol` says `v1.0-assumed` but the bridge is 2026.8.0 or newer.** The
bridge is not publishing its availability topic. Either it has not finished
connecting, or its broker credential lacks publish rights on
`house/{id}/availability`.

**`entities_known` is 0 but `mqtt_connected` is true.** Read the add-on log
first — it diagnoses this case itself, naming either the namespaces the broker
does carry or the fact that it carries none. Three causes:

1. The `house_id` does not match what the bridge was enrolled with — compare it
   against the bridge's config entry title.
2. **The bridge is on a different broker.** `mqtt_connected: true` only means
   this add-on reached *its* broker; it says nothing about where the bridge
   publishes. If the building is enrolled against a cloud broker, set
   `mqtt_host` and friends above.
3. The entity is not exposed by the bridge — check its Exposure & privacy
   options.

**Every command returns 503 `HOUSE_OFFLINE`.** The bridge has stopped
publishing its availability — that is the bridge or HA, not this add-on.
`BROKER_UNREACHABLE` is the other one, and means the opposite: our own link to
Mosquitto is down.

**The add-on restarts on boot, then settles.** Expected. Home Assistant does
not order add-on startup, so if MariaDB is still coming up this one retries for
up to a minute before giving up.

**Commands work but nothing is logged.** MariaDB went away after startup.
Logging is deliberately best-effort — a database problem must not be able to
strand someone at a gate — so doors keep working and the add-on log says so.
