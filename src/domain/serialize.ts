/**
 * Converts `vintasend-managed-templates` values into the wire contract.
 *
 * Dates always become ISO-8601 UTC strings, and absent dates are normalised to `null` (never
 * omitted) so JSON responses are uniform. Ids are stringified whatever a backend keys on, so a
 * store on integers, strings or UUIDs all produce the same shape.
 *
 * The library and the wire spell every field the same way — both are camelCase — which is why this
 * module is short: there is nothing to translate, only to shape.
 */

import type {
  ManagedTemplate,
  ManagedTemplateStatus,
  ManagedTemplateStatusHistory,
  ManagedTemplateTag,
  TemplateReference,
} from 'vintasend-managed-templates';

import type {
  ManagedTemplateOut,
  ManagedTemplateTagOut,
  TemplateCompositionOut,
  TemplateReferenceOut,
  TemplateStatusHistoryOut,
} from '../contract/types.js';

/**
 * Render a timestamp as an ISO-8601 UTC string, or `null` when unset.
 *
 * `toISOString` gives exactly three fractional digits and a `Z` suffix, which is the format the
 * contract documents and what the Python implementation produces by hand.
 */
export function toIso(value: Date | null | undefined): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return null;
  }
  return value.toISOString();
}

export function serializeTag(tag: ManagedTemplateTag): ManagedTemplateTagOut {
  return {
    id: String(tag.id),
    text: tag.text,
    slug: tag.slug,
    status: tag.status,
    tenant: tag.tenant,
    createdAt: toIso(tag.createdAt),
    updatedAt: toIso(tag.updatedAt),
  };
}

/**
 * Serialize one version of a template.
 *
 * `allowedTransitions` is passed in rather than computed here because answering it means asking
 * the configured service, which serialization has no business reaching.
 */
export function serializeTemplate(
  template: ManagedTemplate,
  allowedTransitions: ManagedTemplateStatus[],
): ManagedTemplateOut {
  return {
    id: String(template.id),
    key: template.key,
    version: template.version,
    name: template.name,
    description: template.description,
    templateManagedBackend: template.templateManagedBackend,
    bodyTemplate: template.bodyTemplate,
    subjectTemplate: template.subjectTemplate,
    preheaderTemplate: template.preheaderTemplate,
    status: template.status,
    tenant: template.tenant,
    createdAt: toIso(template.createdAt),
    updatedAt: toIso(template.updatedAt),
    tags: template.tags.map(serializeTag),
    allowedTransitions,
    // The backend's stored flag, read straight off the record: it is a denormalization of the
    // source that the backend maintains on every write, so serializing a listing costs no parsing
    // and cannot fail on a template with a malformed tag.
    isAbstract: template.isAbstract,
  };
}

export function serializeStatusHistory(
  record: ManagedTemplateStatusHistory,
): TemplateStatusHistoryOut {
  return {
    templateKey: record.templateKey,
    version: record.version,
    status: record.status,
    changedBy: record.changedBy,
    tenant: record.tenant,
    createdAt: toIso(record.createdAt),
  };
}

export function serializeReference(reference: TemplateReference): TemplateReferenceOut {
  return {
    kind: reference.kind,
    key: reference.key,
    version: reference.version,
    field: reference.field,
  };
}

/**
 * Serialize a version's assembled form.
 *
 * `template` supplies the identity and `composed` the assembled sources — they are the same
 * version, before and after composition, and the composer hands back the very same object when
 * there was nothing to assemble.
 */
export function serializeComposition(
  template: ManagedTemplate,
  composed: ManagedTemplate,
  references: TemplateReference[],
  isAbstract: boolean,
): TemplateCompositionOut {
  return {
    key: template.key,
    version: template.version,
    isAbstract,
    references: references.map(serializeReference),
    composedBodyTemplate: composed.bodyTemplate,
    composedSubjectTemplate: composed.subjectTemplate,
    composedPreheaderTemplate: composed.preheaderTemplate,
  };
}
