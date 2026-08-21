/**
 * The service, with the library's exceptions already translated into the contract's errors.
 *
 * Every method here throws `ApiError` and nothing else from the library's hierarchy, so a route
 * never has to decide what a given failure means on the wire — and so the mapping is written once
 * rather than once per handler.
 */

import type { JsonObject } from 'vintasend';
import {
  type ManagedTemplate,
  ManagedTemplateChangeUserNotFoundError,
  ManagedTemplateCompositionError,
  type ManagedTemplateCreateInput,
  type ManagedTemplateFilter,
  type ManagedTemplateFilterCapabilities,
  ManagedTemplateInvalidFilterError,
  ManagedTemplateInvalidTagError,
  ManagedTemplateNotFoundError,
  type ManagedTemplateStatus,
  type ManagedTemplateStatusHistory,
  ManagedTemplateStatusTransitionError,
  type ManagedTemplateTag,
  ManagedTemplateTagAlreadyExistsError,
  ManagedTemplateTagNotFoundError,
  type ManagedTemplateTagStatus,
  type ManagedTemplateUpdateInput,
  type TemplateReference,
} from 'vintasend-managed-templates';

import { ApiError, describeMissing, errorMessage } from '../errors.js';
import type { ManagedTemplateServicePort, RenderResult } from './template-service-port.js';

type Subject = {
  /** The template a failure should be reported against, when the call names one. */
  templateKey?: string;
  version?: number | null;
  /** The tag a failure should be reported against, when the call names one. */
  tagSlug?: string;
};

/**
 * Map one library error onto the contract, most specific first.
 *
 * The order is load-bearing in one place: a composition failure is checked before "not found",
 * because a base that does not exist is a broken composition of a template that *does*. Reporting
 * it as a 404 would say the template the caller asked for is missing, when it is there and cannot
 * be assembled — which is the difference between "you asked for the wrong thing" and "this
 * template needs fixing".
 */
function toApiError(error: unknown, subject: Subject): unknown {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof ManagedTemplateCompositionError) {
    return ApiError.compositionError(error.message);
  }
  if (error instanceof ManagedTemplateStatusTransitionError) {
    return ApiError.invalidTransition(error.message);
  }
  if (error instanceof ManagedTemplateTagAlreadyExistsError) {
    // A collision is a conflict rather than a validation error: the request was well-formed, and
    // what it asked for is already there.
    return ApiError.conflict(error.message);
  }
  if (error instanceof ManagedTemplateTagNotFoundError) {
    return ApiError.notFound(
      subject.tagSlug === undefined
        ? error.message
        : `No tag with slug '${subject.tagSlug}' was found.`,
    );
  }
  if (error instanceof ManagedTemplateNotFoundError) {
    return ApiError.notFound(
      subject.templateKey === undefined
        ? error.message
        : describeMissing(subject.templateKey, subject.version ?? null),
    );
  }
  if (
    error instanceof ManagedTemplateInvalidTagError ||
    error instanceof ManagedTemplateInvalidFilterError ||
    error instanceof ManagedTemplateChangeUserNotFoundError
  ) {
    // The library's messages name the offending value and, for a filter, the known fields — so
    // they are passed through rather than replaced with something vaguer.
    return ApiError.badRequest(error.message);
  }
  return error;
}

async function translating<T>(subject: Subject, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toApiError(error, subject);
  }
}

function translatingSync<T>(subject: Subject, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw toApiError(error, subject);
  }
}

export class ServiceCaller {
  private capabilitiesCache: ManagedTemplateFilterCapabilities | null = null;

  constructor(private readonly service: ManagedTemplateServicePort) {}

  /**
   * The backend's capability report, merged over the library default.
   *
   * Cached for the life of this caller — which is the life of the process. A backend's
   * capabilities are a static property of its implementation, so re-asking on every request would
   * buy nothing.
   */
  getCapabilities(): ManagedTemplateFilterCapabilities {
    if (this.capabilitiesCache === null) {
      this.capabilitiesCache = this.service.getBackendSupportedFilterCapabilities();
    }
    return this.capabilitiesCache;
  }

  // --- reads ---------------------------------------------------------------------------------

  async getTemplate(templateKey: string, version: number | null = null): Promise<ManagedTemplate> {
    return translating({ templateKey, version }, () =>
      this.service.getTemplate(templateKey, version),
    );
  }

  /**
   * Every version of a template, newest version first.
   *
   * The service implements this by filtering on the key, which matches nothing for an unknown key
   * rather than throwing — so an empty list is how a missing key arrives here, and the route turns
   * it into the 404 the contract documents.
   */
  async getTemplateVersions(templateKey: string): Promise<ManagedTemplate[]> {
    return translating({ templateKey }, () => this.service.getTemplateVersions(templateKey));
  }

  /**
   * One page of the templates matching `filters`.
   *
   * Page numbers pass straight through: `ManagedTemplateService` validates `page >= 1` itself, so
   * the wire's 1-indexing *is* the service's convention. There is no per-backend numbering to
   * negotiate the way `vintasend-api` has to for notification backends.
   */
  async getPaginatedFilteredTemplates(
    filters: ManagedTemplateFilter,
    page: number,
    pageSize: number,
  ): Promise<ManagedTemplate[]> {
    return translating({}, () =>
      this.service.getPaginatedFilteredTemplates(filters, page, pageSize),
    );
  }

