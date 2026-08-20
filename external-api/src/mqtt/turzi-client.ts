/**
 * Turzi Protocol client (MQTT binding, v1.1).
 *
 * Adapted from the v2 API's `modules/smart-home/mqtt-publisher.service.ts`.
 * The command/ack/state-echo confirmation is the same logic; three things
 * differ, all because this service talks to exactly one house:
 *
 * 1. **One connection, not a pool.** The v2 publisher keys a pool by broker
 *    endpoint and mints a credential per broker. Here the endpoint and the
 *    credential are environment variables.
 *
 * 2. **Subscriptions are permanent, not per command.** The v2 publisher
 *    subscribes to `ack/{id}` and the entity's state topic for the duration of
 *    each command. It can afford to: it holds no state cache. This service
 *    must already be subscribed to `state/#` to answer reads and to write its
 *    log, and layering a per-command subscription on top of a wildcard invites
 *    a broker to deliver the echo twice. So all three topic families are
 *    subscribed once on connect and one handler fans messages out to the
 *    cache, the recorder, and whichever commands are in flight.
 *
 * 3. **Everything observed is recorded.** v2 splits this across a separate
 *    audit worker; at this size one handler doing both is less machinery, not
 *    more.
 *
 * Publishing on `command/#` requires broker credentials with the platform's
 * ACL, not a client's — see the README. Clients hold strictly subscribe-only
 * credentials in cloud mode (PROTOCOL.md §4), and this service is acting as a
 * platform publisher, not as a client.
 */

import { randomUUID } from 'crypto';
import mqtt, { MqttClient } from 'mqtt';
import { Config } from '../config';
import { Recorder } from '../db/recorder';
import { ttlForDomain } from './ttl-policy';

export interface CommandActor {
    name: string;
    email: string;
}

export interface CommandTimings {
    publishMs: number;          // request start -> broker PUBACK
    ackMs?: number;             // request start -> bridge ack observed
    stateEchoMs?: number;       // request start -> state echo observed
}

export interface CommandResult {
    status: 'confirmed' | 'executed' | 'accepted' | 'failed';
    commandId: string;
    reason?: string;
    newState?: string;
    timings: CommandTimings;
    /**
     * How a `confirmed` was established. `command_id` means the core echoed our
     * own command id back in `origin` — proof this command caused this change.
     * `inferred` means we matched the first state change on the entity after
     * publishing, which is the best a v1.0 core allows and is not proof: a wall
     * button pressed in the same window would look identical.
     */
    attribution?: 'command_id' | 'inferred';
}

/** What the core turned out to support, decided by observation, not configuration. */
export type ProtocolMode = 'v1.1' | 'v1.0-assumed' | 'detecting';

/** How long to wait for a retained availability payload before concluding v1.0. */
const PROTOCOL_PROBE_MS = 5000;

export interface EntityState {
    entityId: string;
    domain: string;
    slug: string;
    state: string;
    attributes: Record<string, unknown>;
    lastChanged?: string;
    /** When this process received the payload — distinct from the core's clock. */
    observedAt: Date;
}

export type Availability = 'online' | 'offline' | 'unknown';

interface Pending {
    commandId: string;
    entityId: string;
    started: number;
    timings: CommandTimings;
    /** An ack of `executed` arrived; the state echo may still upgrade this to `confirmed`. */
    executed: boolean;
    settle(result: CommandResult): void;
}

export class TurziClient {
    private client?: MqttClient;
    private connected = false;
    private readonly entities = new Map<string, EntityState>();
    private readonly pending = new Map<string, Pending>();
    private availabilityPayload?: { state: string; reason?: string };
    private lastAvailabilityLogged?: string;
    private lastReloadAt = 0;
    /**
     * Sticky: set the moment a core announces itself on the availability topic,
     * which only a v1.1 core publishes. Sticky because the payload is retained
     * — once seen, a later silence means the core is offline, not downgraded.
     */
    private v11 = false;
    /** `protocol_version` as reported by the core; informational only. */
    private coreProtocol?: string;
    private probeScheduled = false;
    private probeElapsed = false;

