/**
 * Builds the HTTP application.
 *
 * The one thing the API needs from the outside world — a configured `ManagedTemplateService` — is
 * injected, so the app can be exercised in tests without a database, a template engine, or a FHIR
 * server.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { API_VERSION, type HealthResponse } from './contract/types.js';
import { apiKeyAuth } from './middleware/api-key-auth.js';
import { handleError, handleNotFound } from './middleware/error-handler.js';
import { createTagRoutes } from './routes/tags.js';
import { createTemplateRoutes } from './routes/templates.js';
import { ServiceCaller } from './services/service-caller.js';
import type { ManagedTemplateServicePort } from './services/template-service-port.js';

export type AppDependencies = {
  apiKey: string;
  getService: () => Promise<ManagedTemplateServicePort>;
  corsOrigins?: string[];
};

export const API_BASE_PATH = `/api/${API_VERSION}`;

export function createApp(deps: AppDependencies): Hono {
  const app = new Hono();

  app.onError(handleError);
  app.notFound(handleNotFound);

  // One caller per app, so the capability report is read from the backend once rather than on
  // every request.
  let caller: Promise<ServiceCaller> | undefined;
  const getService = (): Promise<ServiceCaller> => {
    if (!caller) {
      caller = deps
        .getService()
        .then((service) => new ServiceCaller(service))
        .catch((error) => {
          // Do not cache a failure: a transient misconfiguration should be retried.
          caller = undefined;
          throw error;
        });
    }
    return caller;
  };

  if (deps.corsOrigins && deps.corsOrigins.length > 0) {
    const allowedOrigins = deps.corsOrigins;
    app.use(
      `${API_BASE_PATH}/*`,
      cors({
        origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
        allowHeaders: ['Authorization', 'Content-Type'],
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      }),
    );
  }

  // Unauthenticated and outside the versioned prefix: load balancers and container health checks
  // have no API key.
  app.get('/health', (c) => c.json<HealthResponse>({ status: 'ok', apiVersion: API_VERSION }));

  app.use(`${API_BASE_PATH}/*`, apiKeyAuth(deps.apiKey));
  app.route(API_BASE_PATH, createTemplateRoutes({ getService }));
  app.route(API_BASE_PATH, createTagRoutes({ getService }));

  return app;
}
