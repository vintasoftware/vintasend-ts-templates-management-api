/**
 * Request validation schemas. These define, precisely, what the API accepts — an implementation of
 * this contract in another language should reject the same inputs with the same 400 responses.
 *
 * Two things about query strings shape most of what is here. Hono hands a repeated parameter over
 * as an array and a single one as a string, so every list-valued filter has to accept both. And
 * every value arrives as text, so a boolean parameter is the string `'false'` until something
 * turns it into one — which is exactly the mistake the library's own filter validation exists to
 * catch, and better caught here.
 */

import { z } from 'zod';

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
export const MIN_PAGE_SIZE = 1;
/**
 * Largest page a client may ask for, guarding a backend that materialises a whole page in memory.
 * A module constant rather than a setting because it is published as a `maximum` in `openapi.yaml`,
 * which a per-deployment value could not be.
 */
export const MAX_PAGE_SIZE = 100;

/**
 * Longest template body/subject/preheader this API accepts. Templates are source text, not
 * documents, and a bound keeps a single request from pinning an arbitrary amount of memory.
 */
export const MAX_TEMPLATE_LENGTH = 1_000_000;

/** Longest tag text this API accepts, matching the 255-char column backends store it in. */
export const MAX_TAG_LENGTH = 255;

/**
 * Most tags one request may name — on a template, or in a single tag filter. A bound rather than
 * an unbounded list because each tag in an `includesAllTags` filter is a term the backend has to
 * satisfy, and an arbitrarily long list is an arbitrarily expensive query.
 */
export const MAX_TAGS_PER_REQUEST = 50;

const templateStatusSchema = z.enum(['draft', 'active', 'inactive', 'archived']);
const tagStatusSchema = z.enum(['active', 'archived']);

const isoDateSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'Must be an ISO-8601 date string',
  })
  .transform((value) => new Date(value));

/**
 * A parameter present but blank is a client bug worth a 400, not a filter that silently matches
 * nothing.
 */
const trimmedNonEmpty = z.string().trim().min(1, 'String should have at least 1 character');

/** Accept one repetition of a query parameter or many, and always hand back an array. */
function repeatable<Schema extends z.ZodTypeAny>(schema: Schema) {
  return z.preprocess(
    (value) => (value === undefined || Array.isArray(value) ? value : [value]),
    z.array(schema),
  );
}

/**
 * A boolean from a query string, where everything arrives as text.
 *
 * `z.coerce.boolean()` is not usable here: it applies JavaScript truthiness, under which the
 * string `'false'` is `true` — so `?mostRecentActiveVersion=false` would ask for exactly what the
 * caller meant to switch off.
 */
const booleanQuery = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  return value;
}, z.boolean());

/**
 * Trim each tag, drop the blanks, and reject a list that was nothing but blanks.
 *
 * Blank entries are dropped rather than rejected because a trailing comma in a tag input is a UI
 * artifact, not something a person meant. A list containing *only* blanks is a different thing:
 * the caller asked to filter by tags and named none, which under `includesAnyOfTags` would
 * silently match nothing.
 */
const tagFilterList = repeatable(z.string())
  .pipe(z.array(z.string()).max(MAX_TAGS_PER_REQUEST))
  .transform((tags) => tags.map((tag) => tag.trim()).filter(Boolean))
  .refine((tags) => tags.length > 0, { message: 'At least one non-empty tag is required' });

/** Tags on a write body, where an empty list is meaningful and must survive. */
const tagWriteList = z
  .array(z.string())
  .max(MAX_TAGS_PER_REQUEST)
  .transform((tags) => tags.map((tag) => tag.trim()).filter(Boolean));

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(DEFAULT_PAGE),
  pageSize: z.coerce
    .number()
    .int()
    .min(MIN_PAGE_SIZE)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});

/**
 * `version` on an endpoint that acts on the latest version when it is omitted.
 *
 * Absent is not "no version" in the sense of "all versions" — it is the service's documented
 * shorthand for "the latest one", and every route that takes this passes it through unchanged.
 */
