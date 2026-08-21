import { beforeEach, describe, expect, it } from 'vitest';

import type {
  ApiErrorResponse,
  DataResponse,
  ListResponse,
  ManagedTemplateOut,
  PaginatedResponse,
  TemplateCompositionOut,
  TemplatePreviewOut,
  TemplateStatusHistoryOut,
} from '../src/contract/types.js';
import { createHarness, createInput, type Harness, post, put } from './helpers/fixtures.js';

let api: Harness;

beforeEach(() => {
  api = createHarness();
});

describe('GET /api/v1/templates', () => {
  beforeEach(async () => {
    await api.service.createTemplate(createInput('welcome', { name: 'Welcome email' }));
    await api.service.updateTemplate('welcome', {});
    await api.service.createTemplate(createInput('receipt', { name: 'Receipt email' }));
  });

  it('returns one row per key by default', async () => {
    const { status, body } =
      await api.json<PaginatedResponse<ManagedTemplateOut>>('/api/v1/templates');

    expect(status).toBe(200);
    expect(body.data.map((row) => `${row.key}@${row.version}`).sort()).toEqual([
      'receipt@1',
      'welcome@2',
    ]);
    expect(body).toMatchObject({ page: 1, pageSize: 20, hasMore: false });
  });

  it('lists every version when mostRecentActiveVersion is switched off', async () => {
    const { body } = await api.json<PaginatedResponse<ManagedTemplateOut>>(
      '/api/v1/templates?mostRecentActiveVersion=false',
    );

    expect(body.data).toHaveLength(3);
  });

  it('reads the string "false" as false, not as a non-empty string', async () => {
    const { body } = await api.json<PaginatedResponse<ManagedTemplateOut>>(
      '/api/v1/templates?mostRecentActiveVersion=false&isAbstract=false',
    );

    expect(body.data).toHaveLength(3);
  });

  it('pages, 1-indexed, and reports hasMore from a full page', async () => {
    const first = await api.json<PaginatedResponse<ManagedTemplateOut>>(
      '/api/v1/templates?page=1&pageSize=1',
    );
    const second = await api.json<PaginatedResponse<ManagedTemplateOut>>(
      '/api/v1/templates?page=2&pageSize=1',
    );

    expect(first.body.data).toHaveLength(1);
    expect(first.body.hasMore).toBe(true);
    expect(second.body.data[0]?.key).not.toBe(first.body.data[0]?.key);
  });

  it('filters by name with the most precise lookup the backend supports', async () => {
    const { body } = await api.json<PaginatedResponse<ManagedTemplateOut>>(
      '/api/v1/templates?name=RECEIPT',
    );

    // The in-memory backend supports case-insensitive `includes`, so a lowercase-insensitive
    // substring is what the query becomes.
    expect(body.data.map((row) => row.key)).toEqual(['receipt']);
  });

  it('accepts a status repeated to mean several', async () => {
    await api.service.activate('welcome', 2);

    const { body } = await api.json<PaginatedResponse<ManagedTemplateOut>>(
      '/api/v1/templates?status=active&status=draft',
    );

    expect(body.data).toHaveLength(2);
  });

  it('filters by tags, naming them by slug or by the text behind it', async () => {
    await api.service.setTemplateTags('receipt', ['Black Friday']);

    const bySlug = await api.json<PaginatedResponse<ManagedTemplateOut>>(
      '/api/v1/templates?includesAllTags=black-friday',
    );
    const byText = await api.json<PaginatedResponse<ManagedTemplateOut>>(
      '/api/v1/templates?includesAnyOfTags=Black%20Friday',
    );

    expect(bySlug.body.data.map((row) => row.key)).toEqual(['receipt']);
    expect(byText.body.data.map((row) => row.key)).toEqual(['receipt']);
  });

  it('rejects a page below 1', async () => {
    const { status, body } = await api.json<ApiErrorResponse>('/api/v1/templates?page=0');

    expect(status).toBe(400);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.details).toMatchObject({ issues: [{ path: 'page' }] });
  });

  it('rejects a page size above the documented maximum', async () => {
    const { status } = await api.json('/api/v1/templates?pageSize=101');

    expect(status).toBe(400);
  });

  it('rejects a filter present but blank', async () => {
    const { status, body } = await api.json<ApiErrorResponse>('/api/v1/templates?key=%20');

    expect(status).toBe(400);
    expect(body.error.details).toMatchObject({ issues: [{ path: 'key' }] });
  });

  it('drops a filter the backend cannot honour rather than failing the request', async () => {
    const limited = createHarness({ capabilities: { 'fields.name': false } });
    await limited.service.createTemplate(createInput('welcome', { name: 'Welcome email' }));

    const { status, body } = await limited.json<PaginatedResponse<ManagedTemplateOut>>(
      '/api/v1/templates?name=nothing-matches-this',
    );

    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
  });
});

