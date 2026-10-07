/**
 * Template endpoints.
 *
 * Each handler maps HTTP input to a `ManagedTemplateService` call and the result back to the wire
 * contract — no business logic beyond the translation itself. The lifecycle rules, the version
 * resolution and the filter validation all live in the service, which is the point: this API is
 * one more caller of it, not a second implementation of it.
 */

import { type Context, Hono } from 'hono';
import type { JsonObject } from 'vintasend';
import type { ManagedTemplate, ManagedTemplateStatus } from 'vintasend-managed-templates';

import type {
  DataResponse,
  FilterCapabilities,
  ListResponse,
  ManagedTemplateOut,
  PaginatedResponse,
  TemplateCompositionOut,
  TemplatePreviewOut,
  TemplateStatusHistoryOut,
} from '../contract/types.js';
import { buildBackendFilter, buildOrderBy } from '../domain/filters.js';
import {
  createTemplateBodySchema,
  createVersionBodySchema,
  previewBodySchema,
  setStatusBodySchema,
  setTemplateTagsBodySchema,
  statusChangeBodySchema,
  statusHistoryQuerySchema,
  templateListQuerySchema,
  versionQuerySchema,
} from '../domain/schemas.js';
import {
  serializeComposition,
  serializeStatusHistory,
  serializeTemplate,
} from '../domain/serialize.js';
import { ApiError, describeMissing } from '../errors.js';
import { buildTemplatePreview } from '../services/preview.js';
import type { ServiceCaller } from '../services/service-caller.js';
import { readOptionalJson, validate } from './validation.js';

/** Resolves the identity a status change is attributed to. See `AppDependencies.resolveActor`. */
export type ActorResolver = (c: Context) => string | null | Promise<string | null>;

export type TemplateRoutesDependencies = {
  getService: () => Promise<ServiceCaller>;
  resolveActor?: ActorResolver;
};

function versionParam(raw: string): number {
  const version = Number.parseInt(raw, 10);
  if (!Number.isInteger(version) || version < 1) {
    throw ApiError.badRequest('Invalid request.', {
      issues: [{ path: 'version', message: 'Must be an integer of 1 or greater' }],
    });
  }
  return version;
}

