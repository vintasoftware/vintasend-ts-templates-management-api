/**
 * Public entrypoint for embedding the API in another Node process, and for sharing the wire
 * contract with TypeScript clients.
 */

export { API_BASE_PATH, type AppDependencies, createApp } from './app.js';
export { loadServerConfig, type ServerConfig } from './config.js';
export * from './contract/types.js';
export { buildBackendFilter, buildStatusFilter, buildStringFilter } from './domain/filters.js';
export { ApiError, describeMissing } from './errors.js';
export {
  logUnhandledError,
  REQUEST_ID_HEADER,
  type UnhandledErrorHandler,
} from './middleware/error-handler.js';
export type { ActorResolver } from './routes/templates.js';
export { buildTemplatePreview, PREVIEW_CONTEXT_NAME } from './services/preview.js';
export { ServiceCaller } from './services/service-caller.js';
export { createServiceProvider, loadTemplateService } from './services/service-loader.js';
export {
  asManagedTemplateServicePort,
  type ManagedTemplateServicePort,
} from './services/template-service-port.js';
