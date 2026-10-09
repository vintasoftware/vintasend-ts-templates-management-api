import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadServerConfig } from '../src/config.js';
import type {
  ApiErrorResponse,
  DataResponse,
  FilterCapabilities,
  HealthResponse,
} from '../src/contract/types.js';
import { apiKeyAuthenticator } from '../src/middleware/authenticate.js';
import {
  asManagedTemplateServicePort,
  loadTemplateService,
} from '../src/services/service-loader.js';
import { API_KEY, createHarness } from './helpers/fixtures.js';

describe('authentication', () => {
  it('lets the health check through unauthenticated', async () => {
    const api = createHarness();

    const response = await api.app.request('http://localhost/health');
    const body = (await response.json()) as HealthResponse;

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'ok', apiVersion: 'v1' });
  });

  it('refuses a request with no Authorization header', async () => {
    const api = createHarness();

    const response = await api.app.request('http://localhost/api/v1/capabilities');
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('refuses a wrong key', async () => {
    const api = createHarness();

    const response = await api.app.request('http://localhost/api/v1/capabilities', {
      headers: { authorization: 'Bearer wrong' },
    });

    expect(response.status).toBe(401);
  });

  it('refuses a key of the right length but the wrong value', async () => {
    const api = createHarness();
    const sameLength = 'x'.repeat(API_KEY.length);

    const response = await api.app.request('http://localhost/api/v1/capabilities', {
      headers: { authorization: `Bearer ${sameLength}` },
    });

    expect(response.status).toBe(401);
  });

  it('refuses an Authorization header that is not a bearer token', async () => {
    const api = createHarness();

    const response = await api.app.request('http://localhost/api/v1/capabilities', {
      headers: { authorization: `Basic ${API_KEY}` },
    });

    expect(response.status).toBe(401);
  });

  it('accepts the configured key', async () => {
    const api = createHarness();

    const { status } = await api.json('/api/v1/capabilities');

    expect(status).toBe(200);
  });
});

describe('GET /api/v1/capabilities', () => {
  it('reports the library default for a backend that declares nothing', async () => {
    const api = createHarness();

    const { status, body } =
      await api.json<DataResponse<FilterCapabilities>>('/api/v1/capabilities');

    expect(status).toBe(200);
    expect(body.data['fields.key']).toBe(true);
    expect(body.data['logical.or']).toBe(true);
  });

  it("merges a backend's report over the default", async () => {
    const api = createHarness({ capabilities: { 'logical.or': false } });

    const { body } = await api.json<DataResponse<FilterCapabilities>>('/api/v1/capabilities');

    expect(body.data['logical.or']).toBe(false);
    expect(body.data['logical.and']).toBe(true);
  });

  it('publishes an orderBy key for every orderable field', async () => {
    // A client builds its sortable columns from these, so a missing key is a column that
    // silently does nothing rather than one that is simply absent.
    const api = createHarness();

    const { body } = await api.json<DataResponse<FilterCapabilities>>('/api/v1/capabilities');

    expect(
      Object.keys(body.data)
        .filter((key) => key.startsWith('orderBy.'))
        .sort(),
    ).toEqual([
      'orderBy.createdAt',
      'orderBy.key',
      'orderBy.name',
      'orderBy.status',
      'orderBy.updatedAt',
      'orderBy.version',
    ]);
  });
});

describe('unmatched routes', () => {
  it('answers in the contract error envelope rather than with a bare 404', async () => {
    const api = createHarness();

    const { status, body } = await api.json<ApiErrorResponse>('/api/v1/nope');

    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('/api/v1/nope');
  });
});