describe('POST /api/v1/templates', () => {
  it('creates a first version in draft, with its allowed transitions', async () => {
    const { status, body } = await api.json<DataResponse<ManagedTemplateOut>>(
      '/api/v1/templates',
      post({
        key: 'welcome',
        name: 'Welcome email',
        templateManagedBackend: 'in-memory',
        bodyTemplate: '<p>Hi</p>',
        tags: ['onboarding'],
      }),
    );

    expect(status).toBe(201);
    expect(body.data).toMatchObject({
      key: 'welcome',
      version: 1,
      status: 'draft',
      description: '',
      subjectTemplate: null,
      preheaderTemplate: null,
      isAbstract: false,
      allowedTransitions: ['active', 'archived'],
    });
    expect(body.data.tags[0]).toMatchObject({ text: 'onboarding', slug: 'onboarding' });
    expect(body.data.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('rejects a body missing a required field, naming it', async () => {
    const { status, body } = await api.json<ApiErrorResponse>(
      '/api/v1/templates',
      post({ key: 'welcome' }),
    );

    expect(status).toBe(400);
    expect(body.error.message).toBe('Invalid request.');
    const issues = (body.error.details as { issues: { path: string }[] }).issues;
    expect(issues.map((issue) => issue.path)).toContain('bodyTemplate');
  });

  it('rejects tag text with nothing that can be turned into a slug', async () => {
    const { status, body } = await api.json<ApiErrorResponse>(
      '/api/v1/templates',
      post({
        key: 'welcome',
        name: 'Welcome',
        templateManagedBackend: 'in-memory',
        bodyTemplate: 'x',
        tags: ['!!!'],
      }),
    );

    expect(status).toBe(400);
    expect(body.error.code).toBe('BAD_REQUEST');
  });
});

describe('versions', () => {
  beforeEach(async () => {
    await api.service.createTemplate(createInput('welcome'));
  });

  it('lists every version newest first', async () => {
    await api.service.updateTemplate('welcome', {});

    const { status, body } = await api.json<ListResponse<ManagedTemplateOut>>(
      '/api/v1/templates/welcome/versions',
    );

    expect(status).toBe(200);
    expect(body.data.map((row) => row.version)).toEqual([2, 1]);
  });

  it('reports an unknown key as 404 rather than an empty list', async () => {
    const { status, body } = await api.json<ApiErrorResponse>('/api/v1/templates/nope/versions');

    expect(status).toBe(404);
    expect(body.error.message).toBe("No template with key 'nope' was found.");
  });

  it('creates the next version, carrying unset fields forward', async () => {
    const { status, body } = await api.json<DataResponse<ManagedTemplateOut>>(
      '/api/v1/templates/welcome/versions',
      post({ name: 'Welcome!' }),
    );

    expect(status).toBe(201);
    expect(body.data).toMatchObject({ version: 2, status: 'draft', name: 'Welcome!' });
    expect(body.data.bodyTemplate).toBe('<p>Hi {name}</p>');
  });

  it('accepts an empty body as a deliberate copy', async () => {
    const { status, body } = await api.json<DataResponse<ManagedTemplateOut>>(
      '/api/v1/templates/welcome/versions',
      post({}),
    );

    expect(status).toBe(201);
    expect(body.data.version).toBe(2);
  });

  it('distinguishes omitted tags from an empty list', async () => {
    await api.service.setTemplateTags('welcome', ['keep-me']);

    const carried = await api.json<DataResponse<ManagedTemplateOut>>(
      '/api/v1/templates/welcome/versions',
      post({}),
    );
    const cleared = await api.json<DataResponse<ManagedTemplateOut>>(
      '/api/v1/templates/welcome/versions',
      post({ tags: [] }),
    );

    expect(carried.body.data.tags.map((tag) => tag.slug)).toEqual(['keep-me']);
    expect(cleared.body.data.tags).toEqual([]);
  });

  it('reads and deletes one version', async () => {
    await api.service.updateTemplate('welcome', {});

    const read = await api.json<DataResponse<ManagedTemplateOut>>(
      '/api/v1/templates/welcome/versions/1',
    );
    expect(read.body.data.version).toBe(1);

    const deleted = await api.request('/api/v1/templates/welcome/versions/2', {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(204);

    const latest = await api.json<DataResponse<ManagedTemplateOut>>('/api/v1/templates/welcome');
    expect(latest.body.data.version).toBe(1);
  });

  it('reports a missing version differently from a missing key', async () => {
    const { status, body } = await api.json<ApiErrorResponse>(
      '/api/v1/templates/welcome/versions/9',
    );

    expect(status).toBe(404);
    expect(body.error.message).toBe("Template 'welcome' has no version 9.");
  });
});

describe('GET /api/v1/templates/{key}', () => {
  beforeEach(async () => {
    await api.service.createTemplate(createInput('welcome', { bodyTemplate: 'v1' }));
    await api.service.updateTemplate('welcome', { bodyTemplate: 'v2' });
  });

  it('returns the latest version when no version is named', async () => {
    const { body } = await api.json<DataResponse<ManagedTemplateOut>>('/api/v1/templates/welcome');

    expect(body.data.version).toBe(2);
  });

  it('returns a pinned version', async () => {
    const { body } = await api.json<DataResponse<ManagedTemplateOut>>(
      '/api/v1/templates/welcome?version=1',
    );

    expect(body.data.bodyTemplate).toBe('v1');
  });

  it('deletes the latest version when none is named', async () => {
    const response = await api.request('/api/v1/templates/welcome', { method: 'DELETE' });

    expect(response.status).toBe(204);
    const { body } = await api.json<DataResponse<ManagedTemplateOut>>('/api/v1/templates/welcome');
    expect(body.data.version).toBe(1);
  });
});

describe('composition', () => {
  beforeEach(async () => {
    await api.service.createTemplate(
      createInput('base', {
        bodyTemplate: '<html>{% managed_children %}</html>',
        subjectTemplate: '[Acme] {% managed_children %}',
      }),
    );
    await api.service.createTemplate(
      createInput('welcome', {
        bodyTemplate: '{% managed_extends "base" %}<p>Hi</p>',
        subjectTemplate: '{% managed_extends "base" %}Welcome',
      }),
    );
  });

  it('reports the assembled sources and what they reference', async () => {
    const { status, body } = await api.json<DataResponse<TemplateCompositionOut>>(
      '/api/v1/templates/welcome/composition',
    );

    expect(status).toBe(200);
    expect(body.data).toMatchObject({
      key: 'welcome',
      version: 1,
      isAbstract: false,
      composedBodyTemplate: '<html><p>Hi</p></html>',
      composedSubjectTemplate: '[Acme] Welcome',
      composedPreheaderTemplate: null,
    });
    expect(body.data.references).toEqual([
      { kind: 'extends', key: 'base', version: null, field: 'bodyTemplate' },
      { kind: 'extends', key: 'base', version: null, field: 'subjectTemplate' },
    ]);
  });

  it('recomputes isAbstract from the source', async () => {
    const { body } = await api.json<DataResponse<TemplateCompositionOut>>(
      '/api/v1/templates/base/composition',
    );

    expect(body.data.isAbstract).toBe(true);
  });

  it('reports a template that cannot be assembled as a 409 naming the chain', async () => {
    await api.service.createTemplate(
      createInput('orphan', { bodyTemplate: '{% managed_extends "gone" %}' }),
    );

    const { status, body } = await api.json<ApiErrorResponse>(
      '/api/v1/templates/orphan/composition',
    );

    expect(status).toBe(409);
    expect(body.error.code).toBe('TEMPLATE_COMPOSITION_ERROR');
    expect(body.error.message).toContain("'gone'");
  });

  it('still reports a genuinely missing template as a 404', async () => {
    const { status, body } = await api.json<ApiErrorResponse>('/api/v1/templates/nope/composition');

    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('the status lifecycle', () => {
  beforeEach(async () => {
    await api.service.createTemplate(createInput('welcome'));
  });

  it('publishes a version and records who did it', async () => {
    const { status, body } = await api.json<DataResponse<ManagedTemplateOut>>(
      '/api/v1/templates/welcome/activate',
      post({ changedBy: 'ana' }),
    );

    expect(status).toBe(200);
    expect(body.data.status).toBe('active');
    expect(body.data.allowedTransitions).toEqual(['inactive', 'archived']);

    const history = await api.json<ListResponse<TemplateStatusHistoryOut>>(
      '/api/v1/templates/welcome/status-history',
    );
    expect(history.body.data[0]).toMatchObject({ status: 'active', changedBy: 'ana', version: 1 });
  });

  it('accepts a lifecycle call with no body at all', async () => {
    const response = await api.request('/api/v1/templates/welcome/activate', { method: 'POST' });

    expect(response.status).toBe(200);
  });

  it('refuses a move the lifecycle does not allow, with its own code', async () => {
    const { status, body } = await api.json<ApiErrorResponse>(
      '/api/v1/templates/welcome/deactivate',
      post({}),
    );

    expect(status).toBe(409);
    expect(body.error.code).toBe('INVALID_STATUS_TRANSITION');
    expect(body.error.message).toContain('Allowed: active, archived');
  });

  it('moves a version to an explicitly named status', async () => {
    const { status, body } = await api.json<DataResponse<ManagedTemplateOut>>(
      '/api/v1/templates/welcome/status',
      post({ status: 'archived', changedBy: 'ana' }),
    );

    expect(status).toBe(200);
    expect(body.data.status).toBe('archived');
    expect(body.data.allowedTransitions).toEqual([]);
  });

  it('reports setting the status a version already holds as success, with no new entry', async () => {
    await api.json('/api/v1/templates/welcome/activate', post({}));
    const again = await api.json<DataResponse<ManagedTemplateOut>>(
      '/api/v1/templates/welcome/activate',
      post({}),
    );

    expect(again.status).toBe(200);
    const history = await api.json<ListResponse<TemplateStatusHistoryOut>>(
      '/api/v1/templates/welcome/status-history',
    );
    expect(history.body.data).toHaveLength(1);
  });

  it('narrows the audit trail to one version when asked', async () => {
    await api.json('/api/v1/templates/welcome/activate', post({}));
    await api.json('/api/v1/templates/welcome/versions', post({}));
    await api.json('/api/v1/templates/welcome/activate', post({ version: 2 }));

    const all = await api.json<ListResponse<TemplateStatusHistoryOut>>(
      '/api/v1/templates/welcome/status-history',
    );
    const one = await api.json<ListResponse<TemplateStatusHistoryOut>>(
      '/api/v1/templates/welcome/status-history?version=2',
    );

    expect(all.body.data).toHaveLength(2);
    expect(one.body.data).toHaveLength(1);
  });

  it('rejects an unknown status value', async () => {
    const { status } = await api.json('/api/v1/templates/welcome/status', post({ status: 'nope' }));

    expect(status).toBe(400);
  });
});

describe('preview', () => {
  beforeEach(async () => {
    await api.service.createTemplate(
      createInput('welcome', {
        bodyTemplate: '<p>Hi {name}</p>',
        subjectTemplate: 'Welcome {name}',
        preheaderTemplate: 'see inside',
      }),
    );
  });

  it('renders a version against a supplied context', async () => {
    const { status, body } = await api.json<DataResponse<TemplatePreviewOut>>(
      '/api/v1/templates/welcome/preview',
      post({ context: { name: 'Ana' } }),
    );

    expect(status).toBe(200);
    expect(body.data).toEqual({
      key: 'welcome',
      version: 1,
      renderedBody: '<p>Hi Ana</p>',
      renderedSubject: 'Welcome Ana',
      renderedPreheader: 'see inside',
    });
  });

  it('previews an unpublished draft by pinning its version', async () => {
    await api.service.updateTemplate('welcome', { bodyTemplate: '<p>draft</p>' });

    const { body } = await api.json<DataResponse<TemplatePreviewOut>>(
      '/api/v1/templates/welcome/preview',
      post({ version: 2 }),
    );

    expect(body.data.version).toBe(2);
    expect(body.data.renderedBody).toBe('<p>draft</p>');
  });

  it('renders a nested context verbatim, as a real send would carry it', async () => {
    const { status } = await api.json(
      '/api/v1/templates/welcome/preview',
      post({ context: { user: { name: 'Ana' }, tags: ['a', 'b'], missing: null } }),
    );

    expect(status).toBe(200);
  });

  it('reports a template that will not render as a 409, carrying the reason', async () => {
    await api.service.createTemplate(createInput('broken', { bodyTemplate: 'boom' }));

    const { status, body } = await api.json<ApiErrorResponse>(
      '/api/v1/templates/broken/preview',
      post({}),
    );

    expect(status).toBe(409);
    expect(body.error.code).toBe('PREVIEW_UNAVAILABLE');
    expect(body.error.message).toContain('the template exploded');
  });

  it('composes before rendering, so a preview shows what actually goes out', async () => {
    await api.service.createTemplate(
      createInput('base', { bodyTemplate: '<html>{% managed_children %}</html>' }),
    );
    await api.service.createTemplate(
      createInput('child', { bodyTemplate: '{% managed_extends "base" %}<p>Hi</p>' }),
    );

    const { body } = await api.json<DataResponse<TemplatePreviewOut>>(
      '/api/v1/templates/child/preview',
      post({}),
    );

    expect(body.data.renderedBody).toBe('<html><p>Hi</p></html>');
  });
});

describe('PUT /api/v1/templates/{key}/tags', () => {
  beforeEach(async () => {
    await api.service.createTemplate(createInput('welcome', { tags: ['old'] }));
  });

  it('retags a version in place, without spawning one', async () => {
    const { status, body } = await api.json<DataResponse<ManagedTemplateOut>>(
      '/api/v1/templates/welcome/tags',
      put({ tags: ['Black Friday', 'sale'] }),
    );

    expect(status).toBe(200);
    expect(body.data.version).toBe(1);
    expect(body.data.tags.map((tag) => tag.slug)).toEqual(['black-friday', 'sale']);
  });

  it('clears a version tags with an empty list', async () => {
    const { body } = await api.json<DataResponse<ManagedTemplateOut>>(
      '/api/v1/templates/welcome/tags',
      put({ tags: [] }),
    );

    expect(body.data.tags).toEqual([]);
  });
});
