# Turzi External System API

Lets an external system — an access-control panel, a BMS, a customer's own
software — read and operate the entities of the Home Assistant it runs inside,
over a plain REST API. Every action and every observed state is written to
MariaDB, so the log can answer who opened which door and when.

This is a stopgap. When Turzi v2 goes live, its API exposes the same devices to
external systems with real identity and per-entity authorization, and this
add-on is removed.

## How it talks to Home Assistant

Directly, through the Supervisor's proxy to Home Assistant's WebSocket API —
**not** through the Turzi bridge.

The bridge belongs to the Turzi app. It publishes to whichever broker the app
uses, which for an enrolled building is a cloud broker. Following it there
would make opening a gate from inside the building depend on the internet, to
reach a device on the same machine. Going direct leaves the bridge completely
alone — it keeps serving the app, unchanged and unaware — while this path stays
local.

It also attributes better. Home Assistant returns a **context id** for every
service call and stamps the same id on the state change it causes, so a
confirmation is proof rather than inference:

| `origin_type` in `state_log` | What caused it |
|---|---|
| `external_api` | This API. Joins to `command_log` for the key that did it. |
| `core_user` | Someone acting in Home Assistant — the UI, a script run by a person, another token. |
| `automation` | An automation, script or scene inside Home Assistant. |
| `unattributed` | No context to attribute. Genuinely device-originated changes land here, and so do service calls made without a user — **including the Turzi bridge's, so anything done from the app appears here**. |

## Before you install

- **MariaDB** add-on, started, with a database for this add-on (see below).
- The entities you want reachable must exist in Home Assistant. That is the
  whole requirement — no broker, no bridge, no exposure list to maintain.

## Configuration

### `house_id` (required)

A label recorded on every log row, identifying this building. It no longer has
to match anything.

### `api_keys` (required)

One `label:secret` entry per calling system:

```yaml
api_keys:
  - "acme-access-control:a-long-random-secret-at-least-16-chars"
```

The **label is not decoration**. It is stamped on every command as the actor,
so it is what `command_log` reports when someone asks who opened the gate. Name
it after the system, not `key1`. Generate secrets with `openssl rand -hex 32`;
anything under 16 characters is rejected, and a secret cannot contain a comma.

### `allowed_entities` (strongly recommended)

```yaml
allowed_entities:
  - cover.porton_demo
  - lock.front_door
```

This is the security boundary. Home Assistant exposes everything it knows, so
leaving this empty falls back to `allowed_domains` — every lock, cover, light
and alarm panel in the building.

It also decides **what gets logged**. In a real building the state stream
includes sensors changing every few seconds; recording all of it would bury the
door events this exists to keep. The log covers exactly what the API is
responsible for.

### `allowed_domains`

Used only when `allowed_entities` is empty. Defaults to the domains the Turzi
v2 API relays (`lock`, `cover`, `alarm_control_panel`, `light`, `switch`,
`climate`, …).

### `database`, `db_url`

`database` is the MariaDB database name, default `turzi_external_api`. Host and
credentials come from the MariaDB add-on through the Supervisor. `db_url`
bypasses that entirely — set it to a full
`mysql://user:password@host:3306/dbname` to point elsewhere, or if the
discovered user has no rights on your database.

### `confirm_timeout_ms`, `log_requests`

How long a command waits for the resulting state change before answering
`executed` (default 4000 ms — normally it resolves in single-digit
milliseconds), and whether to log every HTTP request.

## Database

Add the database and a login with rights on it in the **MariaDB add-on's**
configuration. Three tables are created on first start:

| Table | What it holds |
|---|---|
| `command_log` | Every command this add-on issued: who, what, when, and how it ended. |
| `state_log` | Every state change of a permitted entity, whoever caused it. |
| `availability_log` | Retained from an earlier design and no longer written; Home Assistant's reachability is this add-on's own connection. |

Nothing prunes them. `state_log` is the one that grows.

## Using it

The API listens on port **8080**. It speaks plain HTTP, so put a reverse proxy
in front before exposing it to a customer.

```bash
# What can I see?
curl -H "Authorization: Bearer $KEY" http://homeassistant.local:8080/api/v1/entities

# Open a gate
curl -X POST -H "Authorization: Bearer $KEY" \
  http://homeassistant.local:8080/api/v1/entities/cover/porton_demo/open

# Anything else Home Assistant can do
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"action":"set_cover_position","parameters":{"position":70}}' \
  http://homeassistant.local:8080/api/v1/entities/cover/porton_demo/command

```

