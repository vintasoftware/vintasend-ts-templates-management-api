/**
 * Who is calling, and whether they may.
 *
 * Every `/api/v1` request goes through one `Authenticator` before it reaches a route. It refuses a
 * caller by throwing — `ApiError.unauthorized` when no valid credential was presented,
 * `ApiError.forbidden` when it knows who the caller is and they may not do this — and otherwise
 * says who the caller is, for the status audit trail.
 *
 * A host that authenticates its own users passes an authenticator reading its session. A
 * deployment with one shared secret passes `apiKeyAuthenticator(key)`.
 */

import type { Context, MiddlewareHandler } from 'hono';

import { ApiError } from '../errors.js';

/** What an authenticator learned about the caller. */
export type Authenticated = {
  /**
   * The identity a status change is attributed to. It replaces any `changedBy` in the request
   * body, so a caller cannot write someone else's identity into the trail, and `null` records
   * the change as unattributed.
   *
   * Leave it out when the credential says nothing about who is calling — a shared key — and
   * `changedBy` is taken from the body. That is only safe when every caller holding the
   * credential is trusted to attribute honestly.
   */
  actor?: string | null;
};

/** Refuses the caller by throwing an `ApiError`, or says who they are. */
export type Authenticator = (c: Context) => Authenticated | Promise<Authenticated>;

const AUTHENTICATED = 'vintasend-templates-management-api.authenticated';

/** Runs `authenticate` on every request it guards, and keeps what it learned for the routes. */
export function authenticateWith(authenticate: Authenticator): MiddlewareHandler {
  return async (c, next) => {
    c.set(AUTHENTICATED, await authenticate(c));
    await next();
  };
}

/** What the authenticator learned about this request's caller. */
export function authenticated(c: Context): Authenticated {
  return (c.get(AUTHENTICATED) as Authenticated | undefined) ?? {};
}

const encoder = new TextEncoder();

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/**
 * Compare two secrets in time that depends on neither, so a wrong key cannot be found one
 * character at a time.
 *
 * Both are hashed first, so the comparison is always of two 32-byte digests and the length of the
 * expected key does not leak either. Web Crypto rather than `node:crypto`, so the app runs
 * wherever `fetch` does.
 */
async function safeEquals(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(a), sha256(b)]);
  let difference = 0;
  left.forEach((byte, index) => {
    difference |= byte ^ (right[index] ?? 0);
  });
  return difference === 0;
}

/**
 * The token in an `Authorization: Bearer <token>` header, or `null` when there is none.
 *
 * The scheme is matched in any case, as RFC 9110 has it. For a host writing its own
 * `Authenticator` around a token it verifies itself, such as the caller's own identity-provider
 * token.
 */
export function bearerToken(header: string | undefined): string | null {
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return token ? token : null;
}

/**
 * The shared-secret authenticator: every request must carry `Authorization: Bearer <apiKey>`.
 *
 * It says nothing about who is calling, so status changes keep the body's `changedBy`.
 */
export function apiKeyAuthenticator(apiKey: string): Authenticator {
  return async (c) => {
    const token = bearerToken(c.req.header('authorization'));

    if (!token || !(await safeEquals(token, apiKey))) {
      throw ApiError.unauthorized('A valid API key is required.');
    }

    return {};
  };
}