    constructor(private readonly config: Config, private readonly recorder: Recorder) {}

    private topic(suffix: string): string {
        return `house/${this.config.houseId}/${suffix}`;
    }

    // -------------------------------------------------------------------------
    // Connection
    // -------------------------------------------------------------------------

    /**
     * Resolves on the first successful connect so startup can report an honest
     * result, then keeps reconnecting on its own forever. A rejection here is
     * fatal at boot; a drop afterwards is not, because commands issued while
     * the link is down fail fast rather than queuing.
     */
    connect(): Promise<void> {
        const { mqtt: broker } = this.config;
        return new Promise<void>((resolve, reject) => {
            const client = mqtt.connect({
                // Without `protocol`, mqtt.js connects in plaintext no matter
                // which port it is given.
                protocol: broker.tls ? 'mqtts' : 'mqtt',
                host: broker.host,
                port: broker.port,
                ...(broker.tls ? { rejectUnauthorized: broker.rejectUnauthorized } : {}),
                username: broker.username,
                password: broker.password,
                clientId: `turzi-external-api-${process.pid}-${randomUUID().slice(0, 8)}`,
                // Never queue: a command accepted while disconnected and
                // delivered on reconnect is exactly what command expiry exists
                // to prevent (PROTOCOL.md §4).
                clean: true,
                reconnectPeriod: 5000,
                connectTimeout: 10_000,
            });
            this.client = client;

            let settled = false;

            client.on('connect', () => {
                this.connected = true;
                // Retained payloads arrive right after subscribing: entity
                // states and the house's availability are warm before the
                // first request lands, with no reload round-trip.
                client.subscribe(
                    [this.topic('state/#'), this.topic('availability'), this.topic('ack/+')],
                    { qos: 1 },
                    (err) => {
                        if (err) console.error(`[mqtt] subscribe failed: ${err.message}`);
                    },
                );
                console.info(
                    `[mqtt] connected to ${broker.tls ? 'mqtts' : 'mqtt'}://${broker.host}:${broker.port} ` +
                    `(house=${this.config.houseId})`,
                );
                this.scheduleProtocolProbe();
                if (!settled) { settled = true; resolve(); }
            });

            client.on('reconnect', () => console.info('[mqtt] reconnecting…'));

            client.on('close', () => {
                if (this.connected) console.warn('[mqtt] connection closed');
                this.connected = false;
            });

            client.on('error', (err) => {
                console.warn(`[mqtt] ${err.message}`);
                if (!settled) {
                    settled = true;
                    client.end(true);
                    reject(err);
                }
            });

            client.on('message', (topic, payload) => {
                try {
                    this.handleMessage(topic, payload);
                } catch (err: any) {
                    console.error(`[mqtt] failed to process ${topic}: ${err.message}`);
                }
            });
        });
    }

    /**
     * Retained payloads land within milliseconds of the SUBACK, so a core that
     * has said nothing after this window is not slow — it is a v1.0 core that
     * has no availability topic to send. Scheduled once, not per reconnect:
     * `connect` fires again on every reconnection and the answer does not
     * change.
     */
    private scheduleProtocolProbe(): void {
        if (this.probeScheduled) return;
        this.probeScheduled = true;
        setTimeout(() => {
            this.probeElapsed = true;
            if (this.v11) return;
            console.warn(
                '[protocol] No availability topic after 5s — assuming a v1.0 core. ' +
                'Commands will publish at QoS 2 and be confirmed from the state echo alone. ' +
                'Three things are unavailable until the bridge is upgraded: command ' +
                'acknowledgments (a rejected command is indistinguishable from a silent one), ' +
                'the offline fail-fast check, and origin attribution — so state_log cannot tell ' +
                'this API apart from a resident or an automation.',
            );
        }, PROTOCOL_PROBE_MS).unref();
    }