describe('loadServerConfig', () => {
  it('requires an API key', () => {
    expect(() => loadServerConfig({} as NodeJS.ProcessEnv)).toThrow(
      /MANAGED_TEMPLATE_API_KEY is required/,
    );
  });

  it('rejects a port that is not a positive integer', () => {
    expect(() =>
      loadServerConfig({ MANAGED_TEMPLATE_API_KEY: 'k', PORT: 'nope' } as NodeJS.ProcessEnv),
    ).toThrow(/PORT must be a positive integer/);
  });

  it('fills in the documented defaults', () => {
    const config = loadServerConfig({ MANAGED_TEMPLATE_API_KEY: 'k' } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      port: 3334,
      host: '0.0.0.0',
      apiKey: 'k',
      corsOrigins: [],
      serviceModule: './dist/vintasend-templates.config.js',
    });
  });

  it('splits and trims the CORS origin list', () => {
    const config = loadServerConfig({
      MANAGED_TEMPLATE_API_KEY: 'k',
      MANAGED_TEMPLATE_API_CORS_ORIGINS: 'https://a.example, https://b.example ,',
    } as NodeJS.ProcessEnv);

    expect(config.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
  });
});

describe('CORS', () => {
  it('echoes an allowed origin and refuses the rest', async () => {
    const api = createHarness();
    const app = createApp({
      authenticate: apiKeyAuthenticator(API_KEY),
      getService: async () => api.service as never,
      corsOrigins: ['https://allowed.example'],
    });

    const allowed = await app.request('http://localhost/api/v1/capabilities', {
      headers: { authorization: `Bearer ${API_KEY}`, origin: 'https://allowed.example' },
    });
    const refused = await app.request('http://localhost/api/v1/capabilities', {
      headers: { authorization: `Bearer ${API_KEY}`, origin: 'https://other.example' },
    });

    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://allowed.example');
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('the app outside Node', () => {
  /** Every module `createApp` loads, following relative imports from `src/app.ts`. */
  function appModules(): Map<string, string> {
    const modules = new Map<string, string>();
    const pending = [fileURLToPath(new URL('../src/app.ts', import.meta.url))];
    while (pending.length > 0) {
      const file = pending.pop() as string;
      if (modules.has(file)) continue;
      const source = readFileSync(file, 'utf8');
      modules.set(file, source);
      for (const [, specifier] of source.matchAll(/from '(\.[^']+)\.js'/g)) {
        pending.push(resolve(dirname(file), `${specifier}.ts`));
      }
    }
    return modules;
  }

  it('loads no Node built-in, so it can run wherever fetch does', () => {
    // Hosts mount it in a browser over the in-memory store, Storybook included. The server
    // entrypoint and the module-path service loader are Node-only, and `createApp` loads neither.
    const modules = appModules();

    expect(modules.size).toBeGreaterThan(10);
    for (const [file, source] of modules) {
      expect(source, file).not.toMatch(/from 'node:|\bBuffer\./);
    }
  });
});

describe('apiKeyAuthenticator', () => {
  it('names no actor, so a status change keeps the changedBy in the body', async () => {
    const api = createHarness();
    await api.service.createTemplate({
      key: 'welcome',
      name: 'welcome',
      description: '',
      templateManagedBackend: 'in-memory',
      bodyTemplate: 'x',
      subjectTemplate: null,
      preheaderTemplate: null,
      tenant: null,
    });

    await api.request('/api/v1/templates/welcome/activate', {
      method: 'POST',
      body: JSON.stringify({ changedBy: 'ana' }),
    });

    const history = await api.service.getStatusHistory('welcome');
    expect(history[0]?.changedBy).toBe('ana');
  });
});

describe('asManagedTemplateServicePort', () => {
  it('names the methods a service is missing', () => {
    expect(() => asManagedTemplateServicePort({ getTemplate: () => undefined })).toThrow(
      /missing .*createTemplate/,
    );
  });

  it('rejects a non-object outright', () => {
    expect(() => asManagedTemplateServicePort(null)).toThrow(/got null/);
  });
});

describe('loadTemplateService', () => {
  it('says what to set when the module path is empty', async () => {
    await expect(loadTemplateService('')).rejects.toThrow(
      /MANAGED_TEMPLATE_SERVICE_MODULE is not set/,
    );
  });

  it('names the module it could not load', async () => {
    await expect(loadTemplateService('./does-not-exist.js')).rejects.toThrow(
      /Could not load the managed-template service module/,
    );
  });
});
