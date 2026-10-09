/**
 * Renders one version of a template against a caller-supplied context.
 *
 * This is the endpoint's reason to exist. A managed renderer's own `render` is the send path: it
 * resolves an unpinned key to the newest *active* version, so it never shows an unpublished draft
 * — and for a key with nothing published it may render an application's registered fallback
 * instead of anything stored. `ManagedTemplateService.renderTemplate` takes the template as an
 * argument and never falls back, so fetching an explicit version first is what makes previewing a
 * draft — before anyone activates it — possible.
 *
 * Two things this module has to supply that a real send would already have.
 *
 * **A notification.** The renderer seam is defined in terms of a notification, and a preview has
 * none: nothing is being sent. So one is fabricated. Only its template fields carry meaning, and
 * even those are ignored by the call this makes — `renderTemplate` drives the renderer from the
 * `ManagedTemplate` — so the fabricated notification's own templates are never looked up. It
 * exists to satisfy the signature and to give a renderer that reads non-template fields something
 * well-formed and empty to read.
 *
 * **A context.** `renderTemplate` takes a materialised context and generates none, and this API
 * has no notification to resolve a registered context generator from. So the caller's `context` is
 * rendered verbatim — which is also what a preview is for: seeing what a given context produces.
 */

import type { JsonObject } from 'vintasend';
import type { ManagedTemplate } from 'vintasend-managed-templates';

import type { TemplatePreviewOut } from '../contract/types.js';
import { ApiError, errorMessage } from '../errors.js';
import type { ServiceCaller } from './service-caller.js';

/**
 * Marks the notification below as the fabrication it is, so a renderer that logs or annotates what
 * it rendered does not report a preview as a real notification.
 */
export const PREVIEW_CONTEXT_NAME = 'vintasend-templates-management-api.preview';

/**
 * A well-formed, empty notification standing in for the one a real send would have.
 *
 * `id` is a fresh UUID rather than a fixed sentinel so two concurrent previews are
 * distinguishable in a renderer's logs. Its status is `PENDING_SEND`: the notification was never
 * sent, and claiming otherwise would be the one field a renderer might reasonably branch on.
 */
export function buildPreviewNotification(template: ManagedTemplate): never {
  return {
    id: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    notificationType: 'EMAIL',
    title: template.name,
    bodyTemplate: template.key,
    contextName: PREVIEW_CONTEXT_NAME,
    contextParameters: {},
    contextUsed: null,
    sendAfter: null,
    subjectTemplate: template.subjectTemplate ?? '',
    status: 'PENDING_SEND',
    extraParams: null,
    tenant: template.tenant,
    adapterUsed: null,
    sentAt: null,
    readAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    gitCommitSha: null,
  } as never;
}

function optionalString(rendered: Record<string, unknown>, key: string): string | null {
  const value = rendered[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Render `template` with `context` and shape the result for the wire.
 *
 * Composed first, through the service caller, so the two ways a template can be broken come back
 * under different codes: one that cannot be composed is a `TEMPLATE_COMPOSITION_ERROR` (409),
 * exactly as `GET /composition` reports it. Composing reads the store, and a store failure there is
 * not translated: it is a 500, so a backend's message never reaches the client.
 *
 * A rendering failure is reported as `PREVIEW_UNAVAILABLE` (409) rather than a 500: a template
 * that does not compile, or a context missing a variable the template needs, is a fact about the
 * *template being previewed*, which is exactly what the caller asked to find out. Letting it fall
 * through as an internal error would hide the message that makes the draft fixable. Only the render
 * is caught, so nothing else is reported that way.
 */
export async function buildTemplatePreview(
  service: ServiceCaller,
  template: ManagedTemplate,
  context: JsonObject,
): Promise<TemplatePreviewOut> {
  const composed = await service.composeTemplate(template);
  let result: { version: number; rendered: unknown };

  try {
    result = await service.renderTemplate(buildPreviewNotification(template), composed, context);
  } catch (error) {
    throw ApiError.previewUnavailable(
      `Template '${template.key}' v${template.version} could not be rendered: ` +
        errorMessage(error),
    );
  }

  const rendered =
    result.rendered !== null && typeof result.rendered === 'object'
      ? (result.rendered as Record<string, unknown>)
      : {};

  // An email renderer produces `body`; a text renderer produces `text`. Both are "the thing there
  // is to look at", so both are accepted rather than only the one the email path happens to use.
  const body = optionalString(rendered, 'body') ?? optionalString(rendered, 'text');

  if (body === null) {
    throw ApiError.previewUnavailable(
      'The configured template renderer produced a result with no text body, so there is ' +
        'nothing to preview.',
    );
  }

  return {
    key: template.key,
    version: result.version,
    renderedBody: body,
    // Absent on renderers that do not produce them: an SMS renderer has no subject, and a
    // preheader is a concept many renderers skip.
    renderedSubject: optionalString(rendered, 'subject'),
    renderedPreheader: optionalString(rendered, 'preheader'),
  };
}