export const versionQuerySchema = z.object({
  version: z.coerce.number().int().min(1).optional(),
});

/**
 * The path of a route that names one version: `/templates/{key}/versions/{version}`.
 *
 * Validated like any other input. Read loosely, `1abc` and `1.9` would both name version 1 — and a
 * `DELETE` would delete it.
 */
export const versionPathSchema = z.object({
  key: z.string(),
  version: z.coerce.number().int().min(1),
});

/**
 * `version` on the status-history endpoint, where omitting it means every version.
 *
 * This is the one place an absent version does *not* mean "the latest": it is forwarded to the
 * backend, which returns the whole key's history.
 */
export const statusHistoryQuerySchema = versionQuerySchema;

/**
 * Ordering, which unlike the filters has **no default**.
 *
 * Every `orderBy.*` capability defaults to false, so most backends can sort by nothing. Defaulting
 * to a field here would make the common listing a 400 against them; omitting the parameter asks
 * for the backend's own order, which is what an unordered listing has always returned.
 */
export const templateOrderByFieldSchema = z.enum([
  'key',
  'name',
  'version',
  'status',
  'createdAt',
  'updatedAt',
]);

export const templateOrderByDirectionSchema = z.enum(['asc', 'desc']);

export const templateListQuerySchema = paginationQuerySchema.extend({
  orderByField: templateOrderByFieldSchema.optional(),
  orderByDirection: templateOrderByDirectionSchema.optional(),
  key: trimmedNonEmpty.optional(),
  name: trimmedNonEmpty.optional(),
  description: trimmedNonEmpty.optional(),
  templateManagedBackend: trimmedNonEmpty.optional(),
  version: z.coerce.number().int().min(1).optional(),
  status: repeatable(templateStatusSchema).optional(),
  createdAtFrom: isoDateSchema.optional(),
  createdAtTo: isoDateSchema.optional(),
  updatedAtFrom: isoDateSchema.optional(),
  updatedAtTo: isoDateSchema.optional(),
  includesAllTags: tagFilterList.optional(),
  includesAnyOfTags: tagFilterList.optional(),
  /**
   * One row per key — the highest-numbered `active` or `draft` version — which is what a list of
   * templates almost always means. Send `false` to list every version instead; the parameter then
   * adds no constraint at all, rather than asking for the versions the default hides.
   */
  mostRecentActiveVersion: booleanQuery.default(true),
  /**
   * Bases, or templates to send. Omitted means both, which is the listing a template manager
   * wants; `false` is what a picker choosing a template to *send* asks for, and `true` what a
   * picker choosing a base to extend asks for.
   */
  isAbstract: booleanQuery.optional(),
});

export const createTemplateBodySchema = z.object({
  key: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).default(''),
  templateManagedBackend: z.string().min(1).max(255),
  bodyTemplate: z.string().min(1).max(MAX_TEMPLATE_LENGTH),
  subjectTemplate: z.string().max(MAX_TEMPLATE_LENGTH).nullish(),
  preheaderTemplate: z.string().max(MAX_TEMPLATE_LENGTH).nullish(),
  tenant: z.string().max(255).nullish(),
  /**
   * Tag *texts*, not slugs: a tag that does not exist yet is created, so a caller never has to
   * create tags before using them. Omitted or empty means an untagged template.
   */
  tags: tagWriteList.nullish(),
});

/**
 * Body of `POST /api/v1/templates/{key}/versions`.
 *
 * Every field is optional and absent means "carry this one forward": the backend copies the latest
 * version and applies only the fields that are set. That is why there is no
 * `templateManagedBackend` or `tenant` here — neither can change across versions of one key.
 *
 * A body with nothing set is accepted and produces a new version identical to the latest, which is
 * a legitimate way to branch a version off for a status change. So is no body at all.
 */
