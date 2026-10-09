/**
 * Loads the operator-provided `ManagedTemplateService`.
 *
 * The API ships no template store of its own: which backend holds templates and which renderer
 * turns them into something sendable is a deployment decision.
 * `MANAGED_TEMPLATE_SERVICE_MODULE` points at a module whose default export builds a configured
 * service; see `src/vintasend-templates.config.example.ts` and the README.
 */

import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { errorMessage } from '../errors.js';
import type { ManagedTemplateServicePort } from './template-service-port.js';

export type ManagedTemplateServiceFactory = () => Promise<unknown> | unknown;

type ServiceModule = {
  default?: ManagedTemplateServiceFactory;
  createManagedTemplateService?: ManagedTemplateServiceFactory;
};

/**
 * The methods a loaded service must have for this API to work at all.
 *
 * Checked here and nowhere else: a module loaded from a path is untyped whatever it declares, so
 * this is the one place a wrong service can arrive. A host injecting its service through
 * `createApp` is checked by `ManagedTemplateServicePort` at compile time.
 */
export const REQUIRED_SERVICE_METHODS = [
  'getBackendSupportedFilterCapabilities',
  'createTemplate',
  'getTemplate',
  'updateTemplate',
  'deleteTemplate',
  'getTemplateVersions',
  'getPaginatedFilteredTemplates',
  'setStatus',
  'getStatusHistory',
  'allowedTransitionsFor',
  'getTags',
  'getTag',
  'createTag',
  'updateTag',
  'setTagStatus',
  'deleteTag',
  'setTemplateTags',
  'composeTemplate',
  'getTemplateReferences',
  'isAbstract',
  'renderTemplate',
] as const satisfies readonly (keyof ManagedTemplateServicePort)[];

/**
 * Check a loaded service against the port, naming what is missing.
 *
 * Turns "the factory returned the wrong thing" into a startup failure that says which methods it
 * lacked, rather than a `TypeError` on the first request that reaches one of them.
 */
export function asManagedTemplateServicePort(service: unknown): ManagedTemplateServicePort {
  if (service === null || typeof service !== 'object') {
    throw new Error(
      `Expected a ManagedTemplateService, got ${service === null ? 'null' : typeof service}.`,
    );
  }

  const candidate = service as Record<string, unknown>;
  const missing = REQUIRED_SERVICE_METHODS.filter(
    (method) => typeof candidate[method] !== 'function',
  );

  if (missing.length > 0) {
    throw new Error(
      'The configured service is not a ManagedTemplateService: it is missing ' +
        `${missing.join(', ')}.`,
    );
  }

  return service as ManagedTemplateServicePort;
}

function resolveModuleSpecifier(modulePath: string): string {
  if (modulePath.startsWith('.') || isAbsolute(modulePath)) {
    return pathToFileURL(resolve(process.cwd(), modulePath)).href;
  }

  // Bare specifier: let Node resolve it from node_modules.
  return modulePath;
}

export async function loadTemplateService(modulePath: string): Promise<ManagedTemplateServicePort> {
  if (!modulePath) {
    throw new Error(
      'MANAGED_TEMPLATE_SERVICE_MODULE is not set, so this API cannot build a managed-template ' +
        'service to read from. Point it at a module that default-exports a factory returning a ' +
        'configured ManagedTemplateService — see vintasend-templates.config.example.ts.',
    );
  }

  let loaded: ServiceModule;

  try {
    loaded = (await import(resolveModuleSpecifier(modulePath))) as ServiceModule;
  } catch (error) {
    throw new Error(
      `Could not load the managed-template service module "${modulePath}". ` +
        `Cause: ${errorMessage(error)}`,
    );
  }

  const factory = loaded.default ?? loaded.createManagedTemplateService;

  if (typeof factory !== 'function') {
    throw new Error(
      `The managed-template service module "${modulePath}" must export a default function ` +
        'that returns a configured ManagedTemplateService.',
    );
  }

  let service: unknown;
  try {
    service = await factory();
  } catch (error) {
    throw new Error(
      `Calling the managed-template service factory in "${modulePath}" failed. ` +
        `Cause: ${errorMessage(error)}`,
    );
  }

  try {
    return asManagedTemplateServicePort(service);
  } catch (error) {
    throw new Error(
      `The managed-template service factory in "${modulePath}" did not return a usable service. ` +
        errorMessage(error),
    );
  }
}

/**
 * Build the service once and reuse it for every request.
 *
 * Failures are not cached: a transient misconfiguration — an unreachable database at boot, say —
 * should be retried on the next request rather than poisoning the process.
 */
export function createServiceProvider(
  modulePath: string,
): () => Promise<ManagedTemplateServicePort> {
  let cached: Promise<ManagedTemplateServicePort> | undefined;

  return () => {
    if (!cached) {
      cached = loadTemplateService(modulePath).catch((error) => {
        cached = undefined;
        throw error;
      });
    }
    return cached;
  };
}
