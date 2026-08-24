/**
 * turzi-external-api — lets an external system read and operate the entities
 * of the Home Assistant it runs inside, and records every action and every
 * observed state as it goes.
 *
 * It talks to Home Assistant directly rather than through the Turzi bridge.
 * The bridge belongs to the app: it publishes wherever the app's broker is,
 * and dragging this along would make opening a gate inside the building depend
 * on the internet. Direct means the bridge is untouched, still serving the
 * app, while this path stays local.
 *
 * A stopgap with a known end date. When Turzi v2 goes live its API exposes the
 * same devices to external systems with real identity, per-entity
 * authorization and the community ledger behind them; this runs in parallel
 * until then and shares no database and no deployment with it.
 */

import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { ConfigError, loadConfig } from './config';
import { connectDatabase, Recorder } from './db/recorder';
import { apiKeyAuth } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { HaClient } from './ha/ha-client';
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

    const client = new HaClient(config, new Recorder(pool));
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
            await client.disconnect().catch((err) => console.warn(`[shutdown] home assistant: ${err.message}`));
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
