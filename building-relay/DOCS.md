# Turzi Building Relay

The building's media relay (DEVICE_PROVIDERS.md §3.3 local media path)
as a Home Assistant add-on — for buildings where the "mini-PC" is a
Home Assistant OS machine running the Frigate add-on. Serves signed
snapshot/MP4/MSE camera media on **port 443** of this host so TCM
viewers on the building LAN never touch the cloud relay.

## Install

Settings → Add-ons → Add-on Store → ⋮ → **Repositories** → add
`https://github.com/turzi-org/turzi-hassio-addons`, then install
**Turzi Building Relay**.

## Configure

In the TCM: **Integraciones → Medios del edificio (LAN)** — set this
host's LAN IP and press *Generar clave de instalación*. Copy the two
values from the command it shows into the add-on configuration:

- `api_url` — e.g. `http://10.0.1.53:4000`
- `provision_token` — the single-use `rpt_…` key

Defaults for `frigate_upstream`/`go2rtc_upstream` fit the Frigate
add-on on the same host. Start the add-on.

It exchanges the key for the community's signing secret, the current
certificate bundle and a durable credential (all kept in the add-on's
private `/data`), then refreshes daily — renewed certificates arrive
on their own. The spent token can stay in the config; it's ignored
once a credential exists. To re-provision (new key), stop the add-on,
wipe its data (Rebuild/Uninstall), set the new key, start again.

## Verify

Open a camera in the TCM from a machine on the building LAN — media
requests appear in this add-on's Log tab, not on the cloud relay.
Unsigned requests return 410, tampered signatures 403.
