/**
 * Builds the HTTP application.
 *
 * What the API needs from the outside world — who the caller is, and a configured
 * `ManagedTemplateService` — is injected, so the app can be exercised in tests without a database,
 * a template engine, or a FHIR server, and mounted behind a host's own authentication.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { API_VERSION, type HealthResponse } from './contract/types.js';
import { type Authenticator, authenticateWith } from './middleware/authenticate.js';
import {
  createErrorHandler,
  handleNotFound,
  type UnhandledErrorHandler,
} from './middleware/error-handler.js';
import { createTagRoutes } from './routes/tags.js';
import { createTemplateRoutes } from './routes/templates.js';
import { ServiceCaller } from './services/service-caller.js';
import type { ManagedTemplateServicePort } from './services/template-service-port.js';

export type AppDependencies = {
  /**
   * Runs before every `/api/v1` route. It refuses a caller by throwing `ApiError.unauthorized` or
   * `ApiError.forbidden`, and otherwise may name the caller as `actor`, which every status change
   * then records as `changedBy` in place of anything the request body claims.
   *
   * `apiKeyAuthenticator(key)` is the shared-secret case. It names no actor, so `changedBy` comes
   * from the body; that is only safe when every caller holding the key is trusted to attribute
   * honestly.
   */
  authenticate: Authenticator;
  getService: () => Promise<ManagedTemplateServicePort>;
  corsOrigins?: string[];
  /**
   * Receives every error the API does not map to a contract error. Defaults to a single log line
   * with the error's class name, a request id and the route — never the error object, the request
   * body or a preview context. If the handler throws, that default line is logged instead. The
   * client gets the generic 500 either way.
   */
  onUnhandledError?: UnhandledErrorHandler;
};

export const API_BASE_PATH = `/api/${API_VERSION}`;

export function createApp(deps: AppDependencies): Hono {
  const app = new Hono();

  app.onError(createErrorHandler(deps.onUnhandledError));
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
  // have no credentials.
  app.get('/health', (c) => c.json<HealthResponse>({ status: 'ok', apiVersion: API_VERSION }));

  app.use(`${API_BASE_PATH}/*`, authenticateWith(deps.authenticate));
  app.route(API_BASE_PATH, createTemplateRoutes({ getService }));
  app.route(API_BASE_PATH, createTagRoutes({ getService }));

  return app;
}