    /** What we currently believe the core speaks. Surfaced on /health. */
    protocolMode(): ProtocolMode {
        if (this.v11) return 'v1.1';
        return this.probeElapsed ? 'v1.0-assumed' : 'detecting';
    }

    /** The core's self-reported protocol version, when it states one. */
    protocolVersion(): string | undefined {
        return this.coreProtocol;
    }

    async disconnect(): Promise<void> {
        await this.client?.endAsync();
        this.connected = false;
    }

    isConnected(): boolean {
        return this.connected;
    }

    // -------------------------------------------------------------------------
    // Inbound
    // -------------------------------------------------------------------------

    private handleMessage(topic: string, payload: Buffer): void {
        const parts = topic.split('/');
        // house/{id}/...
        if (parts[0] !== 'house' || parts[1] !== this.config.houseId) return;

        if (parts[2] === 'availability') {
            this.handleAvailability(payload);
            return;
        }

        if (parts[2] === 'ack' && parts.length === 4) {
            this.handleAck(parts[3], payload);
            return;
        }

        if (parts[2] === 'state' && parts.length >= 5) {
            // The slug is joined rather than indexed: the v2 audit worker does
            // the same, and a slug containing a slash would otherwise silently
            // address the wrong entity.
            this.handleState(parts[3], parts.slice(4).join('/'), payload);
        }
    }

    private handleAvailability(payload: Buffer): void {
        this.availabilityPayload = payload.length ? JSON.parse(payload.toString()) : undefined;
        const state = this.availabilityPayload?.state;
        if (!state) return;

        // The availability topic exists only in v1.1, so its mere arrival is
        // the detection — `protocol_version` inside it is a nicety the core is
        // not obliged to send.
        const version = (this.availabilityPayload as { protocol_version?: unknown })?.protocol_version;
        if (typeof version === 'string') this.coreProtocol = version;
        if (!this.v11) {
            this.v11 = true;
            console.info(
                `[protocol] v1.1 core detected (protocol_version=${this.coreProtocol ?? 'unstated'}) — ` +
                'acknowledgments, command expiry and origin attribution are available',
            );
        }
        // Retained, so it replays on every reconnect. Logging each replay would
        // fabricate outages that never happened.
        if (state === this.lastAvailabilityLogged) return;
        this.lastAvailabilityLogged = state;
        this.recorder.availabilityObserved({
            houseId: this.config.houseId,
            state,
            reason: this.availabilityPayload?.reason,
        });
    }

