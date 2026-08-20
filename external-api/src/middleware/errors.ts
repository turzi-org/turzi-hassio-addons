/**
 * Error plumbing, carried over from the v2 API's shared middleware so the
 * error envelope is the same shape a Turzi client already parses.
 */

import { Request, Response, NextFunction } from 'express';

export class HttpError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message?: string,
        readonly details?: unknown,
    ) {
        super(message ?? code);
    }
}

export const errorHandler = (
    err: any,
    _req: Request,
    res: Response,
    _next: NextFunction,
): void => {
    if (err instanceof HttpError) {
        res.status(err.status).json({
            error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
        });
        return;
    }

    console.error('[error]', err);
    res.status(err.status || 500).json({
        error: {
            code: err.code || 'INTERNAL_SERVER_ERROR',
            message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred',
        },
    });
};

export const notFoundHandler = (req: Request, res: Response): void => {
    res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` },
    });
};

/**
 * Async handler wrapper to catch errors in async route handlers.
 * Using a specific type instead of `Function` lets TypeScript infer
 * `req` and `res` types in every route callback automatically.
 */
export const asyncHandler = (
    fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) => {
    return (req: Request, res: Response, next: NextFunction): void => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};