  async getStatusHistory(
    templateKey: string,
    version: number | null = null,
  ): Promise<ManagedTemplateStatusHistory[]> {
    return translating({ templateKey, version }, () =>
      this.service.getStatusHistory(templateKey, version),
    );
  }

  /**
   * Which statuses `template` may move to right now, in a stable order.
   *
   * Asks the service rather than reading its transition table directly, so a service with its own
   * lifecycle — or one with `validateStatusTransitions` turned off, where every status is
   * reachable — is reported accurately.
   */
  allowedTransitions(template: ManagedTemplate): ManagedTemplateStatus[] {
    return this.service.allowedTransitionsFor(template);
  }

  // --- writes --------------------------------------------------------------------------------

  async createTemplate(data: ManagedTemplateCreateInput): Promise<ManagedTemplate> {
    return translating({ templateKey: data.key }, () => this.service.createTemplate(data));
  }

  async updateTemplate(
    templateKey: string,
    data: ManagedTemplateUpdateInput,
  ): Promise<ManagedTemplate> {
    return translating({ templateKey }, () => this.service.updateTemplate(templateKey, data));
  }

  async deleteTemplate(templateKey: string, version: number | null = null): Promise<void> {
    return translating({ templateKey, version }, () =>
      this.service.deleteTemplate(templateKey, version),
    );
  }

  async setStatus(
    templateKey: string,
    status: ManagedTemplateStatus,
    version: number | null = null,
    changedBy: string | null = null,
  ): Promise<ManagedTemplate> {
    return translating({ templateKey, version }, () =>
      this.service.setStatus(templateKey, status, version, changedBy),
    );
  }

  // --- tags ----------------------------------------------------------------------------------

  async getTags(
    status: ManagedTemplateTagStatus[] | null = null,
    search: string | null = null,
    tenant: string | null = null,
  ): Promise<ManagedTemplateTag[]> {
    return translating({}, () => this.service.getTags(status, search, tenant));
  }

  async getTag(slug: string): Promise<ManagedTemplateTag> {
    return translating({ tagSlug: slug }, () => this.service.getTag(slug));
  }

  async createTag(text: string, tenant: string | null = null): Promise<ManagedTemplateTag> {
    return translating({}, () => this.service.createTag(text, tenant));
  }

  async updateTag(slug: string, text: string): Promise<ManagedTemplateTag> {
    return translating({ tagSlug: slug }, () => this.service.updateTag(slug, text));
  }

  async setTagStatus(slug: string, status: ManagedTemplateTagStatus): Promise<ManagedTemplateTag> {
    return translating({ tagSlug: slug }, () => this.service.setTagStatus(slug, status));
  }

  async deleteTag(slug: string): Promise<void> {
    return translating({ tagSlug: slug }, () => this.service.deleteTag(slug));
  }

  /** Replace one version's tags in place — no new version, no status change. */
  async setTemplateTags(
    templateKey: string,
    tags: string[],
    version: number | null = null,
  ): Promise<ManagedTemplate> {
    return translating({ templateKey, version }, () =>
      this.service.setTemplateTags(templateKey, tags, version),
    );
  }

  // --- composition ---------------------------------------------------------------------------

  /**
   * One version assembled the way the template engine will receive it.
   *
   * Composition failures are the template's, not the request's: a base that does not exist, a
   * chain that loops, a malformed tag. They are reported as `TEMPLATE_COMPOSITION_ERROR` carrying
   * the library's message, which names the chain it failed on — the message is the point, since it
   * is what makes the template fixable.
   */
  async getComposedTemplate(
    templateKey: string,
    version: number | null = null,
  ): Promise<ManagedTemplate> {
    return translating({ templateKey, version }, () =>
      this.service.getComposedTemplate(templateKey, version),
    );
  }

  /**
   * The templates this version directly extends or includes.
   *
   * Nothing is resolved, so a reference to a template that does not exist is reported rather than
   * throwing. A malformed tag still is — there is no reference to report when the source cannot be
   * parsed at all.
   */
  getTemplateReferences(template: ManagedTemplate): TemplateReference[] {
    return translatingSync({ templateKey: template.key }, () =>
      this.service.getTemplateReferences(template),
    );
  }

  /** Whether a version is a base to build on, recomputed from its source. */
  isAbstract(template: ManagedTemplate): boolean {
    return translatingSync({ templateKey: template.key }, () => this.service.isAbstract(template));
  }

  // --- rendering -----------------------------------------------------------------------------

  /**
   * Render a template already in hand, with no second backend read.
   *
   * The template is fetched by the caller so a preview can pin an explicit version — which is the
   * point of previewing a draft that has not been activated.
   */
  async renderTemplate(
    notification: never,
    template: ManagedTemplate,
    context: JsonObject,
  ): Promise<RenderResult> {
    return this.service.renderTemplate(notification, template, context);
  }
}

export { errorMessage };
