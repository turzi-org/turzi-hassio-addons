# Changelog

## 2026.10.6.1

The same bridge, 2026.10.6. New, where a Turzi Stack set this add-on up: it
asks the Stack before it replaces a bridge. Updating the add-on no longer
restarts Home Assistant by itself; the Stack says when the new bridge goes in,
checks that it comes back, and has the previous one put back if it does not.
Installed by hand, nothing changes.

## 2026.10.6

Carries the Turzi bridge 2026.10.6: an entity renamed in Home Assistant stays
the same entity for Turzi.

## 2026.10.5

Carries the Turzi bridge 2026.10.5, which can find its connection again with
its own credential: a Home Assistant that is already the building's
reconnects with no key.

## 2026.10.4

Carries the Turzi bridge 2026.10.4, which reaches a Turzi Stack in the
building over TLS: by its address, with its certificate verified for its
name. Needed where the Stack serves over TLS.

## 2026.10.3.1

The same bridge, 2026.10.3. New: the Turzi Stack that installs this add-on
writes its own address in it, for later (see the documentation).

## 2026.10.3

First version. Carries the Turzi bridge 2026.10.3.
