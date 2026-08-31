# Changelog

## 1.11.2

Fixes the add-on stopping on its very first start when the platform had not
issued its certificate yet. It enrolled correctly, then exited before reaching
the part that waits — so it only settled down on the second start. Now it waits
straight away and picks the certificate up on its own when it arrives, with no
restart and no new key.

## 1.11.1

The add-on now introduces itself, so the TCM stops asking you for things it can
find out.

On its first boot it reports how it is attached to the network, the addresses
this machine has (with the interface each belongs to), and which video servers
answer beside it. The wizard then asks you to **confirm** an address instead of
looking one up: with a single obvious candidate it is one click, and with several
it shows which one the machine uses to reach the internet.

**Findings no longer carry an address**, which fixes a trap. Installing before an
address had been entered used to store an empty result with a fresh timestamp —
the TCM would say the add-on looked and found nothing, and it would not look
again for a day. It now reports what it found regardless, and the address is
worked out when the screen is read.

It also says when a video server answers only on the machine's own loopback. That
cannot be reached through the relay, and the TCM now says so instead of offering
it and producing a stream that times out.

## 1.10.2

The add-on no longer stops when something is missing. It waits.

**A wrong or spent key no longer restarts the add-on forever.** It used to exit,
which handed the problem to the Supervisor, which started it again to fail the
same way — one error reprinted endlessly, and a request to the platform on every
start. Measured on a real box: ten attempts in ninety seconds, four of them
rate-limited, and the rate-limit reply then hid the real reason. Now it says once
what is wrong and waits. **Paste a new key into this form and the running add-on
picks it up — no restart.**

It also tells the two failures apart, because they need different remedies. A key
the platform refuses will never work, so it stops asking and watches this form for
a different one. A platform it cannot reach says nothing about the key, so that
one is retried on its own. And an `api_url` that answers but is not the Turzi API
now says so, instead of blaming the key: it goes **without** `/api/v2` at the end,
for example `http://10.0.1.53:4000`.

**A missing certificate no longer stops it either.** The certificate is issued
elsewhere, so "not there yet" is normal on an add-on installed before the platform
side finished — nothing you can do from here. It waits and picks the certificate
up on its own, whether it arrives from the platform or is dropped into a mounted
certificate directory.

Also fixed: after being configured this way, the daily refresh used to keep using
the address the add-on had at start-up — which was none — so certificates would
have stopped renewing silently about three months later.

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
