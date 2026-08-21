# Changelog

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
