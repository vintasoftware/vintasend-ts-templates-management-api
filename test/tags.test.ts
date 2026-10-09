import { beforeEach, describe, expect, it } from 'vitest';

import type {
  ApiErrorResponse,
  DataResponse,
  ManagedTemplateTagOut,
  PaginatedResponse,
} from '../src/contract/types.js';
import { createHarness, createInput, type Harness, patch, post } from './helpers/fixtures.js';

let api: Harness;

beforeEach(() => {
  api = createHarness();
});

describe('GET /api/v1/tags', () => {
  beforeEach(async () => {
    await api.service.createTag('Black Friday', 'acme');
    await api.service.createTag('Cyber Monday', 'other');
    await api.service.archiveTag('cyber-monday');
  });

  it('lists every tag by default', async () => {
    const { status, body } =
      await api.json<PaginatedResponse<ManagedTemplateTagOut>>('/api/v1/tags');

    expect(status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body).toMatchObject({ page: 1, pageSize: 20, hasMore: false });
  });

  it('offers only the active tags to a picker', async () => {
    const { body } = await api.json<PaginatedResponse<ManagedTemplateTagOut>>(
      '/api/v1/tags?status=active',
    );

    expect(body.data.map((tag) => tag.slug)).toEqual(['black-friday']);
  });

  it('searches text and slug, case-insensitively', async () => {
    const { body } = await api.json<PaginatedResponse<ManagedTemplateTagOut>>(
      '/api/v1/tags?search=MONDAY',
    );

    expect(body.data.map((tag) => tag.slug)).toEqual(['cyber-monday']);
  });

  it('narrows by tenant', async () => {
    const { body } = await api.json<PaginatedResponse<ManagedTemplateTagOut>>(
      '/api/v1/tags?tenant=acme',
    );

    expect(body.data.map((tag) => tag.slug)).toEqual(['black-friday']);
  });

  it('pages the complete list, 1-indexed', async () => {
    const first = await api.json<PaginatedResponse<ManagedTemplateTagOut>>(
      '/api/v1/tags?page=1&pageSize=1',
    );
    const second = await api.json<PaginatedResponse<ManagedTemplateTagOut>>(
      '/api/v1/tags?page=2&pageSize=1',
    );

    expect(first.body.data).toHaveLength(1);
    expect(first.body.hasMore).toBe(true);
    expect(second.body.data[0]?.slug).not.toBe(first.body.data[0]?.slug);
  });

  it('offers no next page when the list exactly fills the last one', async () => {
    const first = await api.json<PaginatedResponse<ManagedTemplateTagOut>>(
      '/api/v1/tags?page=1&pageSize=1',
    );
    const last = await api.json<PaginatedResponse<ManagedTemplateTagOut>>(
      '/api/v1/tags?page=2&pageSize=1',
    );
    const whole =
      await api.json<PaginatedResponse<ManagedTemplateTagOut>>('/api/v1/tags?pageSize=2');

    expect(first.body.hasMore).toBe(true);
    expect([last.body.data.length, last.body.hasMore]).toEqual([1, false]);
    expect([whole.body.data.length, whole.body.hasMore]).toEqual([2, false]);
  });

  it('rejects an unknown status value', async () => {
    const { status } = await api.json('/api/v1/tags?status=nope');

    expect(status).toBe(400);
  });
});

describe('POST /api/v1/tags', () => {
  it('defines a tag ahead of any template using it', async () => {
    const { status, body } = await api.json<DataResponse<ManagedTemplateTagOut>>(
      '/api/v1/tags',
      post({ text: 'Black Friday', tenant: 'acme' }),
    );

    expect(status).toBe(201);
    expect(body.data).toMatchObject({
      text: 'Black Friday',
      slug: 'black-friday',
      status: 'active',
      tenant: 'acme',
    });
  });

  it('reports a collision as a conflict, not a validation error', async () => {
    await api.service.createTag('Sale');

    const { status, body } = await api.json<ApiErrorResponse>(
      '/api/v1/tags',
      post({ text: 'sale' }),
    );

    expect(status).toBe(409);
    expect(body.error.code).toBe('CONFLICT');
  });

  it('rejects text with nothing that can be turned into a slug', async () => {
    const { status, body } = await api.json<ApiErrorResponse>(
      '/api/v1/tags',
      post({ text: '!!!' }),
    );

    expect(status).toBe(400);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects empty text before it reaches the service', async () => {
    const { status } = await api.json('/api/v1/tags', post({ text: '' }));

    expect(status).toBe(400);
  });
});

describe('one tag', () => {
  beforeEach(async () => {
    await api.service.createTag('Black Friday');
  });

  it('reads a tag by its slug or by the text behind it', async () => {
    const bySlug = await api.json<DataResponse<ManagedTemplateTagOut>>('/api/v1/tags/black-friday');
    const byText = await api.json<DataResponse<ManagedTemplateTagOut>>(
      '/api/v1/tags/Black%20Friday',
    );

    expect(bySlug.status).toBe(200);
    expect(byText.body.data.slug).toBe('black-friday');
  });

  it('reports an unknown slug as 404', async () => {
    const { status, body } = await api.json<ApiErrorResponse>('/api/v1/tags/nope');

    expect(status).toBe(404);
    expect(body.error.message).toBe("No tag with slug 'nope' was found.");
  });

  it('renames a tag and regenerates its slug', async () => {
    const { status, body } = await api.json<DataResponse<ManagedTemplateTagOut>>(
      '/api/v1/tags/black-friday',
      patch({ text: 'Cyber Monday' }),
    );

    expect(status).toBe(200);
    expect(body.data).toMatchObject({ text: 'Cyber Monday', slug: 'cyber-monday' });
  });

  it('suffixes a rename onto an existing slug rather than refusing it', async () => {
    await api.service.createTag('Clearance');

    const { body } = await api.json<DataResponse<ManagedTemplateTagOut>>(
      '/api/v1/tags/clearance',
      patch({ text: 'Black Friday' }),
    );

    expect(body.data.slug).toBe('black-friday-2');
  });

  it('archives and restores', async () => {
    const archived = await api.json<DataResponse<ManagedTemplateTagOut>>(
      '/api/v1/tags/black-friday/archive',
      { method: 'POST' },
    );
    expect(archived.body.data.status).toBe('archived');

    const restored = await api.json<DataResponse<ManagedTemplateTagOut>>(
      '/api/v1/tags/black-friday/restore',
      { method: 'POST' },
    );
    expect(restored.body.data.status).toBe('active');
  });

  it('deletes a tag and takes the label off the templates carrying it', async () => {
    await api.service.createTemplate(createInput('welcome', { tags: ['Black Friday'] }));

    const response = await api.request('/api/v1/tags/black-friday', { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(await api.service.getTemplateTags('welcome')).toEqual([]);
  });

  it('keeps every link when a tag is archived', async () => {
    await api.service.createTemplate(createInput('welcome', { tags: ['Black Friday'] }));

    await api.request('/api/v1/tags/black-friday/archive', { method: 'POST' });

    expect(await api.service.getTemplateTags('welcome')).toHaveLength(1);
  });
});
