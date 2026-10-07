/**
 * Maps thrown errors to the contract's error envelope.
 *
 * Unexpected errors are reported generically, so backend internals — a connection string, a
 * credential in a driver's message — never leak to a client. They are not logged whole either:
 * an error from the template store or the template engine can carry resource content or values
 * from a preview's context, and the applications this API serves handle health data. The default
 * log line names the error's class, a request id and the route, and nothing else. A host that
 * wants more — an error tracker with its own scrubbing, say — injects `onUnhandledError`.
 */

import { randomUUID } from 'node:crypto';
import type { Context, ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { ApiErrorResponse } from '../contract/types.js';
import { ApiError } from '../errors.js';

/**
 * Receives every error the API does not map to a contract error, before the generic 500 is sent.
 *
 * It is handed the error object itself, so whatever it does with it is the host's call — and the
 * host's responsibility to keep health data out of its logs. `requestId` is the id the 500
 * response carries in its `X-Request-Id` header, for matching a client's report to the log.
 */
export type UnhandledErrorHandler = (
  error: Error,
  c: Context,
  details: { requestId: string },
) => void | Promise<void>;

export const REQUEST_ID_HEADER = 'x-request-id';

/** Only a request id that cannot break a log line out of its field is taken from the client. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** The caller's `X-Request-Id` when it is safe to log, otherwise a fresh one. */
export function requestIdFor(c: Context): string {
  const supplied = c.req.header(REQUEST_ID_HEADER);
  return supplied !== undefined && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
}

/**
 * The default `onUnhandledError`: one line with the error's class name, the request id and the
 * matched route pattern — never the error's message, its stack, the request body or a preview
 * context.
 */
export function logUnhandledError(
  error: Error,
  c: Context,
  { requestId }: { requestId: string },
): void {
  console.error(
    `[vintasend-templates-api] unhandled ${error.constructor?.name || 'Error'} ` +
      `(request ${requestId}) on ${c.req.method} ${c.req.routePath}`,
  );
}

/**
 * Hand `error` to the configured handler, falling back to `logUnhandledError` if it throws.
 *
 * The error is still recorded somewhere when a host's handler breaks. What the handler threw is
 * never logged — it is no safer than the error it was handling — and a broken logging setup must
 * not turn a 500 into a crash.
 */
async function reportUnhandledError(
  handler: UnhandledErrorHandler,
  error: Error,
  c: Context,
  requestId: string,
): Promise<void> {
  try {
    await handler(error, c, { requestId });
    return;
  } catch {
    // Fall through to the default line.
  }
  if (handler === logUnhandledError) {
    return;
  }
  try {
    logUnhandledError(error, c, { requestId });
  } catch {
    // Nothing left to report to.
  }
}

export function createErrorHandler(
  onUnhandledError: UnhandledErrorHandler = logUnhandledError,
): ErrorHandler {
  return async (error, c) => {
    if (error instanceof ApiError) {
      return c.json<ApiErrorResponse>(error.toResponseBody(), error.status as 400);
    }

    if (error instanceof HTTPException) {
      return c.json<ApiErrorResponse>(
        { error: { code: 'BAD_REQUEST', message: error.message } },
        error.status,
      );
    }

    const requestId = requestIdFor(c);
    await reportUnhandledError(onUnhandledError, error, c, requestId);

    c.header(REQUEST_ID_HEADER, requestId);
    return c.json<ApiErrorResponse>(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred while handling the request.',
        },
      },
      500,
    );
  };
}

export function handleNotFound(c: Context): Response {
  return c.json<ApiErrorResponse>(
    {
      error: {
        code: 'NOT_FOUND',
        message: `No route matches ${c.req.method} ${new URL(c.req.url).pathname}.`,
      },
    },
    404,
  );
}
