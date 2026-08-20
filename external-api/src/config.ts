/**
 * Configuration, resolved once at boot.
 *
 * Everything this service needs is an environment variable. That is the whole
 * difference from the v2 API's equivalent code, where the broker endpoint
 * comes from `mqtt_configs` and the credential is minted per broker by the
 * Admin Panel. Here the operator supplies both.
 *
 * Misconfiguration fails at startup, loudly. A service that boots and then
 * cannot reach a broker looks healthy to Docker while every command times out.
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
    houseId: string;
    database: {
        url: string;
        connectTimeoutMs: number;
        poolMax: number;
    };
    mqtt: {
        host: string;
        port: number;
        tls: boolean;
        rejectUnauthorized: boolean;
        username?: string;
        password?: string;
    };
    apiKeys: ApiKey[];
    /** Domains an external system may command. Reads are not restricted by it. */
    allowedDomains: Set<string>;
    /** Fully qualified entity ids (`cover.garage`). Empty means "any exposed entity". */
    allowedEntities: Set<string>;
    actorEmailDomain: string;
    confirmTimeoutMs: number;
    reloadMinIntervalMs: number;
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

export function loadConfig(): Config {
    const tls = bool('MQTT_TLS', false);
    const domains = list('ALLOWED_DOMAINS');
    return {
        port: int('PORT', 8080),
        // The Turzi Protocol topic namespace. In Turzi Cloud this is the
        // community id, because one bridge serves a whole community — but the
        // protocol is agnostic, so whatever the bridge was enrolled with wins.
        houseId: required('TURZI_HOUSE_ID'),
        database: {
            url: required('DATABASE_URL'),
            // Generous, because Home Assistant does not order add-on startup:
            // MariaDB may still be coming up when this one starts.
            connectTimeoutMs: int('DATABASE_CONNECT_TIMEOUT_MS', 60_000),
            poolMax: int('DATABASE_POOL_MAX', 5),
        },
        mqtt: {
            host: required('MQTT_HOST'),
            port: int('MQTT_PORT', tls ? 8883 : 1883),
            tls,
            // Escape hatch for a broker with a self-signed certificate. Off by
            // default: an unverified TLS connection to a door controller is
            // worse than an honest plaintext one, because it looks secure.
            rejectUnauthorized: bool('MQTT_TLS_REJECT_UNAUTHORIZED', true),
            username: process.env.MQTT_USERNAME?.trim() || undefined,
            password: process.env.MQTT_PASSWORD || undefined,
        },
        apiKeys: parseApiKeys(),
        allowedDomains: new Set(domains.length ? domains : DEFAULT_DOMAINS),
        allowedEntities: parseAllowedEntities(),
        actorEmailDomain: process.env.ACTOR_EMAIL_DOMAIN?.trim() || 'external-api.turzi.local',
        // Protocol v1.1 suggests clients time out around 5 s. We resolve a
        // little earlier so the HTTP caller is not the one waiting on the edge.
        confirmTimeoutMs: int('COMMAND_CONFIRM_TIMEOUT_MS', 4000),
        reloadMinIntervalMs: int('RELOAD_MIN_INTERVAL_MS', 10_000),
        logRequests: bool('LOG_REQUESTS', true),
    };
}

export { ConfigError };
