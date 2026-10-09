/**
 * What a host embedding the API relies on: the options `createApp` takes, the `./testing` entry it
 * tests its mount and runs its UI against, the bearer-token helper its own authenticator reads with,
 * and dependencies that do not drag the standalone server into its install.
 */

import { readFileSync } from 'node:fs';
import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';

import type {
  ApiErrorResponse,
  DataResponse,
  ListResponse,
  ManagedTemplateOut,
  TemplatePreviewOut,
  TemplateStatusHistoryOut,
} from '../src/contract/types.js';
import * as entry from '../src/exports.js';
import { bearerToken } from '../src/middleware/authenticate.js';
import * as testing from '../src/testing.js';
import {
  API_KEY,
  createHarness,
  createInput,
  post,
  TestEmailRenderer,
} from './helpers/fixtures.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('createApp templateManagedBackend', () => {
  it("stores the host's backend name whatever the create request carries", async () => {
    const api = createHarness({ templateManagedBackend: 'medplum' });

    const { status, body } = await api.json<DataResponse<ManagedTemplateOut>>(
      '/api/v1/templates',
      post(createInput('welcome', { templateManagedBackend: 'somewhere-else' })),
    );

    expect(status).toBe(201);
    expect(body.data.templateManagedBackend).toBe('medplum');
    expect((await api.service.getTemplate('welcome')).templateManagedBackend).toBe('medplum');
  });

  it("stores the request's backend name when the host sets none", async () => {
    const api = createHarness();

    const { body } = await api.json<DataResponse<ManagedTemplateOut>>(
      '/api/v1/templates',
      post(createInput('welcome', { templateManagedBackend: 'somewhere-else' })),
    );

    expect(body.data.templateManagedBackend).toBe('somewhere-else');
  });

  it('still requires the field, so a client written against the contract keeps working', async () => {
    const api = createHarness({ templateManagedBackend: 'medplum' });
    const { templateManagedBackend: _, ...withoutBackend } = createInput('welcome');

    const { status } = await api.json('/api/v1/templates', post(withoutBackend));

    expect(status).toBe(400);
  });
});

describe('the ./testing entry', () => {
  it('is published as a subpath export', () => {
    expect(pkg.exports['./testing']).toEqual({
      types: './dist/testing.d.ts',
      import: './dist/testing.js',
    });
  });

  it('exports the harness, the renderer and the request helpers', () => {
    expect(Object.keys(testing).sort()).toEqual([
      'API_KEY',
      'TestEmailRenderer',
      'createHarness',
      'createInput',
      'patch',
      'post',
      'put',
    ]);
  });

  it('authenticates with API_KEY, and sends a body as JSON', async () => {
    const seen: { authorization?: string; contentType?: string }[] = [];
    const api = createHarness({
      authenticate: (c: Context) => {
        seen.push({
          authorization: c.req.header('authorization'),
          contentType: c.req.header('content-type'),
        });
        return {};
      },
    });

    await api.request('/api/v1/templates');
    await api.request('/api/v1/templates', post(createInput('welcome')));

    expect(seen).toEqual([
      { authorization: `Bearer ${API_KEY}`, contentType: undefined },
      { authorization: `Bearer ${API_KEY}`, contentType: 'application/json' },
    ]);
  });

  it('refuses a request without the key by default', async () => {
    const api = createHarness();

    const response = await api.app.request('http://localhost/api/v1/templates');

    expect(response.status).toBe(401);
  });

  it('fills {{ name }} from the preview context', async () => {
    const api = createHarness();
    await api.service.createTemplate(
      createInput('welcome', {
        bodyTemplate: '<p>Hi {{ name }}, {{name}}</p>',
        subjectTemplate: 'Welcome {{ name }}',
        preheaderTemplate: '{{ missing }}',
      }),
    );

    const { body } = await api.json<DataResponse<TemplatePreviewOut>>(
      '/api/v1/templates/welcome/preview',
      post({ context: { name: 'Ana' } }),
    );

    expect(body.data).toMatchObject({
      renderedBody: '<p>Hi Ana, Ana</p>',
      renderedSubject: 'Welcome Ana',
      renderedPreheader: '{{ missing }}',
    });
  });

  it('fails to render a template containing boom, so the failure path can be shown', async () => {
    const api = createHarness();
    await api.service.createTemplate(createInput('broken', { bodyTemplate: 'boom' }));

    const { status, body } = await api.json<ApiErrorResponse>(
      '/api/v1/templates/broken/preview',
      post({}),
    );

    expect(status).toBe(409);
    expect(body.error.code).toBe('PREVIEW_UNAVAILABLE');
  });

  it('takes a renderer in place of the test one', async () => {
    class FixedRenderer extends TestEmailRenderer {
      override async renderFromTemplateContent() {
        return { subject: 'fixed', body: 'fixed body', preheader: null };
      }
    }
    const api = createHarness({ renderer: new FixedRenderer() });
    await api.service.createTemplate(createInput('welcome'));

    const { body } = await api.json<DataResponse<TemplatePreviewOut>>(
      '/api/v1/templates/welcome/preview',
      post({}),
    );

    expect(body.data.renderedBody).toBe('fixed body');
  });

  it('runs the store on the given clock, so seeded history has fixed dates', async () => {
    const api = createHarness({ now: () => new Date('2026-01-02T03:04:05.000Z') });
    await api.service.createTemplate(createInput('welcome'));
    await api.request('/api/v1/templates/welcome/activate', post({}));

    const { body } = await api.json<ListResponse<TemplateStatusHistoryOut>>(
      '/api/v1/templates/welcome/status-history',
    );

    expect(body.data.map((row) => row.createdAt)).toEqual(['2026-01-02T03:04:05.000Z']);
  });

  it("overrides the store's filter capabilities", async () => {
    const api = createHarness({ capabilities: { 'fields.name': false } });

    expect(await api.backend.getFilterCapabilities()).toEqual({ 'fields.name': false });
  });

  it('passes templateManagedBackend and onUnhandledError on to createApp', async () => {
    const failures: unknown[] = [];
    const api = createHarness({
      templateManagedBackend: 'medplum',
      onUnhandledError: (error) => {
        failures.push(error);
      },
    });
    api.service.getTemplate = async () => {
      throw new Error('store down');
    };

    const response = await api.request('/api/v1/templates/welcome');

    expect(response.status).toBe(500);
    expect(failures).toHaveLength(1);
  });
});

