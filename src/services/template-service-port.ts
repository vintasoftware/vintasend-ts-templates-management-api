/**
 * The slice of a `ManagedTemplateService` this API depends on.
 *
 * A structural type rather than the class itself, for a reason specific to Node: the operator's
 * service module resolves its own copy of `vintasend-managed-templates`, and two copies of a class
 * fail `instanceof` even when they are the same code. A host injecting its service is checked by
 * this type; a service loaded from a module path is checked by its methods, in `service-loader`.
 */

import type { JsonObject } from 'vintasend';
import type {
  ManagedTemplate,
  ManagedTemplateCreateInput,
  ManagedTemplateFilter,
  ManagedTemplateFilterCapabilities,
  ManagedTemplateOrderBy,
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
    orderBy?: ManagedTemplateOrderBy,
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

  composeTemplate(template: ManagedTemplate): Promise<ManagedTemplate>;
  getTemplateReferences(template: ManagedTemplate): TemplateReference[];
  isAbstract(template: ManagedTemplate): boolean;

  renderTemplate(
    notification: never,
    template: ManagedTemplate,
    context: JsonObject,
  ): Promise<RenderResult>;
};
