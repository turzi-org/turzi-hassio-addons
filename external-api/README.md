# Turzi External System API

A small REST API that lets an external system read and operate the entities a
Home Assistant core exposes — doors, gates, locks, lights, climate — by
speaking the **Turzi Protocol v1.1** over MQTT, and records every action and
every observed state in MariaDB as it goes.

It exists because Turzi v2 is not live yet. When it is, its API will expose the
same devices to external systems with real identity, per-entity authorization
and the community ledger behind them, and this service goes away. Until then it
runs **in parallel**: separate deployment, separate database, separate broker
credential, no code shared at runtime with v2 and no dependency on it.

What it *does* share is v2's protocol code. The command/ack/state-echo logic in
[`src/mqtt/turzi-client.ts`](src/mqtt/turzi-client.ts)
and the TTL policy in
[`src/mqtt/ttl-policy.ts`](src/mqtt/ttl-policy.ts) are
adapted from the v2 API's `modules/smart-home/`, deliberately, so the two never
drift on the wire.

## Two ways to run it

**As a Home Assistant add-on** — the intended deployment. Add
`https://github.com/turzi-org/turzi-hassio-addons` under *Settings → Add-ons →
Add-on store → ⋮ → Repositories* and install *Turzi External System API*.
Broker and database credentials come from the Supervisor, so the only things to
configure are the house, the API keys and the entity allowlist. See
[`DOCS.md`](DOCS.md) — that is also what the add-on's Documentation tab shows.

**As a plain container** — `docker compose up -d --build`, with the bundled
MariaDB and an `.env`. Same image, same entrypoint: `run.sh` detects the
absence of a Supervisor and uses the environment as given.

## How it works

As an add-on, all of this is one box and nothing crosses a network:

```
external system ──HTTP──> add-on ──MQTT──> Mosquitto <──MQTT── Turzi bridge ──> Home Assistant
                            │
                            └──> MariaDB (command_log, state_log, availability_log)
```

- **Commands** are published to `house/{id}/command/{domain}/{slug}` with a
  `command_id`, an `issued_at` and a TTL. The service then waits for the
  bridge's ack on `house/{id}/ack/{command_id}` and for the entity's state echo,
  so an HTTP response reports what actually happened rather than what was sent.
- **State** is not polled. The bridge publishes every exposed entity **retained**,
  so subscribing gets a full snapshot at connect and every change after it. Reads
  are served from that cache, and every payload is written to the log — including
  changes this API did not cause, which is the only way a physical button press
  or an HA automation is visible at all.
- **Availability** comes from the bridge's retained LWT topic. A house that is
  offline makes commands fail fast instead of disappearing into a broker.

## Broker credentials

**As an add-on this section does not apply** — the Mosquitto add-on's
credentials come from the Supervisor and already permit publishing. Note the
consequence: those credentials are broad, so `allowed_entities` is the only
thing scoping what the caller can reach. Set it.

For a standalone deployment against a Turzi cloud broker, read on.

This service is a **platform publisher**, not a client. In cloud mode Turzi
clients hold strictly subscribe-only credentials and are not allowed to publish
commands (PROTOCOL.md §4), so a client credential will authenticate here and
then silently fail to actuate anything.

The narrowest role that works, scoped to one house — for Mosquitto with the
dynamic security plugin:

```bash
mosquitto_ctrl dynsec createRole external-api
mosquitto_ctrl dynsec addRoleACL external-api publishClientSend    'house/YOUR_HOUSE_ID/command/#'          allow
mosquitto_ctrl dynsec addRoleACL external-api publishClientSend    'house/YOUR_HOUSE_ID/app/command/reload' allow
mosquitto_ctrl dynsec addRoleACL external-api subscribePattern     'house/YOUR_HOUSE_ID/state/#'            allow
mosquitto_ctrl dynsec addRoleACL external-api subscribePattern     'house/YOUR_HOUSE_ID/availability'       allow
mosquitto_ctrl dynsec addRoleACL external-api subscribePattern     'house/YOUR_HOUSE_ID/ack/#'              allow
mosquitto_ctrl dynsec addRoleACL external-api publishClientReceive 'house/YOUR_HOUSE_ID/#'                  allow
mosquitto_ctrl dynsec createClient external-api
mosquitto_ctrl dynsec addClientRole external-api external-api
```

