/**
 * Entity endpoints — read state, issue commands.
 *
 * Reads are served from the retained-state cache: the bridge publishes every
 * exposed entity retained, so the cache mirrors broker truth rather than
 * guessing at it. Writes go out as Turzi Protocol commands and block until the
 * bridge acks and echoes, or the confirm window closes.
 */

import { Router, Response } from 'express';
import { Config } from '../config';
import { asyncHandler } from '../middleware/errors';
import { AuthedRequest } from '../middleware/auth';
import { Availability, CommandResult, EntityState, TurziClient } from '../mqtt/turzi-client';

/** Same rules the v2 API enforces before it will relay a command. */
const DOMAIN_RE = /^[a-z_]+$/;
const SLUG_RE = /^[a-z0-9_]+$/;
const ACTION_RE = /^[a-z0-9_]+$/;

/**
 * Convenience verbs, one URL per intent, resolved per domain — the same shape
 * as the v2 resolver's verb table. The generic `/command` endpoint below can
 * express anything Home Assistant offers; this exists because an external
 * system integrating one door should not have to know that the service is
 * called `cover.open_cover`.
 */
const VERB_COMMANDS: Record<string, Record<string, string>> = {
    open: { cover: 'cover.open_cover' },
    close: { cover: 'cover.close_cover' },
    stop: { cover: 'cover.stop_cover', vacuum: 'vacuum.stop', media_player: 'media_player.media_stop' },
    lock: { lock: 'lock.lock' },
    unlock: { lock: 'lock.unlock' },
    on: {
        light: 'light.turn_on', switch: 'switch.turn_on', fan: 'fan.turn_on',
        humidifier: 'humidifier.turn_on', media_player: 'media_player.turn_on',
        input_boolean: 'input_boolean.turn_on',
    },
    off: {
        light: 'light.turn_off', switch: 'switch.turn_off', fan: 'fan.turn_off',
        humidifier: 'humidifier.turn_off', media_player: 'media_player.turn_off',
        input_boolean: 'input_boolean.turn_off',
    },
};

/**
 * Ack reasons are free-form but the protocol names the well-known ones
 * (PROTOCOL.md §1 — Command Acknowledgment). Mapping them is what makes a
 * typo'd entity a 404 instead of an opaque 502.
 */
const REASON_STATUS: Record<string, number> = {
    entity_not_exposed: 404,
    entity_unavailable: 404,
    unsupported_command: 400,
    invalid_parameters: 400,
    expired: 504,
    platform_error: 502,
};

interface Link {
    availability: Availability;
    connected: boolean;
}

function serialize(entity: EntityState, link: Link) {
    return {
        entity_id: entity.entityId,
        domain: entity.domain,
        slug: entity.slug,
        state: entity.state,
        // Passed through whole: attributes are the capability surface
        // (PROTOCOL.md §1 — Design Principles), so a caller deriving controls
        // from `hvac_modes` or `device_class` needs them unfiltered.
        attributes: entity.attributes,
        last_changed: entity.lastChanged ?? null,
        observed_at: entity.observedAt.toISOString(),
        // PROTOCOL.md §1 — Availability: while the house is offline all of its
        // entity state is stale-but-displayable, and a caller that cannot tell
        // the difference will act on a door state from an hour ago. Our own
        // dropped link says exactly the same thing about the cache, so it
        // clears the flag too; `unknown` alone does not, since a v1.0 bridge
        // publishes no availability and its state is still current.
        verified: link.connected && link.availability !== 'offline',
        house_availability: link.availability,
    };
}

function commandStatus(result: CommandResult): number {
    if (result.status === 'confirmed' || result.status === 'executed') return 200;
    if (result.status === 'accepted') return 202;
    const reason = result.reason ?? '';
    if (reason.startsWith('broker_unreachable') || reason.startsWith('publish_failed')) return 503;
    return REASON_STATUS[reason] ?? 502;
}

function sendCommandResult(res: Response, result: CommandResult): void {
    res.status(commandStatus(result)).json({
        status: result.status,
        command_id: result.commandId,
        state: result.newState ?? null,
        reason: result.reason ?? null,
        // How much a `confirmed` is worth: 'command_id' is proof the core
        // attributed this change to this command, 'inferred' is the best a
        // v1.0 core allows — the first change on the entity while the command
        // was in flight.
        attribution: result.attribution ?? null,
        timings: {
            publish_ms: result.timings.publishMs,
            ack_ms: result.timings.ackMs ?? null,
            state_echo_ms: result.timings.stateEchoMs ?? null,
        },
    });
}

function badRequest(res: Response, code: string, message: string): null {
    res.status(400).json({ error: { code, message } });
    return null;
}

