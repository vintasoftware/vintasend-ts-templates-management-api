/**
 * Tag endpoints.
 *
 * Unlike the template list — which pushes paging down to the backend — the tag seam has no
 * paginated read, so the page is taken here. Sound in a way in-process *ordering* would not be:
 * `getTags` returns the whole set in one stable order, so a page is a slice of a complete list
 * rather than a re-sort of an arbitrary window.
 */

import { Hono } from 'hono';
import type { ManagedTemplateTagStatus } from 'vintasend-managed-templates';

import type { DataResponse, ManagedTemplateTagOut, PaginatedResponse } from '../contract/types.js';
import { createTagBodySchema, tagListQuerySchema, updateTagBodySchema } from '../domain/schemas.js';
import { serializeTag } from '../domain/serialize.js';
import type { ServiceCaller } from '../services/service-caller.js';
import { validate } from './validation.js';

export type TagRoutesDependencies = {
  getService: () => Promise<ServiceCaller>;
};

/** Slice a 1-indexed page out of a complete, ordered list. */
function paginate<Row>(rows: Row[], page: number, pageSize: number): Row[] {
  const start = (page - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

export function createTagRoutes(deps: TagRoutesDependencies): Hono {
  const routes = new Hono();

  const setStatus = async (
    slug: string,
    status: ManagedTemplateTagStatus,
  ): Promise<DataResponse<ManagedTemplateTagOut>> => {
    const service = await deps.getService();
    return { data: serializeTag(await service.setTagStatus(slug, status)) };
  };

  /**
   * List tags, narrowed by status, by a text search, or by tenant.
   *
   * A tag picker wants `?status=active`: archived tags are still attached to the templates
   * carrying them and can still be filtered on, they are simply no longer offered.
   */
  routes.get('/tags', validate('query', tagListQuerySchema), async (c) => {
    const query = c.req.valid('query');
    const service = await deps.getService();

    const tags = await service.getTags(
      query.status ?? null,
      query.search ?? null,
      query.tenant ?? null,
    );
    const page = paginate(tags, query.page, query.pageSize);

    return c.json<PaginatedResponse<ManagedTemplateTagOut>>({
      data: page.map(serializeTag),
      page: query.page,
      pageSize: query.pageSize,
      hasMore: page.length === query.pageSize,
    });
  });

  /**
   * Define a tag ahead of any template using it.
   *
   * Tagging a template creates missing tags on its own, so this is for the case where a collision
   * with an existing tag is worth hearing about — it is a 409 here, where tagging a template would
   * silently resolve to the tag already there.
   */
  routes.post('/tags', validate('json', createTagBodySchema), async (c) => {
    const body = c.req.valid('json');
    const service = await deps.getService();
    const created = await service.createTag(body.text, body.tenant ?? null);
    return c.json<DataResponse<ManagedTemplateTagOut>>({ data: serializeTag(created) }, 201);
  });

  /** One tag. The path accepts the tag's slug or the text it was created from. */
  routes.get('/tags/:slug', async (c) => {
    const service = await deps.getService();
    const tag = await service.getTag(c.req.param('slug'));
    return c.json<DataResponse<ManagedTemplateTagOut>>({ data: serializeTag(tag) });
  });

  /**
   * Rename a tag. Its slug is regenerated, so its URL changes.
   *
   * The templates carrying the tag keep it, but a stored filter naming the old slug stops
   * matching — read `slug` off the response and store that. Renaming a tag onto another tag's text
   * is allowed and yields a `-2` suffix: two tags may legitimately read the same, and the slug is
   * what tells them apart.
   */
  routes.patch('/tags/:slug', validate('json', updateTagBodySchema), async (c) => {
    const service = await deps.getService();
    const tag = await service.updateTag(c.req.param('slug'), c.req.valid('json').text);
    return c.json<DataResponse<ManagedTemplateTagOut>>({ data: serializeTag(tag) });
  });

  /**
   * Delete a tag, removing the label from every template carrying it.
   *
   * Not reversible, and the templates lose the label. Archive instead when the tag should stop
   * being offered but the templates should keep it.
   */
  routes.delete('/tags/:slug', async (c) => {
    const service = await deps.getService();
    await service.deleteTag(c.req.param('slug'));
    return c.body(null, 204);
  });

  /**
   * Retire a tag from the pickers without touching the templates carrying it.
   *
   * Filtering by an archived tag still returns those templates — archiving hides the tag from
   * `?status=active`, it does not hide the templates.
   */
  routes.post('/tags/:slug/archive', async (c) => {
    return c.json(await setStatus(c.req.param('slug'), 'archived'));
  });

  /**
   * Put an archived tag back on offer.
   *
   * Unlike an archived template version — terminal, because reviving one would rewrite what its
   * audit trail says happened — a tag carries no history to contradict, so archiving one is
   * reversible.
   */
  routes.post('/tags/:slug/restore', async (c) => {
    return c.json(await setStatus(c.req.param('slug'), 'active'));
  });

  return routes;
}