export const createVersionBodySchema = z.object({
  name: z.string().min(1).max(255).nullish(),
  description: z.string().max(2000).nullish(),
  bodyTemplate: z.string().min(1).max(MAX_TEMPLATE_LENGTH).nullish(),
  subjectTemplate: z.string().max(MAX_TEMPLATE_LENGTH).nullish(),
  preheaderTemplate: z.string().max(MAX_TEMPLATE_LENGTH).nullish(),
  /**
   * Unlike the other fields here, tags distinguish omitted from empty: omitting (or `null`)
   * carries the previous version's tags forward, `[]` creates the version with none.
   */
  tags: tagWriteList.nullish(),
});

/**
 * Body of the named lifecycle routes (activate / deactivate / archive). Optional: an omitted body
 * acts on the latest version.
 */
export const statusChangeBodySchema = z.object({
  version: z.number().int().min(1).nullish(),
  /**
   * Passed to the service untouched, `null` included: the service requires no attribution on a
   * status change and this API adds no policy of its own.
   */
  changedBy: z.string().max(255).nullish(),
});

export const setStatusBodySchema = z.object({
  version: z.number().int().min(1).nullish(),
  changedBy: z.string().max(255).nullish(),
  status: templateStatusSchema,
});

/**
 * Body of `PUT /api/v1/templates/{key}/tags`, which retags a version in place.
 *
 * An empty list is how a version's tags are cleared, so unlike the filters this one does not
 * reject it.
 */
export const setTemplateTagsBodySchema = z.object({
  tags: tagWriteList.default([]),
  version: z.number().int().min(1).nullish(),
});

/**
 * Body of `POST /api/v1/templates/{key}/preview`.
 *
 * `context` is rendered verbatim. Nothing is generated: this API has no notification to resolve a
 * registered context generator from, and a preview is meant to show what a given context produces.
 * Optional: an omitted body previews the latest version against an empty context.
 */
export const previewBodySchema = z.object({
  context: z.record(z.unknown()).default({}),
  version: z.number().int().min(1).nullish(),
});

export const tagListQuerySchema = paginationQuerySchema.extend({
  status: repeatable(tagStatusSchema).optional(),
  /** A case-insensitive substring of the tag's text or slug. */
  search: trimmedNonEmpty.optional(),
  tenant: trimmedNonEmpty.optional(),
});

/**
 * Body of `POST /api/v1/tags`.
 *
 * The slug is derived from `text` by the library and is not a client's to set: it is the tag's
 * identity, and a client-supplied one could name a tag no other caller would produce.
 */
export const createTagBodySchema = z.object({
  text: z.string().min(1).max(MAX_TAG_LENGTH),
  tenant: z.string().max(255).nullish(),
});

/**
 * Body of `PATCH /api/v1/tags/{slug}`, which renames a tag.
 *
 * The slug is regenerated from the new text, so the tag's URL changes and a stored filter naming
 * the old slug stops matching. The templates carrying the tag keep it.
 */
export const updateTagBodySchema = z.object({
  text: z.string().min(1).max(MAX_TAG_LENGTH),
});

export type TemplateListQueryInput = z.infer<typeof templateListQuerySchema>;
export type TagListQueryInput = z.infer<typeof tagListQuerySchema>;
export type VersionQueryInput = z.infer<typeof versionQuerySchema>;
export type VersionPathInput = z.infer<typeof versionPathSchema>;
export type CreateTemplateBodyInput = z.infer<typeof createTemplateBodySchema>;
export type CreateVersionBodyInput = z.infer<typeof createVersionBodySchema>;
export type StatusChangeBodyInput = z.infer<typeof statusChangeBodySchema>;
export type SetStatusBodyInput = z.infer<typeof setStatusBodySchema>;
export type SetTemplateTagsBodyInput = z.infer<typeof setTemplateTagsBodySchema>;
export type PreviewBodyInput = z.infer<typeof previewBodySchema>;
export type CreateTagBodyInput = z.infer<typeof createTagBodySchema>;
export type UpdateTagBodyInput = z.infer<typeof updateTagBodySchema>;
