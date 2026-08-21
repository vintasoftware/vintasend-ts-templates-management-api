/**
 * The slice of a `ManagedTemplateService` this API depends on.
 *
 * A structural type rather than the class itself, for a reason specific to Node: the operator's
 * service module resolves its own copy of `vintasend-managed-templates`, and two copies of a class
 * fail `instanceof` even when they are the same code. So the service is validated by the methods
 * it has, which is also what actually matters here.
 */

import type { JsonObject } from 'vintasend';
import type {
  ManagedTemplate,
  ManagedTemplateCreateInput,
  ManagedTemplateFilter,
  ManagedTemplateFilterCapabilities,
  ManagedTemplateStatus,
  ManagedTemplateStatusHistory,
  ManagedTemplateTag,
  ManagedTemplateTagStatus,
  ManagedTemplateUpdateInput,
  TemplateReference,
} from 'vintasend-managed-templates';

/** What rendering produced, and which version produced it. */
export type RenderResult = {
  key: string;
  version: number;
  rendered: unknown;
};

export type ManagedTemplateServicePort = {
  getBackendSupportedFilterCapabilities(): ManagedTemplateFilterCapabilities;

  createTemplate(input: ManagedTemplateCreateInput): Promise<ManagedTemplate>;
  getTemplate(templateKey: string, version?: number | null): Promise<ManagedTemplate>;
  updateTemplate(templateKey: string, input: ManagedTemplateUpdateInput): Promise<ManagedTemplate>;
  deleteTemplate(templateKey: string, version?: number | null): Promise<void>;
  getTemplateVersions(templateKey: string): Promise<ManagedTemplate[]>;
  getPaginatedFilteredTemplates(
    filters: ManagedTemplateFilter,
    page: number,
    pageSize: number,
  ): Promise<ManagedTemplate[]>;

  setStatus(
    templateKey: string,
    status: ManagedTemplateStatus,
    version?: number | null,
    changedBy?: string | null,
  ): Promise<ManagedTemplate>;
  getStatusHistory(
    templateKey: string,
    version?: number | null,
  ): Promise<ManagedTemplateStatusHistory[]>;
  allowedTransitionsFor(template: ManagedTemplate): ManagedTemplateStatus[];

  getTags(
    status?: ManagedTemplateTagStatus[] | null,
    search?: string | null,
    tenant?: string | null,
  ): Promise<ManagedTemplateTag[]>;
  getTag(slug: string): Promise<ManagedTemplateTag>;
  createTag(text: string, tenant?: string | null): Promise<ManagedTemplateTag>;
  updateTag(slug: string, text: string): Promise<ManagedTemplateTag>;
  setTagStatus(slug: string, status: ManagedTemplateTagStatus): Promise<ManagedTemplateTag>;
  deleteTag(slug: string): Promise<void>;
  setTemplateTags(
    templateKey: string,
    tags: string[],
    version?: number | null,
  ): Promise<ManagedTemplate>;

  getComposedTemplate(templateKey: string, version?: number | null): Promise<ManagedTemplate>;
  getTemplateReferences(template: ManagedTemplate): TemplateReference[];
  isAbstract(template: ManagedTemplate): boolean;

  renderTemplate(
    notification: never,
    template: ManagedTemplate,
    context: JsonObject,
  ): Promise<RenderResult>;
};

/** The methods a loaded service must have for this API to work at all. */
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
  'getComposedTemplate',
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