export function entitiesRouter(client: TurziClient, config: Config): Router {
    const router = Router();

    const link = (): Link => ({ availability: client.availability(), connected: client.isConnected() });

    function permitted(entityId: string): boolean {
        return config.allowedEntities.size === 0 || config.allowedEntities.has(entityId);
    }

    /**
     * Everything an actuation must clear before it reaches the broker.
     * Returns the entity, or null having already answered the request.
     *
     * Deliberately absent: a check that the entity is in the cache. The bridge
     * is the authority on what is exposed and says so in its ack, and refusing
     * locally would turn a cold cache in the seconds after startup into a
     * refused door.
     */
    function guard(req: AuthedRequest, res: Response): { domain: string; slug: string } | null {
        const { domain, slug } = req.params;
        if (!DOMAIN_RE.test(domain)) return badRequest(res, 'INVALID_DOMAIN', 'Domain must match [a-z_]+');
        if (!SLUG_RE.test(slug)) return badRequest(res, 'INVALID_ENTITY_SLUG', 'Slug must match [a-z0-9_]+');

        if (!config.allowedDomains.has(domain)) {
            res.status(403).json({
                error: { code: 'DOMAIN_NOT_ALLOWED', message: `Domain "${domain}" is not in ALLOWED_DOMAINS` },
            });
            return null;
        }
        if (!permitted(`${domain}.${slug}`)) {
            res.status(403).json({
                error: {
                    code: 'ENTITY_NOT_ALLOWED',
                    message: `Entity "${domain}.${slug}" is not in ALLOWED_ENTITIES`,
                },
            });
            return null;
        }
        // Our own link first: with the broker unreachable we do not know what
        // the house is doing, and answering HOUSE_OFFLINE here would blame a
        // community for an outage on this side.
        if (!client.isConnected()) {
            res.status(503).json({
                error: { code: 'BROKER_UNREACHABLE', message: 'Not connected to the MQTT broker' },
            });
            return null;
        }
        // Fail fast rather than publishing into a house that cannot answer.
        // `unknown` is not a refusal: v1.0 bridges publish no availability.
        if (client.availability() === 'offline') {
            res.status(503).json({
                error: { code: 'HOUSE_OFFLINE', message: 'The smart home core is offline' },
            });
            return null;
        }
        return { domain, slug };
    }

    // ---- Reads -------------------------------------------------------------

    router.get('/entities', (req, res) => {
        const current = link();
        const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
        res.json({
            house_id: config.houseId,
            house_availability: current.availability,
            broker_connected: current.connected,
            protocol: client.protocolMode(),
            entities: client.listEntities(domain)
                .filter((e) => permitted(e.entityId))
                .map((e) => serialize(e, current)),
        });
    });

    router.get('/entities/:domain/:slug', (req, res) => {
        const entityId = `${req.params.domain}.${req.params.slug}`;
        const entity = client.getEntity(entityId);
        if (!entity || !permitted(entityId)) {
            res.status(404).json({
                error: { code: 'ENTITY_NOT_FOUND', message: `No exposed entity "${entityId}" in this house` },
            });
            return;
        }
        res.json(serialize(entity, link()));
    });

    // ---- Commands ----------------------------------------------------------

    /**
     * The general form: any Home Assistant service on any allowed domain.
     * Registered before the verb route so `/command` is never read as a verb.
     */
    router.post('/entities/:domain/:slug/command', asyncHandler(async (req: AuthedRequest, res: Response) => {
        const target = guard(req, res);
        if (!target) return;

        const body = req.body ?? {};
        let command: string;
        if (typeof body.command === 'string') {
            // Fully qualified. The domain must match the URL, or the topic and
            // the payload would disagree about which entity is being addressed.
            if (!body.command.startsWith(`${target.domain}.`)) {
                badRequest(res, 'COMMAND_DOMAIN_MISMATCH',
                    `Command "${body.command}" does not belong to domain "${target.domain}"`);
                return;
            }
            command = body.command;
        } else if (typeof body.action === 'string') {
            if (!ACTION_RE.test(body.action)) {
                badRequest(res, 'INVALID_ACTION', 'action must match [a-z0-9_]+');
                return;
            }
            command = `${target.domain}.${body.action}`;
        } else {
            badRequest(res, 'INVALID_REQUEST',
                'Provide "action" (e.g. "open_cover") or "command" (e.g. "cover.open_cover")');
            return;
        }

        const parameters = body.parameters;
        if (parameters !== undefined && (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters))) {
            badRequest(res, 'INVALID_PARAMETERS', 'parameters must be a JSON object');
            return;
        }

        sendCommandResult(res, await client.publishCommand({
            ...target, command, parameters, actor: req.actor!,
        }));
    }));

    router.post('/entities/:domain/:slug/:verb', asyncHandler(async (req: AuthedRequest, res: Response) => {
        const verb = req.params.verb;
        const byDomain = VERB_COMMANDS[verb];
        if (!byDomain) {
            res.status(404).json({
                error: {
                    code: 'UNKNOWN_VERB',
                    message: `No such verb "${verb}". Known verbs: ${Object.keys(VERB_COMMANDS).join(', ')}. ` +
                        'Use POST .../command for anything else.',
                },
            });
            return;
        }
        const target = guard(req, res);
        if (!target) return;

        const command = byDomain[target.domain];
        if (!command) {
            res.status(400).json({
                error: {
                    code: 'VERB_NOT_SUPPORTED',
                    message: `Verb "${verb}" has no meaning for domain "${target.domain}" ` +
                        `(supported: ${Object.keys(byDomain).join(', ')})`,
                },
            });
            return;
        }
        sendCommandResult(res, await client.publishCommand({ ...target, command, actor: req.actor! }));
    }));

    /**
     * Force the bridge to republish everything. Not normally needed — retained
     * state keeps the cache current — but it is the escape hatch when a bridge
     * has been restarted and the cache is suspected stale.
     */
    router.post('/refresh', asyncHandler(async (_req, res) => {
        const ok = await client.publishReload();
        res.status(ok ? 202 : 503).json({ status: ok ? 'requested' : 'unavailable' });
    }));

    return router;
}
