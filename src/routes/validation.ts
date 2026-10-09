import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { invalidRequest } from '../errors.js';

/** The media types Hono's validator parses as JSON: the same pattern as Hono's own `jsonRegex`. */
const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

/**
 * Whether the request carries a body Hono's validator would not read as JSON.
 *
 * Hono validates a request that declares no JSON media type as `{}`. That is right for an empty
 * body — it is how an all-optional body is omitted — and wrong for any other: on the lifecycle
 * routes `{}` means "act on the latest version", so `curl -d '{"version":2}'` (form-encoded unless
 * told otherwise) would archive the latest version instead of v2, and archiving cannot be undone.
 *
 * Decided by reading the body rather than from `content-length` or `transfer-encoding`: a body
 * with no `Content-Type` (a `Uint8Array` handed to `fetch`) or a streamed HTTP/2 body carries
 * neither header.
 */
async function hasNonJsonBody(c: Context): Promise<boolean> {
  const contentType = c.req.header('content-type');
  if (contentType !== undefined && JSON_CONTENT_TYPE.test(contentType)) {
    return false;
  }
  return (await c.req.text()).length > 0;
}

/**
 * `zValidator` with the contract's error envelope: invalid input always comes back as a 400
 * `BAD_REQUEST` listing the offending fields, in the same shape the Python implementation
 * produces — so a client can read `details.issues` without knowing which server answered.
 *
 * A `json` target also applies the contract's media-type rule. A request declaring a JSON media
 * type must carry valid JSON (Hono refuses an empty or malformed one, and the error handler gives
 * that refusal the same envelope). Any other request is read as `{}` when its body is empty, and
 * refused when it is not.
 */
export function validate<Target extends 'query' | 'json' | 'param', Schema extends ZodType>(
  target: Target,
  schema: Schema,
) {
  return zValidator(target, schema, async (result, c) => {
    if (target === 'json' && (await hasNonJsonBody(c))) {
      throw invalidRequest([{ path: [], message: 'Send the request body as application/json.' }]);
    }
    if (!result.success) {
      throw invalidRequest(result.error.issues);
    }
  });
}