export function createTemplateRoutes(deps: TemplateRoutesDependencies): Hono {
  const routes = new Hono();

  const out = (service: ServiceCaller, template: ManagedTemplate): ManagedTemplateOut =>
    serializeTemplate(template, service.allowedTransitions(template));

  const data = (
    service: ServiceCaller,
    template: ManagedTemplate,
  ): DataResponse<ManagedTemplateOut> => ({ data: out(service, template) });

  /**
   * Body shared by the four status routes, which differ only in how the target is chosen.
   *
   * Attribution comes from the host's `resolveActor` when one is configured, replacing anything
   * the body claims; the body's `changedBy` is only used when there is no resolver.
   */
  const changeStatus = async (
    c: Context,
    status: ManagedTemplateStatus,
    payload: { version?: number | null; changedBy?: string | null },
  ): Promise<DataResponse<ManagedTemplateOut>> => {
    const changedBy = deps.resolveActor ? await deps.resolveActor(c) : (payload.changedBy ?? null);
    const service = await deps.getService();
    const template = await service.setStatus(
      c.req.param('key') as string,
      status,
      payload.version ?? null,
      changedBy,
    );
    return data(service, template);
  };

  // --- system ------------------------------------------------------------------------------

  /**
   * Which filters and orders the configured template backend can honour.
   *
   * `orderBy.*` keys report which fields `GET /templates` can sort by. They default to false, so
   * a backend that cannot sort reports nothing orderable and a client should offer no sortable
   * columns — asking for one anyway is a 400 rather than an unordered page that looks sorted.
   */
  routes.get('/capabilities', async (c) => {
    const service = await deps.getService();
    return c.json<DataResponse<FilterCapabilities>>({ data: service.getCapabilities() });
  });

  // --- templates ---------------------------------------------------------------------------

  /**
   * List templates matching the filters — one row per key by default.
   *
   * A row in the store is a *version*, so an unfiltered read of the seam returns a key once per
   * version it has ever had. `mostRecentActiveVersion` defaults to `true` and asks the backend for
   * the current version of each key instead: the highest-numbered `active` or `draft` one. The
   * collapsing happens in the store, not here, so a page is still a page of what the backend
   * counted.
   *
   * Send `mostRecentActiveVersion=false` for the raw listing, every version included. A backend
   * that cannot answer the filter has it dropped like any other unsupported one, and then returns
   * every version too.
   */
  routes.get('/templates', validate('query', templateListQuerySchema), async (c) => {
    const query = c.req.valid('query');
    const service = await deps.getService();

    const capabilities = service.getCapabilities();
    const templates = await service.getPaginatedFilteredTemplates(
      buildBackendFilter(query, capabilities),
      query.page,
      query.pageSize,
      buildOrderBy(query, capabilities),
    );

    const rows = templates.map((template) => out(service, template));
    return c.json<PaginatedResponse<ManagedTemplateOut>>({
      data: rows,
      page: query.page,
      pageSize: query.pageSize,
      // True when the page came back full, meaning another page may exist. The seam has no count
      // method, so no total is available.
      hasMore: rows.length === query.pageSize,
    });
  });

  /**
   * Create a template's first version.
   *
   * Whether re-using an existing key is an error is the backend's call, not this API's — the seam
   * does not define it, and a backend that treats a repeat `createTemplate` as a new version is
   * behaving legitimately. Use `POST /templates/{key}/versions` when you mean "next version of
   * this key".
   */
  routes.post('/templates', validate('json', createTemplateBodySchema), async (c) => {
    const body = c.req.valid('json');
    const service = await deps.getService();

    const template = await service.createTemplate({
      key: body.key,
      name: body.name,
      description: body.description,
      templateManagedBackend: body.templateManagedBackend,
      bodyTemplate: body.bodyTemplate,
      subjectTemplate: body.subjectTemplate ?? null,
      preheaderTemplate: body.preheaderTemplate ?? null,
      tenant: body.tenant ?? null,
      tags: body.tags ?? null,
    });

    return c.json<DataResponse<ManagedTemplateOut>>(data(service, template), 201);
  });

  // The `/versions` routes are registered before `/templates/:key` on purpose: routes match in
  // registration order, and although the paths differ in segment count, keeping the more specific
  // ones first makes the precedence explicit rather than incidental.

  /**
   * Every version of one template, newest version first.
   *
   * The service resolves this by filtering on the key, which matches nothing for a key that does
   * not exist rather than throwing — so an empty result is a missing key, and is reported as the
   * 404 the contract documents rather than an empty list. A key that exists always has at least
   * one version.
   */
  routes.get('/templates/:key/versions', async (c) => {
    const key = c.req.param('key');
    const service = await deps.getService();
    const versions = await service.getTemplateVersions(key);

    if (versions.length === 0) {
      throw ApiError.notFound(describeMissing(key, null));
    }

    return c.json<ListResponse<ManagedTemplateOut>>({
      data: versions.map((template) => out(service, template)),
    });
  });

  /**
   * Create a new version of an existing template, copied forward from its latest one.
   *
   * Templates are versioned rather than edited in place, which is why this is a POST that creates
   * a resource and not a PATCH that mutates one: an already-published version is never modified.
   * Fields left unset are carried over from the latest version.
   */
  routes.post('/templates/:key/versions', validate('json', createVersionBodySchema), async (c) => {
    const body = c.req.valid('json');
    const service = await deps.getService();

    const template = await service.updateTemplate(c.req.param('key'), {
      name: body.name ?? null,
      description: body.description ?? null,
      bodyTemplate: body.bodyTemplate ?? null,
      subjectTemplate: body.subjectTemplate ?? null,
      preheaderTemplate: body.preheaderTemplate ?? null,
      // `undefined` carries the previous version's tags forward; `[]` clears them. Collapsing
      // the two here would make an explicit "no tags" indistinguishable from silence.
      tags: body.tags === undefined ? undefined : (body.tags ?? null),
    });

    return c.json<DataResponse<ManagedTemplateOut>>(data(service, template), 201);
  });

  routes.get('/templates/:key/versions/:version', async (c) => {
    const service = await deps.getService();
    const template = await service.getTemplate(
      c.req.param('key'),
      versionParam(c.req.param('version')),
    );
    return c.json<DataResponse<ManagedTemplateOut>>(data(service, template));
  });

  /**
   * Delete one version that was never published.
   *
   * A version that was ever published is refused with a 409 `CONFLICT`: a notification may be
   * pinned to it, and its status history is the record of who published it. Archive it instead.
   */
  routes.delete('/templates/:key/versions/:version', async (c) => {
    const service = await deps.getService();
    await service.deleteTemplate(c.req.param('key'), versionParam(c.req.param('version')));
    return c.body(null, 204);
  });

  /**
   * One version assembled the way the template engine will receive it.
   *
   * A managed template can build on another: `{% managed_extends "base" %}` to fill a base's
   * `{% managed_children %}` hole and override its `{% managed_block %}` regions,
   * `{% managed_include "footer" %}` to splice a fragment in. All of it is resolved before the
   * engine runs, so the stored `bodyTemplate` is only half the template — this is what actually
   * renders.
   *
   * Nothing here is rendered against a context: engine syntax survives untouched. Use
   * `POST /templates/{key}/preview` for the rendered result.
   *
   * Also reports what this version directly references, and whether it is abstract — recomputed
   * from the source rather than read from the stored flag, so it is the authority behind the
   * `isAbstract` on every template payload.
   */
  routes.get('/templates/:key/composition', validate('query', versionQuerySchema), async (c) => {
    const key = c.req.param('key');
    const version = c.req.valid('query').version ?? null;
    const service = await deps.getService();

    const template = await service.getTemplate(key, version);
    const composed = await service.getComposedTemplate(key, version);

    return c.json<DataResponse<TemplateCompositionOut>>({
      data: serializeComposition(
        template,
        composed,
        service.getTemplateReferences(template),
        service.isAbstract(template),
      ),
    });
  });

  /**
   * The status audit trail, most recent change first.
   *
   * Omitting `version` asks for the whole key's history, which backends that keep it that way will
   * return. Unlike everywhere else in this API, an absent `version` here does not mean "the latest
   * version".
   */
  routes.get(
    '/templates/:key/status-history',
    validate('query', statusHistoryQuerySchema),
    async (c) => {
      const service = await deps.getService();
      const history = await service.getStatusHistory(
        c.req.param('key'),
        c.req.valid('query').version ?? null,
      );
      return c.json<ListResponse<TemplateStatusHistoryOut>>({
        data: history.map(serializeStatusHistory),
      });
    },
  );

  /**
   * Move one version to an explicitly named status.
   *
   * Setting a version to the status it already holds is a no-op the service reports as success:
   * the version comes back unchanged and no audit entry is written, so a client retrying a request
   * does not fill the trail with entries recording nothing.
   *
   * A move the lifecycle does not allow is a 409 with code `INVALID_STATUS_TRANSITION`.
   * `allowedTransitions` on every template payload says in advance which moves will work.
   */
  routes.post('/templates/:key/status', validate('json', setStatusBodySchema), async (c) => {
    const body = c.req.valid('json');
    return c.json(await changeStatus(c, body.status, body));
  });

  /**
   * Publish one version.
   *
   * Other versions of the same key that are already active are left alone: a key may hold several
   * active versions at once. An unpinned send renders the highest-numbered active version, so
   * activating an older version while a newer one is active does not change what is sent.
   */
  routes.post('/templates/:key/activate', async (c) => {
    const body = statusChangeBodySchema.parse(await readOptionalJson(c));
    return c.json(await changeStatus(c, 'active', body));
  });

  /** Retire one version without archiving it, so it can be activated again later. */
  routes.post('/templates/:key/deactivate', async (c) => {
    const body = statusChangeBodySchema.parse(await readOptionalJson(c));
    return c.json(await changeStatus(c, 'inactive', body));
  });

  /**
   * Archive one version. Terminal under the default lifecycle: an archived version has no allowed
   * transitions, and publishing a new version is the way forward from there.
   */
  routes.post('/templates/:key/archive', async (c) => {
    const body = statusChangeBodySchema.parse(await readOptionalJson(c));
    return c.json(await changeStatus(c, 'archived', body));
  });

  /**
   * Render a version against a supplied context, whatever its status.
   *
   * Pinning `version` is the point: it is what lets a draft be reviewed before anyone activates
   * it. Omitting it previews the latest version, draft included. That is not what a send renders:
   * a send never renders a draft, only the newest active version, and for a key with nothing
   * published it may render a default the application registered instead.
   *
   * A template that fails to render comes back as a 409 `PREVIEW_UNAVAILABLE` carrying the
   * renderer's message, because a broken template is what the caller asked to find out.
   */
  routes.post('/templates/:key/preview', async (c) => {
    const body = previewBodySchema.parse(await readOptionalJson(c));
    const service = await deps.getService();
    const template = await service.getTemplate(c.req.param('key'), body.version ?? null);

    return c.json<DataResponse<TemplatePreviewOut>>({
      data: await buildTemplatePreview(service, template, body.context as JsonObject),
    });
  });

  /**
   * Replace one version's tags, creating any tag that does not exist yet.
   *
   * A PUT that edits a version in place, unlike every other write on a template — which creates a
   * version instead. Tags describe how a template is *found*, not what it renders, so relabelling
   * one should not fork a version and drop it back to draft. To change the tags *and* the content
   * together, send them on `POST /templates/{key}/versions`.
   *
   * An empty `tags` list clears the version's tags. Omitting `version` retags the latest.
   */
  routes.put('/templates/:key/tags', validate('json', setTemplateTagsBodySchema), async (c) => {
    const body = c.req.valid('json');
    const service = await deps.getService();
    const template = await service.setTemplateTags(
      c.req.param('key'),
      body.tags,
      body.version ?? null,
    );
    return c.json<DataResponse<ManagedTemplateOut>>(data(service, template));
  });

  // Registered last: `/templates/:key` would otherwise be a candidate for paths the routes above
  // own.

  /** One version of a template. Omitting `version` returns the latest. */
  routes.get('/templates/:key', validate('query', versionQuerySchema), async (c) => {
    const service = await deps.getService();
    const template = await service.getTemplate(
      c.req.param('key'),
      c.req.valid('query').version ?? null,
    );
    return c.json<DataResponse<ManagedTemplateOut>>(data(service, template));
  });

  /**
   * Delete one version of a template, or its latest version when `version` is omitted.
   *
   * This deletes a *version*, never a whole key: the seam has no operation that removes every
   * version at once, and doing it here as a loop would be a multi-step deletion with no
   * transaction around it.
   *
   * Only a version that was never published can be deleted; anything else is a 409 `CONFLICT`.
   * That includes the latest version when `version` is omitted, so this route cannot remove a
   * published version by accident. Prefer naming the version.
   */
  routes.delete('/templates/:key', validate('query', versionQuerySchema), async (c) => {
    const service = await deps.getService();
    await service.deleteTemplate(c.req.param('key'), c.req.valid('query').version ?? null);
    return c.body(null, 204);
  });

  return routes;
}