describe('bearerToken', () => {
  it('reads the token from a Bearer header', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
  });

  it('accepts the scheme in any case, as RFC 9110 has it', () => {
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('BEARER abc')).toBe('abc');
  });

  it('is null with no header', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('')).toBeNull();
  });

  it('is null for another scheme, or a scheme with no token', () => {
    expect(bearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken('Bearer    ')).toBeNull();
  });

  it('is exported from the entry', () => {
    expect(typeof entry.bearerToken).toBe('function');
    expect(entry.bearerToken).toBe(bearerToken);
  });
});

describe('the package entry', () => {
  it('exports what a host mounts the API with, and nothing it has no use for', () => {
    const values = Object.keys(entry).sort();

    expect(values).toEqual([
      'API_BASE_PATH',
      'API_VERSION',
      'ApiError',
      'REQUEST_ID_HEADER',
      'apiKeyAuthenticator',
      'authenticated',
      'bearerToken',
      'createApp',
      'invalidRequest',
      'logUnhandledError',
    ]);
  });

  it('serves the standalone server pieces from ./server', async () => {
    const server = await import('../src/server.js');

    expect(pkg.exports['./server']).toEqual({
      types: './dist/server.d.ts',
      import: './dist/server.js',
    });
    expect(Object.keys(server).sort()).toEqual([
      'createServiceProvider',
      'loadServerConfig',
      'loadTemplateService',
    ]);
  });

  it('declares no side effects, so a bundler can drop what a host does not import', () => {
    expect(pkg.sideEffects).toBe(false);
  });
});

describe('dependencies', () => {
  it('does not install the Node HTTP server in a host that only mounts createApp', () => {
    expect(pkg.dependencies['@hono/node-server']).toBeUndefined();
    expect(pkg.peerDependencies['@hono/node-server']).toBeDefined();
    expect(pkg.peerDependenciesMeta['@hono/node-server']).toEqual({ optional: true });
  });

  it('uses Zod 4, so a host on Zod 4 installs one copy', () => {
    expect(pkg.dependencies.zod).toMatch(/^\^4\./);
    expect(pkg.dependencies['@hono/zod-validator']).toMatch(/^\^0\.(7|8|9)\./);
  });
});