    private handleState(domain: string, slug: string, payload: Buffer): void {
        const entityId = `${domain}.${slug}`;

        if (payload.length === 0) {
            // Entity cleanup: an empty retained payload means the bridge
            // withdrew this entity. Keeping it cached would keep answering
            // reads with a state nobody is updating any more. The log keeps
            // its history — withdrawal is not deletion.
            this.entities.delete(entityId);
            return;
        }

        const body = JSON.parse(payload.toString());
        if (!body || typeof body !== 'object' || typeof body.state !== 'string') return;

        const attributes = (body.attributes ?? {}) as Record<string, unknown>;
        const lastChanged = typeof body.last_changed === 'string' ? body.last_changed : undefined;

        this.entities.set(entityId, {
            entityId,
            domain,
            slug,
            state: body.state,
            attributes,
            lastChanged,
            observedAt: new Date(),
        });

        const origin = body.origin ?? {};
        this.recorder.stateObserved({
            houseId: this.config.houseId,
            domain,
            entitySlug: slug,
            state: body.state,
            attributes,
            // `last_changed` is required by the protocol, but a core that omits
            // it must not cost us the row — and a NULL here would defeat the
            // dedupe index, since NULLs never collide.
            lastChanged: lastChanged
                ? new Date(lastChanged)
                : (typeof body.timestamp === 'number' ? new Date(body.timestamp * 1000) : new Date()),
            // Missing origin means a v1.0 core, which is 'unknown', not 'none'.
            originType: typeof origin.type === 'string' ? origin.type : 'unknown',
            originCommandId: typeof origin.command_id === 'string' ? origin.command_id : undefined,
        });

        const originCommandId = typeof origin.command_id === 'string' ? origin.command_id : undefined;

        for (const p of this.pending.values()) {
            if (p.entityId !== entityId) continue;

            // v1.1: require the ack first, matching the v2 publisher — an echo
            // seen before it belongs to whatever moved the entity a moment
            // earlier, not to this command.
            //
            // v1.0: no ack is ever coming, so the command being in flight is
            // the only boundary available. Every change on the entity inside
            // that window is taken as ours, which is an inference and is
            // reported as one rather than dressed up as proof.
            if (p.timings.ackMs === undefined && this.v11) continue;

            p.timings.stateEchoMs = Date.now() - p.started;
            p.settle({
                status: 'confirmed',
                commandId: p.commandId,
                newState: body.state,
                timings: p.timings,
                // Proof only when the core echoed our own id back. An ack
                // ordering says the command was executed, not that THIS change
                // is the one it caused.
                attribution: originCommandId === p.commandId ? 'command_id' : 'inferred',
            });
        }
    }

    private handleAck(commandId: string, payload: Buffer): void {
        const p = this.pending.get(commandId);
        if (!p) return; // not ours, or already settled

        let ack: any;
        try { ack = JSON.parse(payload.toString()); } catch { return; }

        p.timings.ackMs = Date.now() - p.started;
        if (ack.status === 'failed') {
            p.settle({
                status: 'failed',
                commandId,
                reason: ack.reason ?? 'unknown',
                timings: p.timings,
            });
        } else if (ack.status === 'executed') {
            // Executed — give the state echo the remaining window.
            p.executed = true;
        }
        // `received` is non-terminal: keep waiting.
    }

    // -------------------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------------------

    /**
     * Fail-fast check (PROTOCOL.md §4): 'offline' when a retained availability
     * payload says so; 'unknown' when we have no data — do not block on
     * unknown, because v1.0 bridges publish no availability at all.
     *
     * A dropped link of our own also reads 'unknown', not the last value we
     * happened to hold. Two reasons. The retained payload is a fact about a
     * moment we can no longer refresh, so repeating it asserts knowledge we do
     * not have. And when the broker itself goes down it may deliver the
     * bridge's will on the way out, which would leave us reporting a perfectly
     * healthy community as offline and send whoever is debugging to the wrong
     * building.
     */
    availability(): Availability {
        if (!this.connected || !this.availabilityPayload) return 'unknown';
        return this.availabilityPayload.state === 'online' ? 'online' : 'offline';
    }

    listEntities(domain?: string): EntityState[] {
        return [...this.entities.values()]
            .filter((e) => !domain || e.domain === domain)
            .sort((a, b) => a.entityId.localeCompare(b.entityId));
    }

    getEntity(entityId: string): EntityState | undefined {
        return this.entities.get(entityId);
    }

    // -------------------------------------------------------------------------
    // Writes
    // -------------------------------------------------------------------------

