# Changelog

## 1.1.1

The add-on no longer builds its own image. It pulls
`ghcr.io/turzi-org/building-relay:<version>`, built from
`turzi-apps/infra/building-relay` — the same image a plain Docker
install runs. `Dockerfile`, `nginx.conf.tmpl` and `run.sh` are gone from
this directory.

They were copies, and copies drift. The fix that stopped `/streams`
returning each camera's RTSP URL — password included — went into
turzi-apps, and this add-on carried on serving them. That is what this
release actually delivers; the packaging change is how it stops
happening again.

Nothing about configuring the add-on changes.

## 1.1.0

Local media path: signed-URL relay for LAN camera viewing, provisioned
by enrollment from the TCM.
