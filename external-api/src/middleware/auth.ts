/**
 * Bearer API-key authentication.
 *
 * The v2 API authenticates residents through Cognito and staff through the
 * TCM session; neither exists here, and the caller is a machine. So: static
 * keys, supplied as `label:secret` in `API_KEYS`, revoked by redeploying.
 *
 * The label becomes the command's actor. Every open and close this service
 * relays is therefore attributable to a named integration in the Home
 * Assistant logbook — which is the only audit trail this stopgap has, since
 * it writes to no ledger of its own.
 */

import { createHash, timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { ApiKey, Config } from '../config';

export interface AuthedRequest extends Request {
    actor?: { name: string; email: string };
}

/**
 * Compare digests, never the secrets themselves: hashing first makes every
 * comparison the same 32 bytes, so neither the key's length nor the position
 * of its first wrong character is observable in the response time.
 */
function matches(presented: Buffer, key: ApiKey): boolean {
    return timingSafeEqual(presented, key.digest);
}

export function apiKeyAuth(config: Config) {
    return (req: AuthedRequest, res: Response, next: NextFunction): void => {
        const header = req.headers.authorization ?? '';
        const token = header.replace(/^Bearer\s+/i, '').trim();
        if (!token) {
            res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing bearer token' } });
            return;
        }

        const presented = createHash('sha256').update(token).digest();
        // Every key is checked even after a hit, so the number of comparisons
        // does not reveal which key matched.
        let matched: ApiKey | undefined;
        for (const key of config.apiKeys) {
            if (matches(presented, key)) matched = key;
        }
        if (!matched) {
            res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
            return;
        }

        req.actor = {
            name: matched.label,
            email: `${matched.label}@${config.actorEmailDomain}`,
        };
        next();
    };
}
