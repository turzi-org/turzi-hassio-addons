# Changelog

## 1.9.4

Corrects a mistake in 1.9.3. That version changed the order of the first
enrolment so the durable credential was written only after the bundle was
accepted. It sounded safer and was worse: the key is single-use and is spent
before the answer reaches this box, so a bundle rejected for any reason left
nothing on disk against a key that no longer works — and the add-on then
restarted forever on a 401 until someone issued a new one.

The credential is written first again. With it on disk the box retries by
itself and comes up on its own once whatever was missing arrives, with no new
key and no visit. Anyone who installed 1.9.3 and saw it loop on a 401 needs a
fresh key from the TCM once; after that this version behaves.

The other half of 1.9.3 stands: a bundle missing its certificate is still
rejected before anything is written.

## 1.9.3

Three silent failures in the relay's own boot, all found by review rather than
by anyone noticing.

**Daily re-discovery had never run — in any installation.** The function that
looks for go2rtc and Frigate was defined below the daily-refresh loop that calls
it, and a shell only carries the functions defined before that loop forks. The
call failed as "command not found" and was swallowed. Only the check at start-up
ever worked, which is why discovery always appeared to be fine. So "the box looks
at boot and once a day" is true for the first time.

**A bundle without a certificate no longer leaves the relay half-configured.**
The certificate was validated midway through writing, so a rejected bundle had
already written part of its state.

**A rejected bundle is no longer permanent.** The durable credential was written
before the bundle was accepted, and the next boot decides whether to enrol purely
by whether that file exists — so a bad first bundle meant enrolment was skipped
forever and the relay never obtained a signing secret. The credential is now
written last, and the same key can simply be tried again.

## 1.9.2

Video-service discovery now probes the Docker host as well as the container's
own loopback. A relay on a bridge network — one that cannot take the host's
ports, which is every developer workbench — was looking at its own empty
loopback and reporting "found nothing" even with go2rtc on the same machine.


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
