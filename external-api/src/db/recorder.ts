/**
 * The action and state log.
 *
 * Every write here is best-effort and never blocks or fails a command. That
 * rule is inherited from the v2 API, where the attribution write is wrapped
 * the same way, and the reasoning is the same: a database hiccup must not be
 * able to strand someone at a gate. The trade is explicit — while MariaDB is
 * down this service keeps operating doors and loses the record of having done
 * so, and says so loudly in the add-on log.
 */

import { createHash } from 'crypto';
import mysql, { Pool } from 'mysql2/promise';
import { SCHEMA } from './schema';

export interface CommandIssued {
    commandId: string;
    houseId: string;
    domain: string;
    entitySlug: string;
    command: string;
    parameters?: Record<string, unknown>;
    actorLabel: string;
    actorEmail: string;
    issuedAt: Date;
}

export interface CommandSettled {
    commandId: string;
    status: string;
    reason?: string;
    resultingState?: string;
    publishMs?: number;
    ackMs?: number;
    stateEchoMs?: number;
}

export interface StateObserved {
    houseId: string;
    domain: string;
    entitySlug: string;
    state: string;
    attributes: Record<string, unknown>;
    lastChanged: Date;
    originType: string;
    originCommandId?: string;
}

export interface AvailabilityObserved {
    houseId: string;
    state: string;
    reason?: string;
}

export class Recorder {
    constructor(private readonly pool: Pool) {}

    /** Fire-and-forget wrapper: one place where the never-break-the-command rule lives. */
    private write(what: string, sql: string, params: Array<string | number | Date | null>): void {
        this.pool.execute(sql, params).catch((err: Error) => {
            console.error(`[recorder] ${what} write failed: ${err.message}`);
        });
    }

    /**
     * Written before the command is published, not after it settles. A row
     * that never reaches a terminal status is the record of an attempt whose
     * outcome we do not know — for a door, that is a materially different fact
     * from no attempt at all, and settle-only logging cannot express it.
     */
    commandIssued(row: CommandIssued): void {
        this.write('command_issued', `
            INSERT IGNORE INTO command_log (
                command_id, house_id, domain, entity_slug, entity_id, command,
                parameters, actor_label, actor_email, issued_at, status
            ) VALUES (?,?,?,?,?,?,?,?,?,?,'issued')
        `, [
            row.commandId, row.houseId, row.domain, row.entitySlug,
            `${row.domain}.${row.entitySlug}`, row.command,
            row.parameters ? JSON.stringify(row.parameters) : null,
            row.actorLabel, row.actorEmail, row.issuedAt,
        ]);
    }

    commandSettled(row: CommandSettled): void {
        this.write('command_settled', `
            UPDATE command_log
               SET status = ?, reason = ?, resulting_state = ?,
                   publish_ms = ?, ack_ms = ?, state_echo_ms = ?,
                   settled_at = ?
             WHERE command_id = ?
        `, [
            row.status, row.reason ?? null, row.resultingState ?? null,
            row.publishMs ?? null, row.ackMs ?? null, row.stateEchoMs ?? null,
            new Date(), row.commandId,
        ]);
    }

    stateObserved(row: StateObserved): void {
        // Hashed here rather than in SQL so the dedupe index stays a plain
        // column index. Hashing the exact text we store makes an identical
        // replayed payload hash identically, which is the case that matters.
        const attributes = JSON.stringify(row.attributes);
        const hash = createHash('sha256').update(attributes).digest('hex');
        this.write('state', `
            INSERT IGNORE INTO state_log (
                house_id, domain, entity_slug, entity_id, state, attributes,
                attributes_hash, last_changed, origin_type, origin_command_id, observed_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `, [
            row.houseId, row.domain, row.entitySlug, `${row.domain}.${row.entitySlug}`,
            row.state, attributes, hash, row.lastChanged,
            row.originType, row.originCommandId ?? null, new Date(),
        ]);
    }

    /**
     * Insert only when this differs from the house's most recent row.
     *
     * The availability topic is retained, so it replays on every reconnect —
     * and the caller's in-memory guard against that resets with the process,
     * which is precisely when a reconnect happens. Left to memory alone, every
     * add-on restart writes an `online` transition that never occurred, and a
     * month of routine restarts reads back as a house that flaps. Hence the
     * same rule the protocol gives for the state stream: enforce dedupe at the
     * storage layer, not in consumer memory.
     *
     * The inner SELECT is wrapped in a derived table because MariaDB will not
     * let the subquery read the table being inserted into directly.
     *
     * What this cannot recover is an outage that began and ended while we were
     * down. We were not there to see it, and the retained payload only carries
     * the current state.
     */
    availabilityObserved(row: AvailabilityObserved): void {
        this.write('availability', `
            INSERT INTO availability_log (house_id, state, reason, observed_at)
            SELECT ?, ?, ?, ?
              FROM DUAL
             WHERE NOT EXISTS (
                SELECT 1 FROM (
                    SELECT state FROM availability_log
                     WHERE house_id = ?
                     ORDER BY observed_at DESC, id DESC
                     LIMIT 1
                ) latest WHERE latest.state = ?
             )
        `, [row.houseId, row.state, row.reason ?? null, new Date(), row.houseId, row.state]);
    }
}

export interface DatabaseOptions {
    url: string;
    /** How long to keep retrying at boot before giving up. */
    connectTimeoutMs: number;
    poolMax: number;
}

/**
 * Connect and apply the schema, retrying until the deadline.
 *
 * The retry is not defensive padding — it is required. Home Assistant does not
 * guarantee that the MariaDB add-on is accepting connections before this one
 * starts, so a single attempt would turn ordinary boot ordering into a
 * crash-loop on every host reboot.
 */
export async function connectDatabase(opts: DatabaseOptions): Promise<Pool> {
    const pool = mysql.createPool({
        uri: opts.url,
        connectionLimit: opts.poolMax,
        // Pin the session to UTC. Every DATETIME(3) in this schema is written
        // and read as UTC; a server defaulting to local time would otherwise
        // shift them silently, and the log would disagree with the protocol
        // timestamps it sits beside.
        timezone: 'Z',
        // A door command already waits on the bridge; it must not also wait a
        // long time on a wedged connection checkout.
        connectTimeout: 5000,
    });

    const deadline = Date.now() + opts.connectTimeoutMs;
    let attempt = 0;
    for (;;) {
        attempt += 1;
        try {
            for (const statement of SCHEMA) await pool.query(statement);
            return pool;
        } catch (err: any) {
            if (Date.now() >= deadline) {
                await pool.end().catch(() => { /* nothing to close */ });
                throw new Error(`database unreachable after ${attempt} attempts: ${err.message}`);
            }
            console.warn(`[db] not ready (${err.message}) — retrying…`);
            await new Promise((r) => setTimeout(r, 3000));
        }
    }
}
