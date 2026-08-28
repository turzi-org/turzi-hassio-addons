/**
 * Home Assistant client — the transport this add-on uses to read and operate
 * entities.
 *
 * **Why not through the Turzi bridge.** The bridge exists to serve the Turzi
 * app, which means it publishes to whichever broker the app uses — for an
 * enrolled building, a cloud broker. Following it there would make opening a
 * gate from inside the building depend on the internet and on a broker
 * credential with platform publish rights, to reach a device sitting on the
 * same machine. Talking to Home Assistant directly leaves the bridge entirely
 * alone (it keeps serving the app, unchanged) and keeps this path local.
 *
 * What that costs: the Turzi Protocol's acks, availability and origin fields.
 * What replaces them is strictly better, because Home Assistant is the source
 * rather than a republisher of it:
 *
 * - `call_service` is synchronous and returns an error when the platform
 *   refuses, so a rejection is a real error instead of silence.
 * - Its result carries a **context id**, and the resulting `state_changed`
 *   event carries the same one. That is proof this command caused this change,
 *   where the protocol path could only infer it from ordering.
 * - `get_states` is a complete snapshot on demand — no retained-message
 *   replay, and therefore none of the deduplication that required.
 */

import { randomUUID } from 'crypto';
import { Config } from '../config';
import { Recorder } from '../db/recorder';

export interface CommandActor {
    name: string;
    email: string;
}

export interface CommandTimings {
    /** Request start -> Home Assistant accepted the service call. */
    callMs: number;
    /** Request start -> the matching state change arrived. */
    stateEchoMs?: number;
}

export interface CommandResult {
    status: 'confirmed' | 'executed' | 'failed';
    commandId: string;
    reason?: string;
    newState?: string;
    timings: CommandTimings;
    /**
     * `context_id` means Home Assistant tagged the state change with the
     * context our own call produced — proof, not inference. It is the only
     * value this transport can produce for a confirmation, and it is why the
     * previous MQTT path's `inferred` no longer exists.
     */
    attribution?: 'context_id';
}

export interface EntityState {
    entityId: string;
    domain: string;
    slug: string;
    state: string;
    attributes: Record<string, unknown>;
    lastChanged?: string;
    /** When this process saw it — distinct from Home Assistant's own clock. */
    observedAt: Date;
}

interface HaContext {
    id?: string;
    parent_id?: string | null;
    user_id?: string | null;
}

interface HaState {
    entity_id: string;
    state: string;
    attributes?: Record<string, unknown>;
    last_changed?: string;
    context?: HaContext;
}

interface QueuedState {
    entityId: string;
    contextId?: string;
    parentId?: string;
    /** Kept so `core_user` stays reachable — classification needs all three. */
    userId?: string;
    entity: EntityState;
    /** When the event actually arrived, not when it is finally written. */
    at: number;
    settled: boolean;
}

interface Pending {
    commandId: string;
    entityId: string;
    contextId: string;
    started: number;
    timings: CommandTimings;
    settle(result: CommandResult): void;
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
/**
 * How many of our own service-call contexts to remember when attributing state
 * changes. Bounded because a long-running add-on would otherwise accumulate
 * one entry per command forever; a few hundred covers any plausible overlap
 * between a call and its echo.
 */
const CONTEXT_MEMORY = 500;
/**
 * How long a state change waits before being classified and written.
 *
 * Home Assistant emits `state_changed` *during* the service call and returns
 * the call's context id *after* it, so the echo normally arrives before we
 * know what to match it against. Holding each event briefly lets the context
 * mapping land first, which is the difference between the log reading
 * `external_api` and reading `core_user`. An audit trail does not care about
 * 400ms; attributing a door to the wrong actor matters a great deal.
 */
const RECORD_DELAY_MS = 400;

export class HaClient {
    private socket?: WebSocket;
    private connected = false;
    private nextId = 1;
    private reconnectDelay = RECONNECT_MIN_MS;
    private stopped = false;

    private readonly entities = new Map<string, EntityState>();
    private readonly pending = new Map<string, Pending>();
    /** Pending JSON-RPC-style results, keyed by outgoing message id. */
    private readonly inflight = new Map<number, {
        resolve(value: any): void;
        reject(err: Error): void;
    }>();
    /** Home Assistant context id -> the command_log row that caused it. */
    private readonly contextToCommand = new Map<string, string>();
    /** State changes seen but not yet classified — see RECORD_DELAY_MS. */
    private queue: QueuedState[] = [];
    private haVersion?: string;
    private haTimeZone?: string;

    constructor(private readonly config: Config, private readonly recorder: Recorder) {}

