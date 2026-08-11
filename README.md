# Turzi Home Assistant Add-ons

Add-on repository for buildings running Turzi on Home Assistant OS.

## Install

Settings → Add-ons → Add-on Store → ⋮ → **Repositories** → add:

```
https://github.com/turzi-org/turzi-hassio-addons
```

## Add-ons

- **[Turzi Building Relay](building-relay/)** — the building's media
  relay for the Turzi local media path: serves signed camera
  snapshot/MP4/MSE media on port 443 of the HA host, so TCM viewers on
  the building LAN never touch the cloud relay. Auto-provisions with a
  single-use key from the TCM and keeps its certificates current on
  its own.
