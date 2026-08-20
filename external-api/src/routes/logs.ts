/**
 * Read access to the action and state log.
 *
 * A log nobody can query is a log nobody checks, and the alternative — handing
 * an integrator psql on the same database this service writes to — is worse
 * than three read-only endpoints.
 *
 * Deliberately not offered: deletion, or any write. The record of who opened
 * what is not the caller's to edit.
 */

import { Pool, RowDataPacket } from 'mysql2/promise';
import { Router, Request } from 'express';
import { asyncHandler, HttpError } from '../middleware/errors';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function limitOf(req: Request): number {
    const raw = req.query.limit;
    if (raw === undefined) return DEFAULT_LIMIT;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        throw new HttpError(400, 'INVALID_LIMIT', `limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    return parsed;
}

/** `since` is an ISO 8601 instant; anything else is a typo worth reporting. */
function sinceOf(req: Request): Date | undefined {
    const raw = req.query.since;
    if (raw === undefined) return undefined;
    const parsed = new Date(String(raw));
    if (Number.isNaN(parsed.getTime())) {
        throw new HttpError(400, 'INVALID_SINCE', 'since must be an ISO 8601 timestamp');
    }
    return parsed;
}

function stringOf(req: Request, name: string): string | undefined {
    const raw = req.query[name];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/**
 * Builds `WHERE` from the filters that were actually supplied. Every value
 * goes in as a bind parameter — the only thing interpolated into SQL is the
 * column name, which comes from this file, never from the request.
 */
type Bind = string | number | Date;

function where(filters: Array<[column: string, op: string, value: Bind | undefined]>): {
    clause: string;
    params: Bind[];
} {
    const present = filters.filter(([, , value]) => value !== undefined) as Array<[string, string, Bind]>;
    if (present.length === 0) return { clause: '', params: [] };
    return {
        clause: 'WHERE ' + present.map(([col, op]) => `${col} ${op} ?`).join(' AND '),
        params: present.map(([, , value]) => value),
    };
}

/**
 * MariaDB's `JSON` is `LONGTEXT` with a constraint, not a distinct wire type,
 * so the driver hands these back as strings — unlike MySQL, where they arrive
 * parsed. Left alone, the API would emit its JSON columns as escaped strings
 * inside the response.
 */
function parseJsonColumns<T extends RowDataPacket>(rows: T[], columns: string[]): T[] {
    for (const row of rows) {
        for (const column of columns) {
            const value = (row as Record<string, unknown>)[column];
            if (typeof value !== 'string') continue;
            try {
                (row as Record<string, unknown>)[column] = JSON.parse(value);
            } catch {
                /* leave malformed JSON as the text we stored */
            }
        }
    }
    return rows;
}

/**
 * `limit` is interpolated rather than bound. It has already been validated as
 * an integer within range by `limitOf`, and binding it is what breaks: MariaDB
 * rejects a placeholder in LIMIT on a prepared statement.
 */
function limitClause(limit: number): string {
    return `LIMIT ${limit}`;
}

export function logsRouter(pool: Pool): Router {
    const router = Router();

    router.get('/log/commands', asyncHandler(async (req, res) => {
        const limit = limitOf(req);
        const { clause, params } = where([
            ['entity_id', '=', stringOf(req, 'entity_id')],
            ['actor_label', '=', stringOf(req, 'actor')],
            ['status', '=', stringOf(req, 'status')],
            ['issued_at', '>=', sinceOf(req)],
        ]);
        const [rows] = await pool.execute<RowDataPacket[]>(
            `SELECT * FROM command_log ${clause} ORDER BY issued_at DESC ${limitClause(limit)}`,
            params,
        );
        res.json({ count: rows.length, limit, commands: parseJsonColumns(rows, ['parameters']) });
    }));

    router.get('/log/states', asyncHandler(async (req, res) => {
        const limit = limitOf(req);
        const { clause, params } = where([
            ['entity_id', '=', stringOf(req, 'entity_id')],
            ['domain', '=', stringOf(req, 'domain')],
            ['origin_type', '=', stringOf(req, 'origin')],
            ['observed_at', '>=', sinceOf(req)],
        ]);
        const [rows] = await pool.execute<RowDataPacket[]>(
            `SELECT * FROM state_log ${clause} ORDER BY observed_at DESC, id DESC ${limitClause(limit)}`,
            params,
        );
        res.json({ count: rows.length, limit, states: parseJsonColumns(rows, ['attributes']) });
    }));

    router.get('/log/availability', asyncHandler(async (req, res) => {
        const limit = limitOf(req);
        const { clause, params } = where([['observed_at', '>=', sinceOf(req)]]);
        // Ordered by receipt time, which is the only clock both an 'online'
        // payload and a broker-emitted will share.
        const [rows] = await pool.execute<RowDataPacket[]>(
            `SELECT * FROM availability_log ${clause} ORDER BY observed_at DESC, id DESC ${limitClause(limit)}`,
            params,
        );
        res.json({ count: rows.length, limit, availability: rows });
    }));

    return router;
}
