/**
 * Public entrypoint for mounting the API in a host's own server, and for sharing the wire contract
 * with TypeScript clients.
 *
 * It imports no Node built-in, so it loads wherever `fetch` does, a browser included. The
 * standalone server's pieces are on `./server`, and an in-memory harness for tests and stories is
 * on `./testing`.
 */

export { API_BASE_PATH, type AppDependencies, createApp } from './app.js';
export * from './contract/types.js';
export { ApiError, invalidRequest } from './errors.js';
export {
  type Authenticated,
  type Authenticator,
  apiKeyAuthenticator,
  authenticated,
  bearerToken,
} from './middleware/authenticate.js';
export {
  logUnhandledError,
  REQUEST_ID_HEADER,
  type UnhandledErrorHandler,
} from './middleware/error-handler.js';
export type { ManagedTemplateServicePort } from './services/template-service-port.js';
