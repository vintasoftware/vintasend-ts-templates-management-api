/**
 * How a JSON route reads its body, and the one 400 envelope every invalid input gets.
 *
 * - A request declaring a JSON media type must carry valid JSON; an empty body there is malformed.
 * - A request declaring no media type, or another one, is read as `{}` when its body is empty —
 *   which is what lets an all-optional body be omitted — and refused when it is not.
 * - Every 400 carries `details.issues`, whatever the mistake was.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type {
  ApiErrorResponse,
  DataResponse,
  ListResponse,
  ManagedTemplateOut,
} from '../src/contract/types.js';
import { API_KEY, createHarness, createInput, type Harness, post } from './helpers/fixtures.js';

let api: Harness;

beforeEach(async () => {
  api = createHarness();
  await api.service.createTemplate(createInput('welcome'));
  await api.service.updateTemplate('welcome', {});
});

/** POST exactly this body with exactly these headers: no JSON content type added for it. */
function raw(path: string, body: BodyInit | undefined, headers: Record<string, string> = {}) {
  return api.app.request(`http://localhost${path}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body }),
    headers: { authorization: `Bearer ${API_KEY}`, ...headers },
  });
}

async function statuses(): Promise<Record<number, string>> {
  const { body } = await api.json<ListResponse<ManagedTemplateOut>>(
    '/api/v1/templates/welcome/versions',
  );
  return Object.fromEntries(body.data.map((row) => [row.version, row.status]));
}

async function expectRefused(response: Response, message: string): Promise<void> {
  expect(response.status).toBe(400);
  const body = (await response.json()) as ApiErrorResponse;
  expect(body.error.code).toBe('BAD_REQUEST');
  expect(body.error.details).toEqual({ issues: [{ path: '', message }] });
}

describe('a body in another media type', () => {
  it('refuses a form-encoded body rather than acting on the latest version', async () => {
    // What `curl -d` sends. Read as `{}` it archived v2 instead of v1, and archiving cannot be
    // undone.
    const before = await statuses();

    const response = await raw('/api/v1/templates/welcome/archive', '{"version":1}', {
      'content-type': 'application/x-www-form-urlencoded',
    });

    await expectRefused(response, 'Send the request body as application/json.');
    expect(await statuses()).toEqual(before);
  });

  it('refuses a body with no content type at all', async () => {
    const before = await statuses();

    const response = await raw(
      '/api/v1/templates/welcome/archive',
      new TextEncoder().encode('{"version":1}'),
    );

    await expectRefused(response, 'Send the request body as application/json.');
    expect(await statuses()).toEqual(before);
  });

  it('reads an empty body as an omitted one', async () => {
    const response = await raw('/api/v1/templates/welcome/archive', '', {
      'content-type': 'text/plain',
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as DataResponse<ManagedTemplateOut>).data.version).toBe(2);
  });

  it('reads an absent body as an omitted one', async () => {
    const response = await raw('/api/v1/templates/welcome/archive', undefined);

    expect(response.status).toBe(200);
  });

  it('refuses a required body sent in another media type', async () => {
    const response = await raw('/api/v1/tags', 'text=urgent', {
      'content-type': 'application/x-www-form-urlencoded',
    });

    await expectRefused(response, 'Send the request body as application/json.');
  });
});

describe('a body declared as JSON', () => {
  it('reads a structured JSON media type as JSON', async () => {
    const response = await raw('/api/v1/templates/welcome/archive', '{"version":1}', {
      'content-type': 'application/merge-patch+json',
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as DataResponse<ManagedTemplateOut>).data.version).toBe(1);
  });

  it('refuses an empty body as malformed', async () => {
    const before = await statuses();

    const response = await raw('/api/v1/templates/welcome/archive', '', {
      'content-type': 'application/json',
    });

    await expectRefused(response, 'Malformed JSON in request body');
    expect(await statuses()).toEqual(before);
  });

  it('answers malformed JSON in the same envelope as any other invalid input', async () => {
    const response = await raw('/api/v1/templates/welcome/archive', '{"version":', {
      'content-type': 'application/json',
    });

    await expectRefused(response, 'Malformed JSON in request body');
  });

  it.each(['activate', 'deactivate', 'archive', 'preview'])(
    'refuses an invalid optional body on %s with a 400, not a 500',
    async (route) => {
      const { status, body } = await api.json<ApiErrorResponse>(
        `/api/v1/templates/welcome/${route}`,
        post({ version: 'two' }),
      );

      expect(status).toBe(400);
      expect(body.error.code).toBe('BAD_REQUEST');
      expect(body.error.details).toMatchObject({ issues: [{ path: 'version' }] });
    },
  );

  it.each(['null', '[]'])('refuses %s, which is not an object', async (json) => {
    const response = await raw('/api/v1/templates/welcome/archive', json, {
      'content-type': 'application/json',
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiErrorResponse;
    expect(body.error.details).toMatchObject({ issues: [{ path: '' }] });
  });
});

describe('every 400', () => {
  it.each([
    ['an invalid query parameter', '/api/v1/templates?page=0', 'page'],
    [
      'a direction with nothing to order',
      '/api/v1/templates?orderByDirection=desc',
      'orderByDirection',
    ],
    ['an invalid version in the path', '/api/v1/templates/welcome/versions/1abc', 'version'],
  ])('lists its issues for %s', async (_case, path, field) => {
    const { status, body } = await api.json<ApiErrorResponse>(path);

    expect(status).toBe(400);
    expect(body.error.details).toMatchObject({ issues: [{ path: field }] });
  });

  it('lists its issues for an order the backend cannot apply', async () => {
    const limited = createHarness({ capabilities: {} });

    const { status, body } = await limited.json<ApiErrorResponse>(
      '/api/v1/templates?orderByField=name',
    );

    expect(status).toBe(400);
    expect(body.error.details).toMatchObject({
      issues: [{ path: 'orderByField' }],
      orderByField: 'name',
      capability: 'orderBy.name',
    });
  });

  it('repeats the message as its one issue when the library refuses the input', async () => {
    const { status, body } = await api.json<ApiErrorResponse>(
      '/api/v1/tags',
      post({ text: '!!!' }),
    );

    expect(status).toBe(400);
    expect(body.error.details).toEqual({ issues: [{ path: '', message: body.error.message }] });
  });
});