    // -------------------------------------------------------------------------
    // Visibility
    // -------------------------------------------------------------------------

    /**
     * What this add-on may see, and therefore what it records. Home Assistant
     * exposes everything it knows, which in a real building includes sensors
     * changing every few seconds — logging all of that would bury the door
     * events this exists to keep. The log covers exactly what the API is
     * responsible for, nothing more.
     */
    private visible(entityId: string): boolean {
        const dot = entityId.indexOf('.');
        if (dot < 1) return false;
        if (this.config.allowedEntities.size > 0) return this.config.allowedEntities.has(entityId);
        return this.config.allowedDomains.has(entityId.slice(0, dot));
    }

    // -------------------------------------------------------------------------
    // Connection
    // -------------------------------------------------------------------------

    /** Resolves once authenticated and seeded; keeps reconnecting thereafter. */
    connect(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.open(resolve, reject);
        });
    }

    private open(onReady?: () => void, onFail?: (err: Error) => void): void {
        if (this.stopped) return;
        const socket = new WebSocket(this.config.ha.wsUrl);
        this.socket = socket;

        socket.addEventListener('message', (event) => {
            let msg: any;
            try {
                msg = JSON.parse(String(event.data));
            } catch {
                return;
            }
            this.handleMessage(msg, socket, onReady, onFail).catch((err: Error) => {
                console.error(`[ha] failed handling ${msg?.type}: ${err.message}`);
            });
        });

        socket.addEventListener('close', () => {
            const wasConnected = this.connected;
            this.connected = false;
            this.failInflight('connection to Home Assistant closed');
            if (wasConnected) console.warn('[ha] connection closed');
            if (this.stopped) return;
            // Only the very first attempt can fail startup; after that a drop
            // is transient and retried, because Home Assistant restarting is
            // ordinary and must not take the add-on down with it.
            if (onFail && !wasConnected) {
                onFail(new Error(`could not connect to Home Assistant at ${this.config.ha.wsUrl}`));
                return;
            }
            setTimeout(() => this.open(), this.reconnectDelay);
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
        });

        socket.addEventListener('error', () => {
            /* 'close' always follows; handled there so the logic lives in one place. */
        });
    }

    private async handleMessage(
        msg: any,
        socket: WebSocket,
        onReady?: () => void,
        onFail?: (err: Error) => void,
    ): Promise<void> {
        switch (msg.type) {
            case 'auth_required':
                this.haVersion = msg.ha_version;
                socket.send(JSON.stringify({ type: 'auth', access_token: this.config.ha.token }));
                return;

            case 'auth_invalid':
                console.error(`[ha] authentication rejected: ${msg.message ?? 'invalid token'}`);
                this.stopped = true;
                socket.close();
                onFail?.(new Error(`Home Assistant rejected the token: ${msg.message ?? 'invalid'}`));
                return;

            case 'auth_ok': {
                this.connected = true;
                this.reconnectDelay = RECONNECT_MIN_MS;
                console.info(`[ha] connected (core ${this.haVersion ?? 'unknown'})`);
                // Subscribe before seeding, so a change occurring between the
                // two is delivered rather than lost in the gap.
                await this.send('subscribe_events', { event_type: 'state_changed' });
                await this.seedStates();
                // The building's timezone, not the viewer's. A log read from
                // another country still has to describe when the gate opened
                // where the gate is.
                try {
                    const cfg = await this.send('get_config');
                    if (typeof cfg?.time_zone === 'string') this.haTimeZone = cfg.time_zone;
                } catch {
                    /* optional: the view falls back to UTC and says so */
                }
                console.info(`[ha] tracking ${this.entities.size} entit${this.entities.size === 1 ? 'y' : 'ies'}`);
                onReady?.();
                return;
            }

            case 'result': {
                const waiter = this.inflight.get(msg.id);
                if (!waiter) return;
                this.inflight.delete(msg.id);
                if (msg.success) waiter.resolve(msg.result);
                else waiter.reject(new Error(msg.error?.message ?? 'home assistant rejected the request'));
                return;
            }

            case 'event':
                if (msg.event?.event_type === 'state_changed') this.onStateChanged(msg.event.data);
                return;

            default:
                return;
        }
    }

    private send(type: string, payload: Record<string, unknown> = {}): Promise<any> {
        const socket = this.socket;
        if (!socket || !this.connected && type !== 'subscribe_events') {
            return Promise.reject(new Error('not connected to Home Assistant'));
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.inflight.set(id, { resolve, reject });
            try {
                socket.send(JSON.stringify({ id, type, ...payload }));
            } catch (err: any) {
                this.inflight.delete(id);
                reject(err);
            }
        });
    }

    private failInflight(reason: string): void {
        for (const [, waiter] of this.inflight) waiter.reject(new Error(reason));
        this.inflight.clear();
    }

    /** Full snapshot. Called on every (re)connect — cheap, and removes any drift. */
    private async seedStates(): Promise<void> {
        const states: HaState[] = await this.send('get_states');
        this.entities.clear();
        for (const s of states) {
            if (!this.visible(s.entity_id)) continue;
            this.entities.set(s.entity_id, this.toEntityState(s));
        }
    }

    async disconnect(): Promise<void> {
        this.stopped = true;
        this.socket?.close();
        this.connected = false;
    }

    isConnected(): boolean {
        return this.connected;
    }

    coreVersion(): string | undefined {
        return this.haVersion;
    }

    /** Home Assistant's configured timezone, e.g. "America/Montevideo". */
    timeZone(): string | undefined {
        return this.haTimeZone;
    }

    // -------------------------------------------------------------------------
    // Inbound state
    // -------------------------------------------------------------------------

    private toEntityState(s: HaState): EntityState {
        const dot = s.entity_id.indexOf('.');
        return {
            entityId: s.entity_id,
            domain: s.entity_id.slice(0, dot),
            slug: s.entity_id.slice(dot + 1),
            state: s.state,
            attributes: s.attributes ?? {},
            lastChanged: s.last_changed,
            observedAt: new Date(),
        };
    }

    /**
     * Classify what caused a change, mirroring the rule the Turzi bridge uses
     * on the same events: our own context wins, then a parent context means an
     * automation, then a user id means someone acting in Home Assistant.
     *
     * The fallback is called `unattributed` rather than `physical`. Home
     * Assistant leaves the context bare both for genuinely device-originated
     * changes *and* for service calls made without a user — which includes the
     * Turzi bridge's, so anything the app does lands here too. Calling that
     * "physical" would be a claim the data does not support.
     */
    private classify(ctx?: HaContext): { originType: string; commandId?: string } {
        if (!ctx) return { originType: 'unknown' };
        const commandId = (ctx.id && this.contextToCommand.get(ctx.id))
            || (ctx.parent_id ? this.contextToCommand.get(ctx.parent_id) : undefined);
        if (commandId) return { originType: 'external_api', commandId };
        if (ctx.parent_id) return { originType: 'automation' };
        if (ctx.user_id) return { originType: 'core_user' };
        return { originType: 'unattributed' };
    }

    private onStateChanged(data: { entity_id: string; new_state: HaState | null }): void {
        const entityId = data.entity_id;
        if (!this.visible(entityId)) return;

        // A removed entity has no new state. Drop it from the cache; the log
        // keeps its history, because removal is not deletion.
        if (!data.new_state) {
            this.entities.delete(entityId);
            return;
        }

        const entity = this.toEntityState(data.new_state);
        // The cache updates now: a read must never lag behind the device.
        this.entities.set(entityId, entity);

        const ctx = data.new_state.context;
        const queued: QueuedState = {
            entityId,
            contextId: ctx?.id,
            parentId: ctx?.parent_id ?? undefined,
            userId: ctx?.user_id ?? undefined,
            entity,
            at: Date.now(),
            settled: false,
        };
        this.queue.push(queued);
        setTimeout(() => this.record(queued), RECORD_DELAY_MS);

        // A command issued before this event still matches here — that is the
        // case where the echo is genuinely slower than the service call.
        this.matchPending(queued);
    }

    /** Settle any in-flight command this state change belongs to. */
    private matchPending(q: QueuedState): boolean {
        if (!q.contextId && !q.parentId) return false;
        let matched = false;
        for (const p of this.pending.values()) {
            if (p.entityId !== q.entityId) continue;
            if (q.contextId !== p.contextId && q.parentId !== p.contextId) continue;
            p.timings.stateEchoMs = q.at - p.started;
            p.settle({
                status: 'confirmed',
                commandId: p.commandId,
                newState: q.entity.state,
                timings: p.timings,
                attribution: 'context_id',
            });
            matched = true;
        }
        return matched;
    }

    /** Classify and persist a held state change. */
    private record(q: QueuedState): void {
        if (q.settled) return;
        q.settled = true;
        this.queue = this.queue.filter((e) => e !== q);

        const { originType, commandId } = this.classify({
            id: q.contextId, parent_id: q.parentId, user_id: q.userId,
        });
        this.recorder.stateObserved({
            houseId: this.config.houseId,
            domain: q.entity.domain,
            entitySlug: q.entity.slug,
            state: q.entity.state,
            attributes: q.entity.attributes,
            lastChanged: q.entity.lastChanged ? new Date(q.entity.lastChanged) : new Date(),
            originType,
            originCommandId: commandId,
        });
    }

    // -------------------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------------------

    listEntities(domain?: string): EntityState[] {
        return [...this.entities.values()]
            .filter((e) => !domain || e.domain === domain)
            .sort((a, b) => a.entityId.localeCompare(b.entityId));
    }

    getEntity(entityId: string): EntityState | undefined {
        return this.entities.get(entityId);
    }

    /** Re-fetch every state. The escape hatch if the cache is ever doubted. */
    async refresh(): Promise<boolean> {
        if (!this.connected) return false;
        try {
            await this.seedStates();
            return true;
        } catch (err: any) {
            console.warn(`[ha] refresh failed: ${err.message}`);
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // Writes
    // -------------------------------------------------------------------------

    /** Call a service and wait for the state change it causes. */
    async callService(opts: {
        domain: string;
        slug: string;
        service: string;
        data?: Record<string, unknown>;
        actor: CommandActor;
    }): Promise<CommandResult> {
        const started = Date.now();
        const commandId = randomUUID();
        const entityId = `${opts.domain}.${opts.slug}`;
        const timings: CommandTimings = { callMs: 0 };

        const settleLog = (result: CommandResult) => {
            this.recorder.commandSettled({
                commandId,
                status: result.status,
                reason: result.reason,
                resultingState: result.newState,
                publishMs: result.timings.callMs,
                stateEchoMs: result.timings.stateEchoMs,
            });
            return result;
        };

        this.recorder.commandIssued({
            commandId,
            houseId: this.config.houseId,
            domain: opts.domain,
            entitySlug: opts.slug,
            command: `${opts.domain}.${opts.service}`,
            parameters: opts.data,
            actorLabel: opts.actor.name,
            actorEmail: opts.actor.email,
            issuedAt: new Date(started),
        });

        if (!this.connected) {
            return settleLog({ status: 'failed', commandId, reason: 'home_assistant_unavailable', timings });
        }

        let context: HaContext | undefined;
        try {
            const result = await this.send('call_service', {
                domain: opts.domain,
                service: opts.service,
                target: { entity_id: entityId },
                ...(opts.data && Object.keys(opts.data).length ? { service_data: opts.data } : {}),
            });
            timings.callMs = Date.now() - started;
            context = result?.context;
        } catch (err: any) {
            timings.callMs = Date.now() - started;
            // Home Assistant refusing is a real error with a real message —
            // an unknown entity, a bad parameter, a platform that raised.
            return settleLog({ status: 'failed', commandId, reason: err.message, timings });
        }

        if (!context?.id) {
            // Accepted, but nothing to correlate a change against.
            return settleLog({ status: 'executed', commandId, timings });
        }

        this.rememberContext(context.id, commandId);

        // Home Assistant emits the state change during the call and returns
        // the context after it, so the echo has usually already arrived. Look
        // at what is being held before waiting for something that is past.
        const already = this.queue.find((q) =>
            q.entityId === entityId && (q.contextId === context!.id || q.parentId === context!.id));
        if (already) {
            timings.stateEchoMs = Math.max(0, already.at - started);
            return settleLog({
                status: 'confirmed',
                commandId,
                newState: already.entity.state,
                timings,
                attribution: 'context_id',
            });
        }

        const outcome = await new Promise<CommandResult>((resolve) => {
            const pending: Pending = {
                commandId, entityId, contextId: context!.id!, started, timings,
                settle: (result) => {
                    if (!this.pending.delete(commandId)) return;
                    clearTimeout(timer);
                    resolve(result);
                },
            };
            const timer = setTimeout(() => {
                // The service ran and changed nothing — closing a closed gate.
                // Home Assistant fires no state change for a no-op, so this is
                // a success, not a timeout.
                pending.settle({ status: 'executed', commandId, timings });
            }, this.config.confirmTimeoutMs);
            this.pending.set(commandId, pending);
        });

        const result = settleLog(outcome);
        console.info(
            `[command] ${opts.domain}.${opts.service} ${entityId} by ${opts.actor.name} -> ${result.status}` +
            `${result.reason ? ` (${result.reason})` : ''} ` +
            `(call=${timings.callMs}ms echo=${timings.stateEchoMs ?? '-'}ms)`,
        );
        return result;
    }

    private rememberContext(contextId: string, commandId: string): void {
        this.contextToCommand.set(contextId, commandId);
        if (this.contextToCommand.size > CONTEXT_MEMORY) {
            // Map preserves insertion order, so the first key is the oldest.
            const oldest = this.contextToCommand.keys().next().value;
            if (oldest !== undefined) this.contextToCommand.delete(oldest);
        }
    }
}
