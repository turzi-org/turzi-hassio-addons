/**
 * Liveness for the Supervisor and whatever proxy sits in front.
 *
 * Only the Home Assistant connection decides the status code. The database
 * being down deliberately does not: commands still work without it, they just
 * go unrecorded, and taking the service out of rotation would turn "doors
 * work, logging is broken" into "nothing works". It reports `degraded` so a
 * human makes that call.
 */

import { Pool } from 'mysql2/promise';
import { Router } from 'express';
import { Config } from '../config';
import { HaClient } from '../ha/ha-client';

export function healthRouter(client: HaClient, pool: Pool, config: Config): Router {
    const router = Router();

    router.get('/health', async (_req, res) => {
        const haConnected = client.isConnected();
        let databaseConnected = true;
        try {
            await pool.query('SELECT 1');
        } catch {
            databaseConnected = false;
        }

        const status = !haConnected ? 'unavailable' : databaseConnected ? 'ok' : 'degraded';
        res.status(haConnected ? 200 : 503).json({
            status,
            home_assistant_connected: haConnected,
            core_version: client.coreVersion() ?? null,
            database_connected: databaseConnected,
            house_id: config.houseId,
            entities_known: client.listEntities().length,
            uptime_s: Math.floor(process.uptime()),
        });
    });

    return router;
}
