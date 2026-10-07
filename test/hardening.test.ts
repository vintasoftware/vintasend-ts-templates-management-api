/**
 * Attribution the host controls, errors that never reach the log whole, and deletes that cannot
 * remove a published version.
 */

import type { Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ApiErrorResponse,
  DataResponse,
  ListResponse,
  ManagedTemplateOut,
  TemplateStatusHistoryOut,
} from '../src/contract/types.js';
import { createHarness, createInput, type Harness, post } from './helpers/fixtures.js';

describe('resolveActor', () => {
  let api: Harness;

  beforeEach(async () => {
    api = createHarness({ resolveActor: (c) => c.req.header('x-authenticated-user') ?? null });
    await api.service.createTemplate(createInput('welcome'));
  });

  async function history(): Promise<TemplateStatusHistoryOut[]> {
    const { body } = await api.json<ListResponse<TemplateStatusHistoryOut>>(
      '/api/v1/templates/welcome/status-history',
    );
    return body.data;
  }

  it('replaces whatever changedBy the body claims', async () => {
    const response = await api.request('/api/v1/templates/welcome/activate', {
      ...post({ changedBy: 'someone-else' }),
      headers: { 'x-authenticated-user': 'ana' },
    });

    expect(response.status).toBe(200);
    expect((await history())[0]).toMatchObject({ status: 'active', changedBy: 'ana' });
  });

  it('applies to every status route', async () => {
    const as = (user: string) => ({ headers: { 'x-authenticated-user': user } });
    await api.request('/api/v1/templates/welcome/status', {
      ...post({ status: 'active', changedBy: 'forged' }),
      ...as('ana'),
    });
    await api.request('/api/v1/templates/welcome/deactivate', {
      ...post({ changedBy: 'forged' }),
      ...as('bia'),
    });
    await api.request('/api/v1/templates/welcome/archive', {
      ...post({ changedBy: 'forged' }),
      ...as('caio'),
    });

    expect((await history()).map((entry) => entry.changedBy)).toEqual(['caio', 'bia', 'ana']);
  });

  it('records null when the hook resolves nobody, even if the body names someone', async () => {
    await api.request('/api/v1/templates/welcome/activate', post({ changedBy: 'forged' }));

    expect((await history())[0]?.changedBy).toBeNull();
  });

  it('may be asynchronous', async () => {
    const asyncApi = createHarness({ resolveActor: async () => 'resolved-later' });
    await asyncApi.service.createTemplate(createInput('welcome'));

    await asyncApi.request('/api/v1/templates/welcome/activate', post({ changedBy: 'forged' }));

    const { body } = await asyncApi.json<ListResponse<TemplateStatusHistoryOut>>(
      '/api/v1/templates/welcome/status-history',
    );
    expect(body.data[0]?.changedBy).toBe('resolved-later');
  });

  it('keeps taking changedBy from the body when no hook is configured', async () => {
    const plain = createHarness();
    await plain.service.createTemplate(createInput('welcome'));

    await plain.request('/api/v1/templates/welcome/activate', post({ changedBy: 'ana' }));

    const { body } = await plain.json<ListResponse<TemplateStatusHistoryOut>>(
      '/api/v1/templates/welcome/status-history',
    );
    expect(body.data[0]?.changedBy).toBe('ana');
  });
});

describe('unhandled errors', () => {
  const sensitive = 'Patient/123 Jane Example 1970-01-01';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function failingApi(options: Parameters<typeof createHarness>[0] = {}): Harness {
    const api = createHarness(options);
    vi.spyOn(api.service, 'getTemplate').mockRejectedValue(new TypeError(sensitive));
    return api;
  }

  it('logs the class name, a request id and the route — never the error itself', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = failingApi();

    const response = await api.request('/api/v1/templates/welcome', {
      headers: { 'x-request-id': 'req-42' },
    });

    expect(response.status).toBe(500);
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = consoleError.mock.calls[0] ?? [];
    expect(logged).toHaveLength(1);
    expect(logged[0]).toBe(
      '[vintasend-templates-api] unhandled TypeError (request req-42) on GET /api/v1/templates/:key',
    );
    expect(JSON.stringify(logged)).not.toContain('Jane');
  });

  it('keeps the generic 500 body and returns the request id it logged', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = failingApi();

    const response = await api.request('/api/v1/templates/welcome');
    const body = (await response.json()) as ApiErrorResponse;

    expect(body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred while handling the request.',
      },
    });
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not log a client-supplied request id that could forge a log line', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = failingApi();

    await api.request('/api/v1/templates/welcome', {
      headers: { 'x-request-id': 'x) on GET /forged injected' },
    });

    expect(String(consoleError.mock.calls[0]?.[0])).not.toContain('injected');
  });

  it('hands the error to an injected handler instead', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: { error: Error; route: string }[] = [];
    const api = failingApi({
      onUnhandledError: (error: Error, c: Context) => {
        seen.push({ error, route: c.req.routePath });
      },
    });

    const response = await api.request('/api/v1/templates/welcome');

    expect(response.status).toBe(500);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.error).toBeInstanceOf(TypeError);
    expect(seen[0]?.route).toBe('/api/v1/templates/:key');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('falls back to the redacted line when the injected handler throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = failingApi({
      onUnhandledError: () => {
        throw new Error(`handler broke while holding ${sensitive}`);
      },
    });

    const response = await api.request('/api/v1/templates/welcome', {
      headers: { 'x-request-id': 'req-7' },
    });

    expect(response.status).toBe(500);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]).toEqual([
      '[vintasend-templates-api] unhandled TypeError (request req-7) on GET /api/v1/templates/:key',
    ]);
  });

  it('still answers 500 when the default log line itself fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('logging is broken');
    });
    const api = failingApi();

    const response = await api.request('/api/v1/templates/welcome');

    expect(response.status).toBe(500);
  });
});

describe('deleting', () => {
  let api: Harness;

  beforeEach(async () => {
    api = createHarness();
    await api.service.createTemplate(createInput('welcome'));
    await api.service.activate('welcome');
  });

  it('refuses to delete a published version with a 409', async () => {
    const { status, body } = await api.json<ApiErrorResponse>(
      '/api/v1/templates/welcome/versions/1',
      { method: 'DELETE' },
    );

    expect(status).toBe(409);
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toMatch(/archive/);
  });

  it('refuses a key-level delete that would remove the published latest version', async () => {
    const { status } = await api.json<ApiErrorResponse>('/api/v1/templates/welcome', {
      method: 'DELETE',
    });

    expect(status).toBe(409);
    const { body } = await api.json<DataResponse<ManagedTemplateOut>>('/api/v1/templates/welcome');
    expect(body.data).toMatchObject({ version: 1, status: 'active' });
  });

  it('still deletes a draft that was never published', async () => {
    await api.service.updateTemplate('welcome', {});

    const response = await api.request('/api/v1/templates/welcome/versions/2', {
      method: 'DELETE',
    });

    expect(response.status).toBe(204);
  });
});