To see what has been opened and by whom, use the **Gate log** panel in the
sidebar rather than an API call — see below.

A command does not return until the resulting state change arrives, so
`"status": "confirmed"` with `"attribution": "context_id"` means the device
actually moved and that this call is what moved it. `"executed"` means Home
Assistant ran the service and nothing changed — closing an already-closed gate.

## Seeing the log

The add-on adds a **Gate log** panel to the Home Assistant sidebar. Home
Assistant authenticates it, so there is no second password, and it is reachable
only that way — the port it uses is deliberately not published, so the log
never appears on the address the integrator calls.

It shows what was commanded and what the gate did:

- **Commands issued through this API** — when, by which key, the outcome, how
  long the gate took to respond, and the controller's own words when something
  failed.
- **State changes** — *including the ones this API did not cause*. That is the
  point of keeping them: it is how you tell an opening you are responsible for
  from one a resident caused, and how a gap gets explained.

`unattributed` in the *Caused by* column means the change carried no Home
Assistant context. The gate's own movement ticks land there, and so does
anything done from the Turzi app.

The same data is available as JSON at `/api/v1/log/commands` and
`/api/v1/log/states` with an API key, for reconciling against your own records.
Do not expose those two through a public proxy: they carry every use of the
gate, including residents', and an integrator holding a key would see all of
it.

## Exposing it to an external system

Put a reverse proxy in front — the add-on speaks plain HTTP and its API keys
open doors.

**The caller must be a server, not a mobile app.** A key shipped inside an app
is extractable from the binary in minutes, and no amount of TLS changes that,
because nothing is being broken: the credential was handed over. If the
integrator's users act through a phone, their backend authenticates the user
and calls this API; the key stays on a machine nobody can decompile.

That also buys the strongest control available here. A backend has a fixed
egress IP, so the proxy can refuse everyone else outright.

With Nginx Proxy Manager, the **Details** tab is scheme `http`, the Home
Assistant host, port `8080`, and *Block Common Exploits*. Take the certificate
from the **SSL** tab (Let's Encrypt), with *Force SSL*, *HTTP/2* and *HSTS*.
Then in **Advanced**:

```nginx
allow 203.0.113.10;   # the integrator's egress IP
deny all;

limit_req zone=turzi_api burst=20 nodelay;
limit_req_status 429;

# Unauthenticated, and publishes house_id, core version and entity count.
location = /health {
    deny all;
}

# Every use of the gate, residents' included. Yours to read, not theirs.
location /api/v1/log/ {
    deny all;
}
```

These are all server-context directives, so they layer on top of the proxy
configuration NPM generates rather than replacing it — do not re-declare a
`location` with its own `proxy_pass`, or the headers NPM injects are silently
lost.

The rate-limit zone cannot go in that tab, because `limit_req_zone` is only
valid in the `http` context. Create `/data/nginx/custom/http.conf` inside the
proxy container and restart it:

```nginx
limit_req_zone $binary_remote_addr zone=turzi_api:10m rate=5r/s;
```

Without that file the Advanced tab refuses to save, and the error names the
syntax rather than the missing zone.

Finally: forward only 80 and 443 to the proxy. A port-forward straight to 8080
alongside it bypasses every line above.

### Polling is cheap

State is served from an in-memory cache kept current by Home Assistant's event
stream, so reading an entity costs no round trip to Home Assistant and no
device traffic. An integrator polling every few seconds is fine; they do not
need to build change subscriptions to avoid load.

## Troubleshooting

**`entities_known` is 0.** Nothing in `allowed_entities` exists in Home
Assistant. Check the entity ids under Developer tools → States.

**Commands return 503 `HOME_ASSISTANT_UNAVAILABLE`.** The add-on lost its
connection to Home Assistant Core — usually Core restarting. It reconnects on
its own with backoff and re-reads all states when it does.

**A command returns 400 with a message from Home Assistant.** That is Home
Assistant's own refusal passed through verbatim: an unknown service, a bad
parameter, a platform that raised. It is the real reason, not a guess.

**Everything shows as `unattributed` in the log.** Those changes carry no Home
Assistant context — device-originated, or a service call made without a user.
Actions taken from the Turzi app arrive this way, because the bridge calls
services with a bare context.

**Commands work but nothing is logged.** MariaDB went away after startup.
Logging is deliberately best-effort — a database problem must not be able to
strand someone at a gate — so doors keep working and the add-on log says so.
