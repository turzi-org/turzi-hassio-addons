# Turzi Bridge Installer

Puts the Turzi bridge into this Home Assistant and replaces it when a new
version of this add-on comes. The bridge is what lets a Turzi community see and
operate what this Home Assistant has.

Most installations never open this page: the Turzi Stack installs this add-on
and connects the bridge by itself when a building is set up.

## What it does

When it starts, it compares the bridge it carries with the one in
`custom_components/turzi_bridge`:

- none there, or an older one: it puts its own in place and restarts Home
  Assistant, which is the only way Home Assistant loads it;
- the same one: nothing;
- a newer one: nothing. Somebody chose it, and it stays.

Then it stays running and does nothing. It has to: an add-on that is not
running is not started again after an update, and starting is when the new
bridge is put in place.

It does not connect the bridge to Turzi. That is done by the Turzi Stack, or by
hand in **Settings → Devices & services → Add integration → turzi Bridge**.

## Watchdog

Keep Home Assistant's **Watchdog** switch for this add-on on. The add-on has
to be running for an update of it to put the new bridge in place, and with the
watchdog on Home Assistant starts it again if it ever stops. The Turzi Stack
turns it on when it installs the add-on; installed by hand, turn it on
yourself.

## Settings

**Restart Home Assistant when the bridge changes**, on by default. Turn it off
to restart at a moment of your choosing: the new bridge runs after that restart.

**Turzi Stack address**, written by the Turzi Stack when it installs this
add-on. Nothing uses it yet. Leave it as it is.

## Updates

The first three numbers of this add-on's version are the bridge it carries.
Updating the add-on updates the bridge. Home Assistant's own *Auto update*
switch for this add-on is off unless you turn it on, so nothing restarts by
itself.

Where a Turzi Stack installed it, the plan is for the Stack to decide when the
bridge is replaced, building by building and at a chosen hour, and for this
add-on to ask it. That is what the Stack's address is for. Until then, updates
are pressed here.

## If the bridge was installed with HACS

Remove it from HACS first, or leave this add-on out: two things replacing the
same folder will undo each other's work.

## Removing it

Uninstalling this add-on leaves the bridge where it is. To remove the bridge,
delete its entry in **Devices & services** and the folder
`custom_components/turzi_bridge`, then restart Home Assistant.
