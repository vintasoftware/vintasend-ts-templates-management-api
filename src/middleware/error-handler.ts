/**
 * Maps thrown errors to the contract's error envelope.
 *
 * Unexpected errors are logged in full but reported generically, so backend internals — a
 * connection string, a credential in a driver's message — never leak to a client.
 */

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { ApiErrorResponse } from '../contract/types.js';
import { ApiError } from '../errors.js';

export function handleError(error: Error, c: Context): Response {
  if (error instanceof ApiError) {
    return c.json<ApiErrorResponse>(error.toResponseBody(), error.status as 400);
  }

  if (error instanceof HTTPException) {
    return c.json<ApiErrorResponse>(
      { error: { code: 'BAD_REQUEST', message: error.message } },
      error.status,
    );
  }

  console.error('[vintasend-templates-api] unhandled error', error);

  return c.json<ApiErrorResponse>(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred while handling the request.',
      },
    },
    500,
  );
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