`publishClientReceive` is the one people forget: without it the subscriptions
are accepted and no message is ever delivered, which looks exactly like a house
that publishes nothing.

## Running it

```bash
cp .env.example .env   # TURZI_HOUSE_ID, MQTT_*, MARIADB_*, API_KEYS
docker compose up -d --build
```

That brings up the API and a MariaDB beside it. To use a database you manage
yourself, set `DATABASE_URL` and drop the `db` service.

Locally, without Docker:

```bash
npm install && npm run dev
```

## Configuration

Every setting is an environment variable, and a bad one fails at **startup**
rather than at the first request. See [`.env.example`](.env.example) for the
full list with comments.

| Variable | Required | Notes |
|---|---|---|
| `TURZI_HOUSE_ID` | ✅ | Topic namespace the bridge was enrolled with. In Turzi Cloud this is the community id. |
| `MQTT_HOST` | ✅ | Broker host. `MQTT_PORT` defaults to 8883 with TLS, 1883 without. |
| `MQTT_TLS` | | Default `false`. Turn it on for anything that leaves a trusted network. |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | | The platform-ACL credential above. |
| `DATABASE_URL` | ✅ | Assembled by docker-compose from `MARIADB_PASSWORD`; supplied by the Supervisor in add-on mode. |
| `API_KEYS` | ✅ | `label:secret` pairs, comma separated. Minimum 16 characters each. |
| `ALLOWED_DOMAINS` | | Defaults to the same set the v2 API relays. |
| `ALLOWED_ENTITIES` | | Full entity ids. Empty means every exposed entity. **Set this.** |
| `COMMAND_CONFIRM_TIMEOUT_MS` | | Default 4000. How long a request waits for ack + echo. |

### Authentication

Bearer API keys. The **label** is not decoration — it is stamped into every
command's `metadata.user_name`, so it appears both in this service's
`command_log` and in the Home Assistant logbook. Name keys after the system
that will be calling (`acme-access-control`, not `key1`).

```
Authorization: Bearer <secret>
```

Keys are compared as SHA-256 digests in constant time, and every configured key
is checked on every request, so neither the key's length nor which key matched
is observable in the response time. Revoke by redeploying without the key.

## API

All endpoints are under `/api/v1` and require a bearer token. `/health` does not.

### Read

| Method | Path | |
|---|---|---|
| `GET` | `/api/v1/entities` | Every exposed entity. `?domain=cover` to filter. |
| `GET` | `/api/v1/entities/:domain/:slug` | One entity. |

```json
{
  "entity_id": "cover.garage",
  "domain": "cover",
  "slug": "garage",
  "state": "closed",
  "attributes": { "current_position": 0, "device_class": "garage" },
  "last_changed": "2026-08-19T20:49:07.612Z",
  "observed_at": "2026-08-19T20:49:08.585Z",
  "verified": true,
  "house_availability": "online"
}
```

`attributes` is passed through whole: the protocol treats attributes as the
**capability surface**, so `hvac_modes`, `device_class` and friends are how a
caller works out which controls an entity actually supports.

`verified` is the field to check before acting on a state. It is `false` when
the house is offline **or** when this service has lost its own broker link —
either way the cached state is stale-but-displayable, not current.

### Command

| Method | Path | |
|---|---|---|
| `POST` | `/api/v1/entities/:domain/:slug/:verb` | `open`, `close`, `stop`, `lock`, `unlock`, `on`, `off` |
| `POST` | `/api/v1/entities/:domain/:slug/command` | Anything else |
| `POST` | `/api/v1/refresh` | Ask the bridge to republish everything (rate limited) |

```bash
curl -X POST -H "Authorization: Bearer $KEY" \
  https://host/api/v1/entities/cover/garage/open

curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"set_cover_position","parameters":{"position":70}}' \
  https://host/api/v1/entities/cover/garage/command
```

