/**
 * Liveness/readiness for Docker and whatever sits in front of it.
 *
 * Only the broker link decides the status code, and two things deliberately do
 * not:
 *
 * - **The house being offline.** Restarting this container does not fix
 *   someone else's internet, and an orchestrator that keeps recycling us while
 *   a community is down is strictly worse than one that leaves us up to answer
 *   with `house_availability: "offline"`.
 * - **The database being down.** Commands still work without it; they just go
 *   unrecorded. Taking the service out of rotation would convert "doors work,
 *   logging is broken" into "nothing works", which is the wrong trade to make
 *   automatically. It reports `degraded` so a human makes that call.
 */

import { Pool } from 'mysql2/promise';
import { Router } from 'express';
import { Config } from '../config';
import { TurziClient } from '../mqtt/turzi-client';

export function healthRouter(client: TurziClient, pool: Pool, config: Config): Router {
    const router = Router();

    router.get('/health', async (_req, res) => {
        const mqttConnected = client.isConnected();
        let databaseConnected = true;
        try {
            await pool.query('SELECT 1');
        } catch {
            databaseConnected = false;
        }

        const status = !mqttConnected ? 'unavailable' : databaseConnected ? 'ok' : 'degraded';
        res.status(mqttConnected ? 200 : 503).json({
            status,
            mqtt_connected: mqttConnected,
            database_connected: databaseConnected,
            house_id: config.houseId,
            house_availability: client.availability(),
            entities_known: client.listEntities().length,
            uptime_s: Math.floor(process.uptime()),
        });
    });

    return router;
}
