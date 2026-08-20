/**
 * Command TTL policy (Turzi Protocol v1.1 §2).
 *
 * Copied from the v2 API. Which TTL a publisher requests per domain is
 * publisher-side policy and deliberately not settable by the caller — an
 * external system cannot ask us to widen the window in which its command
 * stays valid.
 *
 * Bridges clamp whatever we request to their own local ceiling (default 300s),
 * so values here only ever shorten the window.
 */

const DEFAULT_TTLS: Record<string, number> = {
    // Actuation domains: a command that arrives 30s late no longer represents
    // anyone's intent, and a door is not a light bulb.
    lock: 30,
    cover: 30,
    alarm_control_panel: 30,
    default: 60,
};

function loadOverrides(): Record<string, number> {
    const raw = process.env.MQTT_COMMAND_TTLS;
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
    } catch {
        console.warn('[ttl-policy] MQTT_COMMAND_TTLS is not valid JSON — ignoring');
    }
    return {};
}

const ttls: Record<string, number> = { ...DEFAULT_TTLS, ...loadOverrides() };

export function ttlForDomain(domain: string): number {
    return ttls[domain] ?? ttls.default ?? 60;
}
