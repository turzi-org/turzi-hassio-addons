/**
 * turzi-external-api — lets an external system read and operate the entities a
 * Home Assistant core exposes, by speaking the Turzi Protocol over MQTT, and
 * records every action and every observed state as it goes.
 *
 * A stopgap with a known end date. When Turzi v2 goes live its API exposes the
 * same devices to external systems with real identity, per-entity
 * authorization and the community ledger behind them; this service runs in
 * parallel until then and shares no database, no broker credential and no
 * deployment with it. What it does share is v2's protocol code, copied
 * deliberately so the two never drift on the wire.
 */

import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { ConfigError, loadConfig } from './config';
import { connectDatabase, Recorder } from './db/recorder';
import { apiKeyAuth } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { TurziClient } from './mqtt/turzi-client';
import { entitiesRouter } from './routes/entities';
import { healthRouter } from './routes/health';
import { logsRouter } from './routes/logs';

async function main(): Promise<void> {
    const config = loadConfig();

    // Both before listening: a container that accepts requests it cannot
    // fulfil reads as healthy to everything upstream. The database is required
    // to *start* even though a later outage is survivable — a deployment that
    // was never able to reach its database is a misconfiguration, and finding
    // that out from a gap in the audit trail is finding out too late.
    const pool = await connectDatabase(config.database);
    console.info('[db] connected, schema applied');

    const client = new TurziClient(config, new Recorder(pool));
    await client.connect();

    const app = express();
    app.disable('x-powered-by');
    app.use(helmet());
    app.use(express.json({ limit: '16kb' }));
    if (config.logRequests) app.use(morgan('combined'));

    // Unauthenticated: the health probe has no credential to offer.
    app.use(healthRouter(client, pool, config));
    app.use('/api/v1', apiKeyAuth(config), entitiesRouter(client, config), logsRouter(pool));

    app.use(notFoundHandler);
    app.use(errorHandler);

    const server = app.listen(config.port, () => {
        console.info(
            `[http] listening on :${config.port} — house=${config.houseId}, ` +
            `keys=${config.apiKeys.map((k) => k.label).join(',')}, ` +
            `domains=${[...config.allowedDomains].join(',')}, ` +
            `entities=${config.allowedEntities.size ? [...config.allowedEntities].join(',') : 'all exposed'}`,
        );
    });

    const shutdown = (signal: string) => {
        console.info(`[shutdown] ${signal} received`);
        server.close(async () => {
            await client.disconnect().catch((err) => console.warn(`[shutdown] mqtt: ${err.message}`));
            await pool.end().catch((err) => console.warn(`[shutdown] db: ${err.message}`));
            process.exit(0);
        });
        // A command awaiting its confirm window must not hold the process open
        // indefinitely if a socket refuses to drain.
        setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
    if (err instanceof ConfigError) {
        console.error(`[config] ${err.message}`);
    } else {
        console.error('[startup] failed:', err);
    }
    process.exit(1);
});