`command` takes either `action` (`"open_cover"`) or a fully qualified
`command` (`"cover.open_cover"`, which must match the domain in the URL).

Both return the same envelope:

```json
{
  "status": "confirmed",
  "command_id": "8c23051a-…",
  "state": "opening",
  "reason": null,
  "timings": { "publish_ms": 3, "ack_ms": 4, "state_echo_ms": 157 }
}
```

| `status` | HTTP | Meaning |
|---|---|---|
| `confirmed` | 200 | The bridge executed it **and** the entity's new state came back. |
| `executed` | 200 | Executed, no state change — the no-op case (unlocking an unlocked door). |
| `accepted` | 202 | Published, nothing heard within the confirm window. It may still happen. |
| `failed` | 4xx/5xx | Rejected. `reason` says why. |

`failed` maps to a status code by reason: `entity_not_exposed` and
`entity_unavailable` → 404, `unsupported_command` and `invalid_parameters` →
400, `expired` → 504, `broker_unreachable` → 503, everything else → 502.

Refusals that never reach the broker: 401 unauthenticated, 403
`DOMAIN_NOT_ALLOWED` / `ENTITY_NOT_ALLOWED`, 503 `BROKER_UNREACHABLE` (our link)
or `HOUSE_OFFLINE` (theirs). Those two are kept distinct on purpose — they send
you to different buildings.

### Log

| Method | Path | Filters |
|---|---|---|
| `GET` | `/api/v1/log/commands` | `entity_id`, `actor`, `status`, `since`, `limit` |
| `GET` | `/api/v1/log/states` | `entity_id`, `domain`, `origin`, `since`, `limit` |
| `GET` | `/api/v1/log/availability` | `since`, `limit` |

Read-only. There is no endpoint that deletes or edits a record.

## What gets logged

Three tables, created on boot ([`src/db/schema.ts`](src/db/schema.ts)):

**`command_log`** — one row per command this service issued, written *before*
publishing and updated when it settles. A row left at `status = 'issued'` is an
attempt whose outcome is unknown, which for a door is a materially different
fact from no attempt at all.

**`state_log`** — every state payload the bridge published, whoever caused it.
`origin_type` distinguishes `turzi` (a command through the protocol) from
`core_user`, `automation` and `physical`, and `origin_command_id` joins back to
`command_log` to name the actor.

**`availability_log`** — house reachability, so a gap in the state log can be
explained rather than guessed at.

Both logs are deduplicated **in the database, not in memory**, because the
thing being deduplicated is a retained-message replay that arrives precisely
when process memory has just been wiped — on reconnect and on restart. States
are keyed on `(house, entity, last_changed, state, hash(attributes))`;
availability only records a row when it differs from the house's previous one.

The attribute hash is a deliberate difference from the v2 ledger, which
deduplicates on `last_changed` alone. v2 records transitions; this service
records everything, and a cover travelling from 0 to 100 holds one
`last_changed` across every intermediate position. Hashing the attributes keeps
the movement and still collapses an identical replayed payload.

## Deliberate limitations

- **One house per deployment.** The topic namespace is fixed by
  `TURZI_HOUSE_ID`. Serve a second community by running a second container.
- **Log writes never block a command.** Same rule as the v2 API. Under a
  database outage this service keeps operating doors and loses the record of
  having done so, complaining loudly in the log. Startup still waits for the
  database (retrying for a minute, because Home Assistant does not order add-on
  startup), so the outage has to begin *after* boot for that window to open.
- **Authorization is per key, not per person.** A key can reach every entity in
  `ALLOWED_ENTITIES`. There is no notion of who is holding it. That is one of
  the things v2 fixes.
- **No TLS termination.** Put it behind nginx or a reverse proxy. It speaks
  plain HTTP, and the API keys open doors.
- **Log writes are best-effort, by design.** See above — under a database
  outage doors keep working and the record is lost. `Recorder.write` is the one
  place that rule lives if you would rather refuse the door than lose the
  record.
