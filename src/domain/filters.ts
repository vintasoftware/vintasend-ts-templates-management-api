/**
 * Translates validated query parameters into a `ManagedTemplateFilter`.
 *
 * String filters are negotiated against the backend's advertised capabilities: a backend that
 * cannot do case-insensitive `includes` gets an exact match instead, and a field the backend
 * cannot filter on at all is dropped rather than failing the request. Dropping an unsupported
 * filter is the contract's choice; failing the request is not.
 */

import {
  type ManagedTemplateFilterCapabilities,
  type ManagedTemplateFilterFields,
  type ManagedTemplateStatus,
  type ManagedTemplateStatusFilter,
  type StringFieldFilter,
  supportsCapability,
} from 'vintasend-managed-templates';

import type { TemplateListQueryInput } from './schemas.js';

/**
 * Wire query parameter → the capability key guarding it, and the filter field it becomes. Kept as
 * one table so adding a filter cannot leave the capability check behind.
 */
const STRING_FIELDS = [
  { wire: 'key', capability: 'fields.key', field: 'key' },
  { wire: 'name', capability: 'fields.name', field: 'name' },
  { wire: 'description', capability: 'fields.description', field: 'description' },
  {
    wire: 'templateManagedBackend',
    capability: 'fields.templateManagedBackend',
    field: 'templateManagedBackend',
  },
] as const satisfies readonly {
  wire: keyof TemplateListQueryInput;
  capability: string;
  field: keyof ManagedTemplateFilterFields;
}[];

/**
 * Values pass through as the caller wrote them: the library slugifies filter values itself, so a
 * tag may be named here by its slug or by the text behind it.
 */
const TAG_FIELDS = [
  { wire: 'includesAllTags', capability: 'fields.includesAllTags', field: 'includesAllTags' },
  {
    wire: 'includesAnyOfTags',
    capability: 'fields.includesAnyOfTags',
    field: 'includesAnyOfTags',
  },
] as const satisfies readonly {
  wire: keyof TemplateListQueryInput;
  capability: string;
  field: keyof ManagedTemplateFilterFields;
}[];

/**
 * Pick the most precise string lookup the backend supports.
 *
 * Case-insensitive `includes` when available, otherwise a case-insensitive exact match, otherwise
 * a plain equality match (a bare string, which the filter vocabulary reads as a case-sensitive
 * `exact`).
 *
 * `caseSensitive` is always set rather than left off when the backend cannot fold case: it is
 * optional in the vocabulary and defaults to `true`, so omitting it on the case-insensitive path
 * would quietly ask for the opposite of what was negotiated.
 */
export function buildStringFilter(
  value: string,
  capabilities: ManagedTemplateFilterCapabilities,
): StringFieldFilter {
  const supportsIncludes = supportsCapability(capabilities, 'stringLookups.includes');
  const supportsCaseInsensitive = supportsCapability(capabilities, 'stringLookups.caseInsensitive');

  if (supportsIncludes) {
    return { lookup: 'includes', value, caseSensitive: !supportsCaseInsensitive };
  }

  if (supportsCaseInsensitive) {
    return { lookup: 'exact', value, caseSensitive: false };
  }

  return value;
}

/**
 * One status becomes an exact match; several become an `in` lookup.
 *
 * A bare status is the filter vocabulary's exact match, so the single-status case needs no lookup
 * wrapper.
 */
export function buildStatusFilter(statuses: ManagedTemplateStatus[]): ManagedTemplateStatusFilter {
  if (statuses.length === 1) {
    return statuses[0] as ManagedTemplateStatus;
  }
  return { lookup: 'in', value: statuses };
}

/** Map the validated query onto the filter the backend evaluates. Fields combine with AND. */
export function buildBackendFilter(
  query: TemplateListQueryInput,
  capabilities: ManagedTemplateFilterCapabilities,
): ManagedTemplateFilterFields {
  const filter: ManagedTemplateFilterFields = {};

  for (const { wire, capability, field } of STRING_FIELDS) {
    const value = query[wire];
    if (typeof value === 'string' && value && supportsCapability(capabilities, capability)) {
      // Every entry in STRING_FIELDS maps a string query parameter onto a string filter field;
      // the `satisfies` above is what keeps that true, and this is the assignment it licenses.
      (filter as Record<string, StringFieldFilter>)[field] = buildStringFilter(value, capabilities);
    }
  }

  if (query.version !== undefined && supportsCapability(capabilities, 'fields.version')) {
    filter.version = query.version;
  }

  // Only `true` is ever sent. `mostRecentActiveVersion=false` is a client asking for every
  // version, which is the *absence* of this filter — sending `false` would ask the backend for the
  // complement, the older and retired rows on their own, which is not what switching a default off
  // means.
  if (
    query.mostRecentActiveVersion &&
    supportsCapability(capabilities, 'fields.mostRecentActiveVersion')
  ) {
    filter.mostRecentActiveVersion = true;
  }

  // `!== undefined` rather than truthiness: `false` is a filter here (the sendable templates), not
  // an absent parameter.
  if (query.isAbstract !== undefined && supportsCapability(capabilities, 'fields.isAbstract')) {
    filter.isAbstract = query.isAbstract;
  }

  if (
    query.status !== undefined &&
    query.status.length > 0 &&
    supportsCapability(capabilities, 'fields.status')
  ) {
    filter.status = buildStatusFilter(query.status);
  }

  if (
    (query.createdAtFrom !== undefined || query.createdAtTo !== undefined) &&
    supportsCapability(capabilities, 'fields.createdAtRange')
  ) {
    filter.createdAtRange = {
      ...(query.createdAtFrom === undefined ? {} : { from: query.createdAtFrom }),
      ...(query.createdAtTo === undefined ? {} : { to: query.createdAtTo }),
    };
  }

  if (
    (query.updatedAtFrom !== undefined || query.updatedAtTo !== undefined) &&
    supportsCapability(capabilities, 'fields.updatedAtRange')
  ) {
    filter.updatedAtRange = {
      ...(query.updatedAtFrom === undefined ? {} : { from: query.updatedAtFrom }),
      ...(query.updatedAtTo === undefined ? {} : { to: query.updatedAtTo }),
    };
  }

  for (const { wire, capability, field } of TAG_FIELDS) {
    const tags = query[wire];
    // `if (tags?.length)` rather than `!== undefined`: query validation already rejects a list with
    // nothing usable in it, so an empty one here can only be an absent parameter. Passing `[]`
    // through would be a filter that matches everything or nothing depending on which of the two
    // it is — a meaning no caller asked for.
    if (Array.isArray(tags) && tags.length > 0 && supportsCapability(capabilities, capability)) {
      (filter as Record<string, string[]>)[field] = [...tags];
    }
  }

  return filter;
}