    /** Publish a v1.1 command and await ack / state echo up to the confirm timeout. */
    async publishCommand(opts: {
        domain: string;
        slug: string;
        command: string;
        parameters?: Record<string, unknown>;
        actor: CommandActor;
    }): Promise<CommandResult> {
        const started = Date.now();
        const commandId = randomUUID();
        const entityId = `${opts.domain}.${opts.slug}`;
        const timings: CommandTimings = { publishMs: 0 };

        const settleLog = (result: CommandResult) => {
            this.recorder.commandSettled({
                commandId,
                status: result.status,
                reason: result.reason,
                resultingState: result.newState,
                publishMs: result.timings.publishMs,
                ackMs: result.timings.ackMs,
                stateEchoMs: result.timings.stateEchoMs,
            });
            return result;
        };

        this.recorder.commandIssued({
            commandId,
            houseId: this.config.houseId,
            domain: opts.domain,
            entitySlug: opts.slug,
            command: opts.command,
            parameters: opts.parameters,
            actorLabel: opts.actor.name,
            actorEmail: opts.actor.email,
            issuedAt: new Date(started),
        });

        if (!this.client || !this.connected) {
            return settleLog({ status: 'failed', commandId, reason: 'broker_unreachable', timings });
        }
        const client = this.client;

        const payload = JSON.stringify({
            command: opts.command,
            command_id: commandId,
            issued_at: Math.floor(started / 1000),
            ttl_seconds: ttlForDomain(opts.domain),
            parameters: opts.parameters ?? {},
            metadata: {
                user_name: opts.actor.name,
                user_email: opts.actor.email,
                verified_by: 'turzi-external-api',
            },
        });

        // Register before publishing to avoid racing fast bridges — the ack can
        // land in tens of milliseconds, well inside our own await.
        const outcome = new Promise<CommandResult>((resolve) => {
            const pending: Pending = {
                commandId,
                entityId,
                started,
                timings,
                executed: false,
                settle: (result) => {
                    if (!this.pending.delete(commandId)) return; // already settled
                    clearTimeout(timer);
                    resolve(result);
                },
            };
            const timer = setTimeout(() => {
                // `executed` without an echo is the protocol's no-op case (a
                // command that changed nothing, e.g. unlocking an unlocked
                // door). Anything less means we published and heard nothing.
                pending.settle(pending.executed
                    ? { status: 'executed', commandId, timings }
                    : { status: 'accepted', commandId, timings });
            }, this.config.confirmTimeoutMs);
            this.pending.set(commandId, pending);
        });

        try {
            // QoS 1 is safe only because a v1.1 core dedupes on command_id
            // (PROTOCOL.md §2). A v1.0 core does not, so a QoS 1 redelivery
            // could actuate a door twice — the protocol's own topic table
            // specifies QoS 2 for commands without one. While still detecting
            // we also send QoS 2: it is correct against both, so the unknown
            // case takes the safe side.
            await client.publishAsync(
                this.topic(`command/${opts.domain}/${opts.slug}`),
                payload,
                { qos: this.v11 ? 1 : 2 },
            );
            timings.publishMs = Date.now() - started;
        } catch (err: any) {
            const failure: CommandResult = {
                status: 'failed', commandId, reason: `publish_failed: ${err.message}`, timings,
            };
            this.pending.get(commandId)?.settle(failure);
            return settleLog(failure);
        }

        const result = settleLog(await outcome);
        console.info(
            `[command] ${opts.command} ${entityId} by ${opts.actor.name} -> ${result.status}` +
            `${result.reason ? ` (${result.reason})` : ''} ` +
            `(publish=${timings.publishMs}ms ack=${timings.ackMs ?? '-'}ms echo=${timings.stateEchoMs ?? '-'}ms)`,
        );
        return result;
    }

    /**
     * Ask the bridge to republish every exposed entity.
     *
     * Rate limited: reload is the one non-actuating topic with amplification
     * potential — one small publish makes the core republish everything
     * (PROTOCOL.md §4).
     */
    async publishReload(): Promise<boolean> {
        if (!this.client || !this.connected) return false;
        const now = Date.now();
        if (now - this.lastReloadAt < this.config.reloadMinIntervalMs) return true; // recently reloaded
        this.lastReloadAt = now;
        try {
            await this.client.publishAsync(
                this.topic('app/command/reload'),
                JSON.stringify({ command: 'reload' }),
                { qos: 1 },
            );
            return true;
        } catch (err: any) {
            console.warn(`[mqtt] reload failed: ${err.message}`);
            return false;
        }
    }
}
