/**
 * Wire contract for the VintaSend managed-templates API.
 *
 * These types describe the JSON payloads exchanged over HTTP. They intentionally avoid importing
 * anything from `vintasend-managed-templates`: any implementation of this contract — the
 * TypeScript one in this repo, the Python one in
 * [vintasend-templates-management-api](https://github.com/vintasoftware/vintasend-templates-management-api)
 * — must produce exactly these shapes, and a UI consuming the API needs only these definitions.
 *
 * `openapi.yaml` at the repository root is the normative statement of the same thing, shared
 * verbatim with the Python implementation so a generated client works against either server.
 *
 * All timestamps are ISO-8601 strings in UTC, with three fractional digits and a `Z` suffix —
 * what `Date.prototype.toISOString()` produces.
 */

export const API_VERSION = 'v1';

export type TemplateStatus = 'draft' | 'active' | 'inactive' | 'archived';

export type TagStatus = 'active' | 'archived';

/** Which of a template's three sources a composition reference was written in. */
export type TemplateSourceField = 'bodyTemplate' | 'subjectTemplate' | 'preheaderTemplate';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A label attached to any number of template versions.
 *
 * `slug` is the tag's identity: it is normalized from `text`, unique store-wide, and what the
 * `includesAllTags` / `includesAnyOfTags` filters match on. A client that stores a tag reference
 * should store the slug, and re-read it after a rename — editing `text` regenerates the slug, so
 * the old one stops matching.
 */
export type ManagedTemplateTagOut = {
  id: string;
  text: string;
  slug: string;
  status: TagStatus;
  tenant: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

/**
 * One version of a managed template.
 *
 * Templates are versioned rather than edited in place, so this is always a specific version of
 * `key` — never "the template" in the abstract.
 */
export type ManagedTemplateOut = {
  id: string;
  key: string;
  version: number;
  name: string;
  description: string;
  templateManagedBackend: string;
  bodyTemplate: string;
  subjectTemplate: string | null;
  preheaderTemplate: string | null;
  status: TemplateStatus;
  tenant: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  tags: ManagedTemplateTagOut[];
  /** Which statuses this version may move to right now. The status it already holds is excluded. */
  allowedTransitions: TemplateStatus[];
  isAbstract: boolean;
};

/** One entry in a template version's status audit trail. */
export type TemplateStatusHistoryOut = {
  templateKey: string;
  version: number;
  status: TemplateStatus;
  changedBy: string | null;
  tenant: string | null;
  createdAt: string | null;
};

/**
 * One template this version directly extends or includes.
 *
 * Direct references only — what the referenced templates themselves reference is not followed.
 * `version` is null when the reference names no version, which resolves to whatever that key
 * currently is at render time.
 */
export type TemplateReferenceOut = {
  kind: 'extends' | 'include';
  key: string;
  version: number | null;
  field: TemplateSourceField;
};

/**
 * A template version assembled the way the engine will receive it.
 *
 * Composition is resolved before any template engine runs: a version that extends a base or
 * includes a fragment reaches the engine as one flat string with no `managed_*` tag left in it.
 * The stored sources on `ManagedTemplateOut` are what someone typed; these are what actually
 * renders.
 *
 * Nothing here is rendered against a context — engine syntax survives untouched. Use
 * `POST /templates/{key}/preview` to see the rendered result.
 */
export type TemplateCompositionOut = {
  key: string;
  version: number;
  isAbstract: boolean;
  references: TemplateReferenceOut[];
  composedBodyTemplate: string;
  composedSubjectTemplate: string | null;
  composedPreheaderTemplate: string | null;
};

/**
 * A template version rendered against a caller-supplied context.
 *
 * `renderedSubject` and `renderedPreheader` are `null` for renderers that do not produce them —
 * an SMS renderer produces a body only.
 */
export type TemplatePreviewOut = {
  key: string;
  version: number;
  renderedBody: string;
  renderedSubject: string | null;
  renderedPreheader: string | null;
};

/** Envelope returned by every paginated endpoint. `page` is 1-indexed. */
export type PaginatedResponse<T> = {
  data: T[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

/** Envelope returned by every single-resource endpoint. */
export type DataResponse<T> = {
  data: T;
};

/** Envelope returned by endpoints whose result is a complete, unpaginated list. */
export type ListResponse<T> = {
  data: T[];
};

/**
 * Filter and ordering capabilities advertised by the configured template backend. Consumers use
 * it to hide affordances the backend cannot honour.
 *
 * `orderBy.*` keys report which fields `GET /templates` can sort by. They default to false, so a
 * backend that cannot sort reports nothing orderable — offer no sortable columns rather than
 * asking and getting a 400.
 */
export type FilterCapabilities = Record<string, boolean>;

/** Machine-readable error codes. Clients should branch on these, not on messages. */
export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATUS_TRANSITION'
  | 'PREVIEW_UNAVAILABLE'
  | 'TEMPLATE_COMPOSITION_ERROR'
  | 'INTERNAL_ERROR';

/** Error envelope returned with every non-2xx response. */
export type ApiErrorResponse = {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: JsonValue;
  };
};

export type HealthResponse = {
  status: 'ok';
  apiVersion: string;
};
