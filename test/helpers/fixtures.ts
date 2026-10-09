/**
 * A whole API over a real service, with the store in memory.
 *
 * The service, the composer and the filter validation are the library's own — only the store is a
 * fixture. That is deliberate: an API test that stubbed the service would prove the routes call
 * *something*, not that they call it correctly, and the parts most worth pinning here (which
 * filter a query becomes, which error a refused transition produces) live on the far side of that
 * boundary.
 *
 * Every response that goes through `request` or `json` is also checked against `openapi.yaml`: a
 * client error the route does not declare fails the test that provoked it. The declarations are
 * written by hand on the Python side, so this is what notices a route answering a status a
 * generated client was never told about.
 */

import type { Hono } from 'hono';
import type {
  AnyNotification,
  BaseNotificationTemplateRenderer,
  ContextGenerator,
  EmailTemplate,
  JsonObject,
} from 'vintasend';
import {
  InMemoryTemplateManagerBackend,
  type ManagedEmailTemplateContent,
  type ManagedTemplateCreateInput,
  ManagedTemplateEmailRenderer,
  ManagedTemplateService,
} from 'vintasend-managed-templates';

import { type AppDependencies, createApp } from '../../src/app.js';
import { apiKeyAuthenticator } from '../../src/middleware/authenticate.js';
import type { ManagedTemplateServicePort } from '../../src/services/template-service-port.js';
import { undeclaredStatus } from './contract.js';

export const API_KEY = 'test-api-key';

export type TestConfig = {
  ContextMap: Record<string, ContextGenerator>;
  NotificationIdType: string;
  UserIdType: string;
};

/**
 * Interpolates `{name}` placeholders, and refuses a template naming `boom`.
 *
 * The failure path matters as much as the happy one: a preview of a template that will not render
 * is the thing the endpoint exists to surface, and it has to come back as a 409 rather than a 500.
 */
export class EchoEmailRenderer
  implements BaseNotificationTemplateRenderer<TestConfig, EmailTemplate>
{
  async renderFromTemplateContent(
    _notification: AnyNotification<TestConfig>,
    content: ManagedEmailTemplateContent,
    context: JsonObject,
  ): Promise<EmailTemplate & { preheader: string | null }> {
    if (content.body.includes('boom')) {
      throw new Error('the template exploded');
    }
    const fill = (source: string): string =>
      source.replace(/\{(\w+)\}/g, (whole, key: string) => {
        const value = context[key];
        return value === undefined ? whole : String(value);
      });
    return {
      subject: fill(content.subject ?? ''),
      body: fill(content.body),
      preheader: content.preheader === null ? null : fill(content.preheader),
    };
  }

  async render(): Promise<EmailTemplate> {
    throw new Error('unused');
  }
}

export type Harness = {
  app: Hono;
  backend: InMemoryTemplateManagerBackend;
  service: ManagedTemplateService<TestConfig, EmailTemplate>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  json: <T>(path: string, init?: RequestInit) => Promise<{ status: number; body: T }>;
};

export function createHarness(
  options: {
    capabilities?: Record<string, boolean>;
    /** Defaults to the shared API key, which every helper request carries. */
    authenticate?: AppDependencies['authenticate'];
    onUnhandledError?: AppDependencies['onUnhandledError'];
  } = {},
): Harness {
  const backend = new InMemoryTemplateManagerBackend();
  if (options.capabilities) {
    Object.assign(backend, { getFilterCapabilities: () => options.capabilities });
  }

  const service = new ManagedTemplateService<TestConfig, EmailTemplate>(
    backend,
    new ManagedTemplateEmailRenderer<TestConfig>(backend, new EchoEmailRenderer()),
  );

  const app = createApp({
    authenticate: options.authenticate ?? apiKeyAuthenticator(API_KEY),
    getService: async () => service as unknown as ManagedTemplateServicePort,
    ...(options.onUnhandledError ? { onUnhandledError: options.onUnhandledError } : {}),
  });

  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const response = await app.request(`http://localhost${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    });
    const problem = undeclaredStatus(init.method ?? 'GET', path, response.status);
    if (problem !== undefined) {
      throw new Error(`openapi.yaml: ${problem}`);
    }
    return response;
  };

  return {
    app,
    backend,
    service,
    request,
    json: async <T>(path: string, init?: RequestInit) => {
      const response = await request(path, init);
      const body = response.status === 204 ? (undefined as T) : ((await response.json()) as T);
      return { status: response.status, body };
    },
  };
}

export function post(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

export function put(body: unknown): RequestInit {
  return { method: 'PUT', body: JSON.stringify(body) };
}

export function patch(body: unknown): RequestInit {
  return { method: 'PATCH', body: JSON.stringify(body) };
}

export function createInput(
  key: string,
  overrides: Partial<ManagedTemplateCreateInput> = {},
): ManagedTemplateCreateInput {
  return {
    key,
    name: key,
    description: '',
    templateManagedBackend: 'in-memory',
    bodyTemplate: '<p>Hi {name}</p>',
    subjectTemplate: 'Welcome',
    preheaderTemplate: null,
    tenant: null,
    ...overrides,
  };
}
