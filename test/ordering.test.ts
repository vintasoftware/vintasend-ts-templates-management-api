/**
 * Ordering on `GET /templates`.
 *
 * The behaviour worth pinning is the asymmetry with filtering. An unsupported *filter* is dropped
 * and the response carries more rows than asked for, which a client can see. An unsupported
 * *order* is a 400, because the alternative is a page of correct rows in an arbitrary sequence
 * under a column header the client has highlighted as sorted — wrong in a way nothing in the
 * response reveals.
 */

import { describe, expect, it } from 'vitest';

import type { ApiErrorResponse, PaginatedResponse } from '../src/contract/types.js';
import { createHarness, type Harness } from './helpers/fixtures.js';

const ALL_ORDERS = {
  'orderBy.key': true,
  'orderBy.name': true,
  'orderBy.version': true,
  'orderBy.status': true,
  'orderBy.createdAt': true,
  'orderBy.updatedAt': true,
};

async function seed(api: Harness, keys: string[]) {
  for (const key of keys) {
    await api.service.createTemplate({
      key,
      name: key.toUpperCase(),
      description: '',
      templateManagedBackend: 'in-memory',
      bodyTemplate: '<p>hi</p>',
      subjectTemplate: 'Hi',
      preheaderTemplate: null,
      tenant: null,
    });
  }
}

async function listKeys(api: Harness, query: string) {
  const { status, body } = await api.json<PaginatedResponse<{ key: string }>>(
    `/api/v1/templates?${query}`,
  );
  return { status, keys: body.data.map((row) => row.key) };
}

describe('ordering a listing', () => {
  it('orders ascending by default when only a field is given', async () => {
    const api = createHarness({ capabilities: ALL_ORDERS });
    await seed(api, ['charlie', 'alpha', 'bravo']);

    const { status, keys } = await listKeys(api, 'orderByField=key');

    expect(status).toBe(200);
    expect(keys).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('honours an explicit descending direction', async () => {
    const api = createHarness({ capabilities: ALL_ORDERS });
    await seed(api, ['charlie', 'alpha', 'bravo']);

    const { keys } = await listKeys(api, 'orderByField=key&orderByDirection=desc');

    expect(keys).toEqual(['charlie', 'bravo', 'alpha']);
  });

  it('sorts the whole result before paging it', async () => {
    // Page 1 descending must be the *last* rows ascending, not the first rows re-sorted among
    // themselves — the difference between ordering in the store and ordering the page.
    const api = createHarness({ capabilities: ALL_ORDERS });
    await seed(api, ['charlie', 'alpha', 'bravo', 'delta']);

    const { keys } = await listKeys(api, 'orderByField=key&orderByDirection=desc&pageSize=2');

    expect(keys).toEqual(['delta', 'charlie']);
  });

  it('leaves the order to the backend when no field is given', async () => {
    const api = createHarness({ capabilities: ALL_ORDERS });
    await seed(api, ['charlie', 'alpha']);

    const { status } = await listKeys(api, 'page=1');

    expect(status).toBe(200);
  });
});

describe('an order the backend cannot apply', () => {
  it('is a 400 rather than an unordered page', async () => {
    const api = createHarness({ capabilities: { ...ALL_ORDERS, 'orderBy.name': false } });
    await seed(api, ['alpha']);

    const { status, body } = await api.json<ApiErrorResponse>(
      '/api/v1/templates?orderByField=name',
    );

    expect(status).toBe(400);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('names the capability key, so the client knows what to ask /capabilities for', async () => {
    const api = createHarness({ capabilities: { ...ALL_ORDERS, 'orderBy.name': false } });

    const { body } = await api.json<ApiErrorResponse>('/api/v1/templates?orderByField=name');

    expect(body.error.message).toContain('name');
    expect(JSON.stringify(body.error)).toContain('orderBy.name');
  });

  it('rejects every field for a backend that declares no ordering at all', async () => {
    // An empty report means every `orderBy.*` key falls to its false default. The store behind
    // this harness could sort perfectly well — what the API goes on is the declaration.
    const api = createHarness({ capabilities: {} });

    for (const field of ['key', 'name', 'version', 'status', 'createdAt', 'updatedAt']) {
      const { status } = await api.json(`/api/v1/templates?orderByField=${field}`);
      expect(status).toBe(400);
    }
  });

  it('still serves an unordered listing from that same backend', async () => {
    const api = createHarness({ capabilities: {} });
    await seed(api, ['alpha']);

    const { status } = await listKeys(api, 'page=1');

    expect(status).toBe(200);
  });
});

describe('malformed ordering', () => {
  it('rejects a field outside the enum', async () => {
    const api = createHarness({ capabilities: ALL_ORDERS });

    const { status } = await api.json('/api/v1/templates?orderByField=bodyTemplate');

    expect(status).toBe(400);
  });

  it('rejects a direction that is not asc or desc', async () => {
    const api = createHarness({ capabilities: ALL_ORDERS });

    const { status } = await api.json('/api/v1/templates?orderByField=key&orderByDirection=up');

    expect(status).toBe(400);
  });

  it('rejects a direction with no field to apply it to', async () => {
    // Ignoring it would look exactly like a backend that cannot sort, hiding the client bug.
    const api = createHarness({ capabilities: ALL_ORDERS });

    const { status, body } = await api.json<ApiErrorResponse>(
      '/api/v1/templates?orderByDirection=desc',
    );

    expect(status).toBe(400);
    expect(body.error.message).toContain('orderByField');
  });
});
