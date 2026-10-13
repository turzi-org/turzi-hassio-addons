# Turzi Home Assistant Add-ons

Add-on repository for buildings running Turzi on Home Assistant OS.

## Install

Settings → Add-ons → Add-on Store → ⋮ → **Repositories** → add:

```
https://github.com/turzi-org/turzi-hassio-addons
```

## Add-ons

- **[Turzi External System API](external-api/)** — REST API letting an
  external system (an access-control panel, a BMS, a customer's own software)
  read and operate the entities this Home Assistant exposes, over the Turzi
  Protocol on MQTT. Records every action and every observed state in MariaDB.
  A stopgap until the Turzi v2 API offers the same thing with real identity.

- **[Turzi Bridge Installer](bridge-installer/)** — puts the Turzi bridge
  into this Home Assistant and keeps it there. A Turzi Stack in the building
  installs it by itself and says when a new bridge goes in; it can also be
  installed by hand.

## Retired

- **Turzi Edge Media** (the building relay) was removed on 2026-10-13. A
  building's camera relay now runs on its Turzi Stack, with the Stack's own
  certificate, and is no longer installed in Home Assistant. A Home Assistant
  that still has it should uninstall it: it can no longer enrol, and nothing
  here updates it.
