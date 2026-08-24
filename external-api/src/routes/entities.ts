/**
 * Entity endpoints — read state, call services.
 *
 * Reads come from a cache seeded by `get_states` and kept current by Home
 * Assistant's `state_changed` stream. Writes are service calls that block
 * until the resulting state change arrives, matched by context id, so a
 * `confirmed` means the device actually moved and that this call is what moved
 * it.
 */

import { Router, Response } from 'express';
import { Config } from '../config';
import { asyncHandler } from '../middleware/errors';
import { AuthedRequest } from '../middleware/auth';
import { CommandResult, EntityState, HaClient } from '../ha/ha-client';

const DOMAIN_RE = /^[a-z_]+$/;
const SLUG_RE = /^[a-z0-9_]+$/;
const SERVICE_RE = /^[a-z0-9_]+$/;

/**
 * Convenience verbs, one URL per intent, resolved per domain. The generic
 * `/command` endpoint can express anything Home Assistant offers; this exists
 * because an integrator wiring up one gate should not have to know the service
 * is called `open_cover`.
 */
const VERB_SERVICES: Record<string, Record<string, string>> = {
    open: { cover: 'open_cover' },
    close: { cover: 'close_cover' },
    stop: { cover: 'stop_cover', vacuum: 'stop', media_player: 'media_stop' },
    lock: { lock: 'lock' },
    unlock: { lock: 'unlock' },
    on: {
        light: 'turn_on', switch: 'turn_on', fan: 'turn_on', humidifier: 'turn_on',
        media_player: 'turn_on', input_boolean: 'turn_on',
    },
    off: {
        light: 'turn_off', switch: 'turn_off', fan: 'turn_off', humidifier: 'turn_off',
        media_player: 'turn_off', input_boolean: 'turn_off',
    },
};

function serialize(entity: EntityState, connected: boolean) {
    return {
        entity_id: entity.entityId,
        domain: entity.domain,
        slug: entity.slug,
        state: entity.state,
        // Passed through whole: attributes are how a caller derives which
        // controls an entity supports (device_class, current_position, …).
        attributes: entity.attributes,
        last_changed: entity.lastChanged ?? null,
        observed_at: entity.observedAt.toISOString(),
        // False only when our link to Home Assistant is down, in which case
        // this is the last state we saw rather than the current one.
        verified: connected,
    };
}

function commandStatus(result: CommandResult): number {
    if (result.status !== 'failed') return 200;
    const reason = result.reason ?? '';
    if (reason === 'home_assistant_unavailable') return 503;
    // Home Assistant's own words for an unknown entity or a bad parameter.
    if (/not found|unknown|no entity|invalid|required key|extra keys/i.test(reason)) return 400;
    return 502;
}

function sendCommandResult(res: Response, result: CommandResult): void {
    res.status(commandStatus(result)).json({
        status: result.status,
        command_id: result.commandId,
        state: result.newState ?? null,
        reason: result.reason ?? null,
        attribution: result.attribution ?? null,
        timings: {
            call_ms: result.timings.callMs,
            state_echo_ms: result.timings.stateEchoMs ?? null,
        },
    });
}

function badRequest(res: Response, code: string, message: string): null {
    res.status(400).json({ error: { code, message } });
    return null;
}

