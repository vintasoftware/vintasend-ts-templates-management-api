import { zValidator } from '@hono/zod-validator';
import type { ZodSchema } from 'zod';

import type { JsonValue } from '../contract/types.js';
import { ApiError } from '../errors.js';

type ValidationTarget = 'query' | 'json' | 'param';

/**
 * `zValidator` with the contract's error envelope: invalid input always comes back as a 400
 * `BAD_REQUEST` listing the offending fields, in the same shape the Python implementation
 * produces — so a client can read `details.issues` without knowing which server answered.
 */
// biome-ignore lint/suspicious/noExplicitAny: mirrors zValidator's own signature
export function validate(target: ValidationTarget, schema: ZodSchema<any>) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      throw ApiError.badRequest('Invalid request.', {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      } as JsonValue);
    }
  });
}

/**
 * A JSON body that may be omitted entirely.
 *
 * Three routes take an optional body — activate, deactivate, archive and preview all have a
 * documented default — and `zValidator('json', ...)` refuses a request with no body at all rather
 * than applying it. Hono has no "optional body" target, so the body is read here and an absent one
 * becomes `{}` before validation.
 */
export async function readOptionalJson(c: {
  req: { header(name: string): string | undefined; json(): Promise<unknown> };
}): Promise<unknown> {
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return {};
  }
  try {
    return (await c.req.json()) ?? {};
  } catch {
    throw ApiError.badRequest('Invalid request.', {
      issues: [{ path: '', message: 'Body must be valid JSON' }],
    } as JsonValue);
  }
}
