# Changelog

## 2.2.0

- **Times are shown in the building's timezone**, read from Home Assistant's
  own configuration rather than the viewer's browser. A gate opening is an
  event at the gate; describing it in the timezone of whoever happens to be
  reading would be wrong the moment the log is read from anywhere else. The
  zone is named above the tables, and the column no longer claims UTC.
- **Date and time range filtering** — Today, last 24 hours, 7 or 30 days, or a
  custom window typed in that same building time. The summary cards follow the
  range, so they cannot contradict the rows beneath them, and the view says so
  when a range holds more rows than the row limit shows.

## 2.1.1

- `/health` now reports the running `version`. Confirming that an update
  actually landed previously meant opening the Home Assistant UI; it is now a
  question the add-on answers itself. Read from `config.yaml` at boot, so there
  is one place the version lives and nothing to keep in sync.

## 2.1.0

- **A Gate log panel in the Home Assistant sidebar.** Commands and state
  changes, who caused each one, and how long the gate took — the log was being
  recorded from the first release but could only be read with curl or SQL.
- Served through Home Assistant ingress on its own port, so HA authenticates it
  and it is never reachable on the address the integrator calls. Read-only by
  construction: it issues SELECTs and offers no route that writes.

## 2.0.1

- Asking for a service an entity does not support now returns 400 rather than
  502. Home Assistant calls it a validation error and it is the caller's
  mistake; 502 pointed at the gateway and sent anyone debugging to the wrong
  layer.

## 2.0.0

**Talks to Home Assistant directly instead of through the Turzi bridge.**

The bridge belongs to the Turzi app: it publishes to whichever broker the app
uses, which for an enrolled building is a cloud broker. Reaching a device on
the same machine by way of the internet is the wrong dependency for access
control, and pointing the bridge at a local broker instead would have broken
the app. Going direct leaves the bridge completely untouched.

Everything the MQTT path needed is gone with it: no broker, no credentials, no
protocol version to detect, no retained-message replay and therefore none of
the deduplication that required.

Attribution is now proof rather than inference. Home Assistant returns a
context id for each service call and stamps it on the resulting state change,
so `state_log.origin_type` separates `external_api` from `core_user`,
`automation` and `unattributed` — the last covering changes with no context,
which includes anything done from the Turzi app.

**Breaking:**

- `mqtt_host`, `mqtt_port`, `mqtt_tls`, `mqtt_username` and `mqtt_password` are
  removed. The Mosquitto add-on is no longer required at all.
- `house_id` is now only a label recorded on the log; it no longer selects a
  topic namespace and does not have to match the bridge.
- `allowed_entities` now decides what is logged as well as what is reachable,
  because Home Assistant exposes every entity it knows rather than a curated
  set. Set it.
- Command responses report `attribution: "context_id"` or nothing; the v1.0
  `inferred` value no longer exists. Timings are `call_ms` / `state_echo_ms`.
- `/health` reports `home_assistant_connected` and `core_version` in place of
  the MQTT and protocol fields.

## 1.2.1

- When the add-on has no entities after startup, it now says why. An empty
  cache has three causes that look identical from outside — wrong `house_id`,
  wrong broker, or nothing exposed — so it listens across every namespace on
  its broker and reports which one it is: the namespaces that *do* exist (a
  `house_id` mismatch), or none at all (the bridge is publishing somewhere
  else).

## 1.2.0

- The broker is now configurable (`mqtt_host`, `mqtt_port`, `mqtt_tls`,
  `mqtt_username`, `mqtt_password`). Previously it was always the Mosquitto
  add-on on this machine, which is wrong whenever the bridge publishes to a
  cloud broker instead: the add-on would connect, subscribe, and see nothing
  forever with no way to correct it. Leave empty to keep using the Supervisor's
  Mosquitto.
- `mqtt` and `mysql` are declared `want` rather than `need`, so a deployment
  using an external broker or database is not forced to install add-ons it does
  not use.

## 1.1.2

**Fixes a startup failure: the add-on could not read its own configuration.**

- Run as root, like every other add-on in this repository. The Supervisor
  writes `/data/options.json` owned by root with mode 600, so the previous
  `USER node` left `jq` denied on every option.
- Report the real reason startup failed. The error above surfaced as
  `Missing required option: house_id`, which was false: `jq`'s stderr was
  suppressed and any failure was read as an absent option. The options file is
  now checked before any option is read — unreadable, and it says so along with
  the uid it is running as; malformed, and it prints the actual parse error.

## 1.1.1

- Trim `house_id`. A pasted id with a stray space was accepted verbatim and
  produced topics like `house/ abc /state/#`, which subscribe cleanly, match
  nothing, and leave the add-on running with zero entities and no error.
- Say where to find `house_id` when it is missing: the Turzi Bridge names its
  config entry `turzi Bridge for Home Assistant — <house_id>`.

## 1.1.0

**Works against older bridges instead of quietly misbehaving.**

- Detect which protocol the core speaks, by watching rather than by
  configuration. A v1.1 bridge publishes a retained availability topic; a v1.0
  one has none, so five seconds of silence is the answer. `GET /health` reports
  the verdict as `protocol`.
- Against a v1.0 core, publish commands at QoS 2 rather than QoS 1 — QoS 1 is
  only safe because a v1.1 core deduplicates on `command_id`, and without that
  a redelivery could actuate a door twice — and confirm from the state echo
  alone, since no acknowledgment is coming. Previously every command waited the
  full confirm window and returned `accepted`.
- Command responses carry `attribution`. `command_id` means the core echoed our
  own id back, which is proof this command caused this change; `inferred` means
  it was matched by timing while the command was in flight, which is the best a
  v1.0 core allows and is not proof.

## 1.0.0

Initial release. A REST API letting an external system read and operate the
entities this Home Assistant exposes, over the Turzi Protocol on MQTT, with
every action and every observed state recorded in MariaDB.

- Broker and database credentials are discovered from the Supervisor
  (`mqtt:need`, `mysql:need`) rather than configured.
- Commands block until the bridge acknowledges and the entity's new state comes
  back, so `confirmed` means the device actually moved.
- `command_log`, `state_log` and `availability_log`, deduplicated in the
  database rather than in memory — retained state replays on every reconnect,
  which is exactly when process memory has just been cleared.
