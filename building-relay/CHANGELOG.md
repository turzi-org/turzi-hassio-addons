# Changelog

## 1.13.1

Arregla la escritura de la configuración de Frigate, que en 1.13.0 nunca llegaba
a aplicarse: faltaba un parámetro que Frigate exige y devolvía un error que el
asistente no te mostraba. Ahora, si algo falla, te lo dice.

También se corrigió la comprobación que evita pisar cambios: comparaba el archivo
consigo mismo de dos maneras distintas, así que podía rechazar escrituras
legítimas. Y el add-on ya no escribe nada si lo que devolvió Frigate no parece
una configuración —un archivo vacío, o sólo comentarios—: antes eso pasaba los
controles y podía reemplazar toda la configuración del edificio.

## 1.13.0

Ya no hace falta editar el archivo de configuración de Frigate a mano.

Desde el TCM, en la integración de Frigate, ahora hay un asistente que hace el
trabajo: este add-on lee la configuración actual de Frigate, la plataforma le
agrega los datos del servidor MQTT de la comunidad, y el add-on la escribe y
reinicia Frigate. Vos sólo confirmás.

**No se toca nada más del archivo.** Tus cámaras, máscaras y comentarios quedan
exactamente como estaban: el add-on no interpreta el archivo, sólo lo transporta;
la plataforma arma el cambio con un lector de YAML que conserva todo lo que no le
pidieron modificar, y se niega a escribir cualquier resultado que tenga menos
cámaras que el original.

Si alguien edita la configuración de Frigate mientras tanto, la escritura se
cancela en lugar de pisar los cambios. Y si Frigate ya está conectado a otro
servidor MQTT, el asistente te lo dice y te deja decidir: no lo reemplaza solo.

La configuración manual sigue disponible, a un clic, para cuando la prefieras.

## 1.12.1

Quitar el relay desde el TCM ahora funciona de punta a punta.

Hasta esta versión, si quitabas el relay en el TCM y generabas una clave nueva,
el add-on seguía usando la credencial vieja — que la plataforma ya no reconocía —
y nunca leía la clave nueva de su configuración. Quedaba rechazado en un bucle,
y la única salida era borrarle los datos a mano.

Ahora, cuando la plataforma deja de reconocerlo, lo dice una vez, descarta la
credencial vieja y canjea la clave que tenga cargada en la configuración — todo
en el mismo arranque. Si estaba corriendo cuando lo quitaron, se da cuenta solo
en un par de minutos y se reinicia para volver a empezar.

## 1.12.0

The TCM can now ask this add-on to do two things, so you stop having to come here
for them.

**"Que mire ahora"** — look again for go2rtc and Frigate right away, instead of
waiting for the next scheduled check. This is the one you want after installing
Frigate or publishing its port.

**"Reiniciar el equipo"** — restart the add-on from the TCM.

Both arrive on the add-on's own outbound connection to Turzi, so nothing needs to
reach into the building and no port has to be opened. It asks about once a
minute, and a request that goes unanswered for ten minutes is dropped rather than
acted on late — a box that was switched off should come back and serve video, not
restart because of a button pressed while it was away.

You can also remove the relay from the TCM now and start the installation over.
The add-on notices on its own and goes back to waiting for a new key; there is
nothing to uninstall or clean up here.

## 1.11.3

Two cosmetic fixes from the first real install.

Frigate is now called **Frigate** in the list of things it found, instead of
`frigate` — the internal name was being used as the label. go2rtc keeps its
lowercase spelling, which is how it is written.

And the log no longer ends with `unknown process … exited with code 0`. That was
this add-on's own follow-up check finishing: nginx runs as the main process, so
it inherited the job and reported a process it could not name. Nothing was
failing, but it is not a line anyone should have to ask about during an install.

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
