/**
 * The whole API in memory: for a host testing its own mount, and for a UI's stories and tests.
 *
 * `createHarness` builds the library's own `ManagedTemplateService` over its
 * `InMemoryTemplateManagerBackend`, and `createApp` over that. Only the store is in memory: which
 * filter a query becomes, and which error a refused transition produces, are the library's real
 * answers.
 *
 * Imports no Node built-in, so stories can run it in the browser.
 */

import type { Hono } from 'hono';
import type {
  AnyNotification,
  BaseLogger,
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
  type ManagedTemplateFilterCapabilities,
  ManagedTemplateService,
} from 'vintasend-managed-templates';

import { type AppDependencies, createApp } from './app.js';
import { apiKeyAuthenticator } from './middleware/authenticate.js';
import type { ManagedTemplateServicePort } from './services/template-service-port.js';

/** The key `createHarness` authenticates with by default, and that every harness request carries. */
export const API_KEY = 'test-api-key';

export type TestConfig = {
  ContextMap: Record<string, ContextGenerator>;
  NotificationIdType: string;
  UserIdType: string;
};

/**
 * Fills plain `{{ name }}` variables from the context, and refuses a template containing `boom`.
 *
 * No template engine: a variable it cannot fill is left as written, and nothing else Liquid has
 * (filters, tags, dotted paths) is understood. `boom` is there for the failure path, a preview of
 * a template that will not render, which the API answers with a 409 `PREVIEW_UNAVAILABLE`.
 */
export class TestEmailRenderer
  implements BaseNotificationTemplateRenderer<TestConfig, EmailTemplate>
{
  logger: BaseLogger | null = null;

  injectLogger(logger: BaseLogger): void {
    this.logger = logger;
  }

  async renderFromTemplateContent(
    _notification: AnyNotification<TestConfig>,
    content: ManagedEmailTemplateContent,
    context: JsonObject,
  ): Promise<EmailTemplate & { preheader: string | null }> {
    if (content.body.includes('boom')) {
      throw new Error('the template exploded');
    }
    const fill = (source: string): string =>
      source.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => {
        const value = context[name];
        return value === undefined ? whole : String(value);
      });
    return {
      subject: fill(content.subject ?? ''),
      body: fill(content.body),
      preheader: content.preheader === null ? null : fill(content.preheader),
    };
  }

  async render(): Promise<EmailTemplate> {
    throw new Error('A managed template renders from its stored content, not from a file.');
  }
}

export type HarnessOptions = {
  /** Defaults to `apiKeyAuthenticator(API_KEY)`, the key every harness request carries. */
  authenticate?: AppDependencies['authenticate'];
  onUnhandledError?: AppDependencies['onUnhandledError'];
  templateManagedBackend?: AppDependencies['templateManagedBackend'];
  /** Replaces what the store reports from `getFilterCapabilities`. */
  capabilities?: ManagedTemplateFilterCapabilities;
  /** The store's clock, for seeding status history with fixed dates. */
  now?: () => Date;
  /** Defaults to a `TestEmailRenderer`. */
  renderer?: BaseNotificationTemplateRenderer<TestConfig, EmailTemplate>;
  /** Sees every response `request` and `json` receive, before they return it. */
  onResponse?: (request: { method: string; path: string }, response: Response) => void;
};

export type Harness = {
  app: Hono;
  backend: InMemoryTemplateManagerBackend;
  service: ManagedTemplateService<TestConfig, EmailTemplate>;
  /** Sends `path` to the app with the bearer key, and declares a body as JSON when there is one. */
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** `request`, with the response body parsed (`undefined` for a 204). */
  json: <T>(path: string, init?: RequestInit) => Promise<{ status: number; body: T }>;
};

export function createHarness(options: HarnessOptions = {}): Harness {
  const backend = new InMemoryTemplateManagerBackend(options.now ? { now: options.now } : {});
  if (options.capabilities) {
    const capabilities = options.capabilities;
    backend.getFilterCapabilities = () => capabilities;
  }

  const service = new ManagedTemplateService<TestConfig, EmailTemplate>(
    backend,
    new ManagedTemplateEmailRenderer<TestConfig>(
      backend,
      options.renderer ?? new TestEmailRenderer(),
    ),
  );

  const app = createApp({
    authenticate: options.authenticate ?? apiKeyAuthenticator(API_KEY),
    getService: async () => service as unknown as ManagedTemplateServicePort,
    ...(options.onUnhandledError ? { onUnhandledError: options.onUnhandledError } : {}),
    ...(options.templateManagedBackend
      ? { templateManagedBackend: options.templateManagedBackend }
      : {}),
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
    options.onResponse?.({ method: init.method ?? 'GET', path }, response);
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

/** A valid first version for `key`, stored under the `in-memory` backend name. */
export function createInput(
  key: string,
  overrides: Partial<ManagedTemplateCreateInput> = {},
): ManagedTemplateCreateInput {
  return {
    key,
    name: key,
    description: '',
    templateManagedBackend: 'in-memory',
    bodyTemplate: '<p>Hi {{ name }}</p>',
    subjectTemplate: 'Welcome',
    preheaderTemplate: null,
    tenant: null,
    ...overrides,
  };
}