export function entitiesRouter(client: HaClient, config: Config): Router {
    const router = Router();

    function permitted(entityId: string): boolean {
        const dot = entityId.indexOf('.');
        if (dot < 1) return false;
        if (config.allowedEntities.size > 0) return config.allowedEntities.has(entityId);
        return config.allowedDomains.has(entityId.slice(0, dot));
    }

    /** Everything a service call must clear before it reaches Home Assistant. */
    function guard(req: AuthedRequest, res: Response): { domain: string; slug: string } | null {
        const { domain, slug } = req.params;
        if (!DOMAIN_RE.test(domain)) return badRequest(res, 'INVALID_DOMAIN', 'Domain must match [a-z_]+');
        if (!SLUG_RE.test(slug)) return badRequest(res, 'INVALID_ENTITY_SLUG', 'Slug must match [a-z0-9_]+');

        if (!permitted(`${domain}.${slug}`)) {
            res.status(403).json({
                error: {
                    code: 'ENTITY_NOT_ALLOWED',
                    message: `Entity "${domain}.${slug}" is not permitted by allowed_entities/allowed_domains`,
                },
            });
            return null;
        }
        if (!client.isConnected()) {
            res.status(503).json({
                error: { code: 'HOME_ASSISTANT_UNAVAILABLE', message: 'Not connected to Home Assistant' },
            });
            return null;
        }
        return { domain, slug };
    }

    // ---- Reads -------------------------------------------------------------

    router.get('/entities', (req, res) => {
        const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
        const connected = client.isConnected();
        res.json({
            house_id: config.houseId,
            home_assistant_connected: connected,
            entities: client.listEntities(domain).map((e) => serialize(e, connected)),
        });
    });

    router.get('/entities/:domain/:slug', (req, res) => {
        const entityId = `${req.params.domain}.${req.params.slug}`;
        const entity = client.getEntity(entityId);
        if (!entity || !permitted(entityId)) {
            res.status(404).json({
                error: { code: 'ENTITY_NOT_FOUND', message: `No permitted entity "${entityId}"` },
            });
            return;
        }
        res.json(serialize(entity, client.isConnected()));
    });

    // ---- Commands ----------------------------------------------------------

    /** The general form: any Home Assistant service on an allowed entity. */
    router.post('/entities/:domain/:slug/command', asyncHandler(async (req: AuthedRequest, res: Response) => {
        const target = guard(req, res);
        if (!target) return;

        const body = req.body ?? {};
        let service: string;
        if (typeof body.command === 'string') {
            // Fully qualified. The domain must match the URL, or the call and
            // the entity would disagree about what is being operated.
            if (!body.command.startsWith(`${target.domain}.`)) {
                badRequest(res, 'COMMAND_DOMAIN_MISMATCH',
                    `Command "${body.command}" does not belong to domain "${target.domain}"`);
                return;
            }
            service = body.command.slice(target.domain.length + 1);
        } else if (typeof body.action === 'string') {
            service = body.action;
        } else {
            badRequest(res, 'INVALID_REQUEST',
                'Provide "action" (e.g. "open_cover") or "command" (e.g. "cover.open_cover")');
            return;
        }
        if (!SERVICE_RE.test(service)) {
            badRequest(res, 'INVALID_ACTION', 'action must match [a-z0-9_]+');
            return;
        }

        const data = body.parameters;
        if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) {
            badRequest(res, 'INVALID_PARAMETERS', 'parameters must be a JSON object');
            return;
        }

        sendCommandResult(res, await client.callService({ ...target, service, data, actor: req.actor! }));
    }));

    router.post('/entities/:domain/:slug/:verb', asyncHandler(async (req: AuthedRequest, res: Response) => {
        const verb = req.params.verb;
        const byDomain = VERB_SERVICES[verb];
        if (!byDomain) {
            res.status(404).json({
                error: {
                    code: 'UNKNOWN_VERB',
                    message: `No such verb "${verb}". Known verbs: ${Object.keys(VERB_SERVICES).join(', ')}. ` +
                        'Use POST .../command for anything else.',
                },
            });
            return;
        }
        const target = guard(req, res);
        if (!target) return;

        const service = byDomain[target.domain];
        if (!service) {
            res.status(400).json({
                error: {
                    code: 'VERB_NOT_SUPPORTED',
                    message: `Verb "${verb}" has no meaning for domain "${target.domain}". ` +
                        `It applies to: ${Object.keys(byDomain).join(', ')}.`,
                },
            });
            return;
        }
        sendCommandResult(res, await client.callService({ ...target, service, actor: req.actor! }));
    }));

    /** Re-fetch every state. The escape hatch if the cache is ever doubted. */
    router.post('/refresh', asyncHandler(async (_req, res) => {
        const ok = await client.refresh();
        res.status(ok ? 200 : 503).json({ status: ok ? 'refreshed' : 'unavailable' });
    }));

    return router;
}
