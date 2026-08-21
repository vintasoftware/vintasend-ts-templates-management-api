/**
 * Shared-secret authentication.
 *
 * Every `/api/v1` request must carry `Authorization: Bearer <MANAGED_TEMPLATE_API_KEY>`.
 * Comparison is constant-time, so a wrong key cannot be found one character at a time.
 */

import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

import { ApiError } from '../errors.js';

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

function extractToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

export function apiKeyAuth(apiKey: string): MiddlewareHandler {
  return async (c, next) => {
    const token = extractToken(c.req.header('authorization'));

    if (!token || !safeEquals(token, apiKey)) {
      throw new ApiError('UNAUTHORIZED', 'A valid API key is required.');
    }

    await next();
  };
}
