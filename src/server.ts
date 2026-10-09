/**
 * What the standalone server is built from: its environment configuration and the loader for the
 * service module it names.
 *
 * Node only, and of no use to a host that mounts `createApp` itself, so it is not on the package
 * entry: that one loads in a browser.
 */

export { loadServerConfig, type ServerConfig } from './config.js';
export {
  createServiceProvider,
  loadTemplateService,
  type ManagedTemplateServiceFactory,
} from './services/service-loader.js';
