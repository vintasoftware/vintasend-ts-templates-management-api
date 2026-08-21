import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadServerConfig } from '../src/config.js';
import type {
  ApiErrorResponse,
  DataResponse,
  FilterCapabilities,
  HealthResponse,
} from '../src/contract/types.js';
import { loadTemplateService } from '../src/services/service-loader.js';
import { asManagedTemplateServicePort } from '../src/services/template-service-port.js';
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

  it('offers no ordering to negotiate, because the seam takes none', async () => {
    const api = createHarness();

    const { body } = await api.json<DataResponse<FilterCapabilities>>('/api/v1/capabilities');

    expect(Object.keys(body.data).filter((key) => key.startsWith('orderBy.'))).toEqual([]);
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
      apiKey: API_KEY,
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
