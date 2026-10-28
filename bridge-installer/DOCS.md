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

Then it stays running. It has to: an add-on that is not running is not started
again after an update, and starting is when the new bridge is put in place.

## Where a Turzi Stack set it up

It asks the Stack first, once a minute, and does what the Stack says:

- **install** the bridge this add-on carries, and restart Home Assistant. The
  bridge it replaces is kept;
- **wait**, and why: another part of the building is being updated, a call is
  in progress, the bridge this add-on carries is not the building's yet;
- **put the previous one back**, when the new bridge did not come back after
  the restart.

So updating this add-on does not restart Home Assistant by itself any more: it
brings the new bridge here, and the Stack chooses the moment. The bridge is
always the one this add-on carries; the Stack never sends one.

A Home Assistant with no bridge at all gets it at once, with or without the
Stack's answer. If the Stack does not answer, a bridge that is there stays as
it is. And whatever the Stack says, a newer bridge than this add-on's is never
replaced by it.

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
add-on. It is where this add-on asks before it replaces a bridge. Leave it as
it is; emptied, the add-on behaves as one installed by hand.

**Other Turzi integrations**: tick the ones this building uses (Akuvox,
Hikvision, alarmo, the thermostat) and they are put in beside the bridge when
the add-on starts, with one restart of Home Assistant if that changed
anything. You choose them here; the Turzi Stack never does. One you untick is
left where it is, since Home Assistant may still use it: remove it from
`custom_components` yourself. A newer copy put in with HACS stays, and stops
being updated from here. Only the installer image Turzi builds carries them;
built on this machine, the add-on carries the bridge alone and says so in its
log.

## Updates

The first three numbers of this add-on's version are the bridge it carries.

Installed by hand, updating the add-on updates the bridge, and Home Assistant
restarts. Home Assistant's own *Auto update* switch for this add-on is off
unless you turn it on, so nothing restarts by itself.

Where a Turzi Stack set it up, updating the add-on only brings the new bridge
here, and the Stack says when it goes in. So the Stack turns *Auto update* on
for this add-on: new bridges arrive by themselves, and none is put in place,
and Home Assistant is not restarted, until the Stack says so.

## If the bridge was installed with HACS

Remove it from HACS first, or leave this add-on out: two things replacing the
same folder will undo each other's work.

## Removing it

Uninstalling this add-on leaves the bridge where it is. To remove the bridge,
delete its entry in **Devices & services** and the folder
`custom_components/turzi_bridge`, then restart Home Assistant.
