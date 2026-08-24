/**
 * Configuration, resolved once at boot.
 *
 * Everything is an environment variable; as an add-on, run.sh fills them from
 * the add-on options and from the Supervisor. Misconfiguration fails at
 * startup, loudly — a service that boots and then cannot reach Home Assistant
 * looks healthy to the Supervisor while every command fails.
 */

import { createHash } from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Domains this service is willing to relay, copied from the v2 API's
 * device-command resolver. Expand deliberately, not by default: an external
 * system that can address any domain HA happens to expose is a much larger
 * blast radius than one that can work doors, lights and climate.
 */
const DEFAULT_DOMAINS = [
    'lock', 'cover', 'alarm_control_panel', 'light', 'switch', 'climate', 'fan',
    'media_player', 'vacuum', 'humidifier', 'scene', 'script', 'button', 'input_boolean',
];

export interface ApiKey {
    /** Used as `metadata.user_name` on every command, so it lands in the HA logbook. */
    label: string;
    /** sha256 of the key — the plaintext is never retained past boot. */
    digest: Buffer;
}

export interface Config {
    port: number;
    /**
     * A label stamped on every log row, identifying the building. It no longer
     * selects an MQTT topic namespace — this add-on talks to Home Assistant
     * directly — but the log is worth being able to attribute to a site.
     */
    houseId: string;
    ha: {
        wsUrl: string;
        token: string;
    };
    database: {
        url: string;
        connectTimeoutMs: number;
        poolMax: number;
    };
    apiKeys: ApiKey[];
    /** Domains an external system may command. Reads are not restricted by it. */
    allowedDomains: Set<string>;
    /** Fully qualified entity ids (`cover.garage`). Empty means "any exposed entity". */
    allowedEntities: Set<string>;
    actorEmailDomain: string;
    confirmTimeoutMs: number;
    logRequests: boolean;
}

class ConfigError extends Error {}

function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new ConfigError(`${name} is required`);
    return value;
}

function bool(name: string, fallback: boolean): boolean {
    const raw = process.env[name]?.trim().toLowerCase();
    if (raw === undefined || raw === '') return fallback;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    throw new ConfigError(`${name} must be a boolean, got "${raw}"`);
}

function int(name: string, fallback: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
    return parsed;
}

function list(name: string): string[] {
    return (process.env[name]?.trim() ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * `API_KEYS` is `label:secret` pairs, comma separated. The label is not
 * decoration: it is stamped into every command's `metadata.user_name`, which
 * the bridge writes to the Home Assistant logbook and this service writes to
 * its own action log. Without it every record says a door was opened by
 * "Unknown", which is the same as saying nothing.
 */
function parseApiKeys(): ApiKey[] {
    const raw = required('API_KEYS');
    const keys = raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry, index) => {
            const sep = entry.indexOf(':');
            const label = sep === -1 ? `key-${index + 1}` : entry.slice(0, sep).trim();
            const secret = sep === -1 ? entry : entry.slice(sep + 1).trim();
            if (!secret) throw new ConfigError(`API_KEYS entry ${index + 1} has an empty secret`);
            if (secret.length < 16) {
                throw new ConfigError(
                    `API_KEYS entry "${label}" is shorter than 16 characters — this key opens doors`,
                );
            }
            return { label, digest: createHash('sha256').update(secret).digest() };
        });
    if (keys.length === 0) throw new ConfigError('API_KEYS is empty');
    return keys;
}

function parseAllowedEntities(): Set<string> {
    const entities = list('ALLOWED_ENTITIES');
    for (const id of entities) {
        if (!/^[a-z_]+\.[a-z0-9_]+$/.test(id)) {
            throw new ConfigError(
                `ALLOWED_ENTITIES entry "${id}" is not an entity id — use the full form, e.g. "cover.garage"`,
            );
        }
    }
    return new Set(entities);
}

/**
 * Home Assistant's WebSocket endpoint. As an add-on this is the Supervisor's
 * proxy, set by run.sh; standalone, it is derived from HA_URL so nobody has to
 * remember that the path is /api/websocket.
 */
function haWsUrl(): string {
    const explicit = process.env.HA_WS_URL?.trim();
    if (explicit) return explicit;
    const base = required('HA_URL').replace(/\/+$/, '');
    return `${base.replace(/^http/, 'ws')}/api/websocket`;
}

export function loadConfig(): Config {
    const domains = list('ALLOWED_DOMAINS');
    return {
        port: int('PORT', 8080),
        houseId: required('TURZI_HOUSE_ID'),
        database: {
            url: required('DATABASE_URL'),
            // Generous, because Home Assistant does not order add-on startup:
            // MariaDB may still be coming up when this one starts.
            connectTimeoutMs: int('DATABASE_CONNECT_TIMEOUT_MS', 60_000),
            poolMax: int('DATABASE_POOL_MAX', 5),
        },
        ha: {
            wsUrl: haWsUrl(),
            token: required('HA_TOKEN'),
        },
        apiKeys: parseApiKeys(),
        allowedDomains: new Set(domains.length ? domains : DEFAULT_DOMAINS),
        allowedEntities: parseAllowedEntities(),
        actorEmailDomain: process.env.ACTOR_EMAIL_DOMAIN?.trim() || 'external-api.turzi.local',
        // Home Assistant fires the state change within milliseconds of the
        // service returning, so this is a backstop, not a normal wait.
        confirmTimeoutMs: int('COMMAND_CONFIRM_TIMEOUT_MS', 4000),
        logRequests: bool('LOG_REQUESTS', true),
    };
}

export { ConfigError };
