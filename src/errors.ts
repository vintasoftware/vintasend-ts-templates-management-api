import type { ApiErrorCode, ApiErrorIssue, ApiErrorResponse, JsonValue } from './contract/types.js';

/**
 * Several codes deliberately share a status.
 *
 * `INVALID_STATUS_TRANSITION` is a 409 that says specifically *why* a status change was refused,
 * which a UI branches on to explain the lifecycle rather than showing a bare "conflict".
 * `TEMPLATE_COMPOSITION_ERROR` is a 409 for the same reason `PREVIEW_UNAVAILABLE` is: the request
 * was well formed and the stored template is what cannot be assembled — a missing base, a loop, a
 * malformed tag — which is a fact about the template the caller asked about, and the message says
 * which.
 *
 * `FORBIDDEN` is what an authenticator answers when it knows who the caller is and refuses them. A
 * 401 there would tell a signed-in user to sign in again.
 */
const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATUS_TRANSITION: 409,
  PREVIEW_UNAVAILABLE: 409,
  TEMPLATE_COMPOSITION_ERROR: 409,
  INTERNAL_ERROR: 500,
};

/**
 * Error carrying an API error code, which the error handler turns into the documented status code
 * and error envelope.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;

  readonly status: number;

  readonly details?: JsonValue;

  constructor(code: ApiErrorCode, message: string, details?: JsonValue) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  /**
   * A 400, which always carries `details.issues`.
   *
   * Every invalid input answers in the same shape, so a client reads one list whatever it got
   * wrong. A failure that is not about one field is a single issue with an empty path repeating
   * the message. `context` adds keys next to `issues`.
   */
  static badRequest(
    message: string,
    issues: ApiErrorIssue[] = [{ path: '', message }],
    context: { [key: string]: JsonValue } = {},
  ): ApiError {
    return new ApiError('BAD_REQUEST', message, { ...context, issues });
  }

  static unauthorized(message: string): ApiError {
    return new ApiError('UNAUTHORIZED', message);
  }

  static forbidden(message: string): ApiError {
    return new ApiError('FORBIDDEN', message);
  }

  static notFound(message: string): ApiError {
    return new ApiError('NOT_FOUND', message);
  }

  static conflict(message: string): ApiError {
    return new ApiError('CONFLICT', message);
  }

  static invalidTransition(message: string): ApiError {
    return new ApiError('INVALID_STATUS_TRANSITION', message);
  }

  static previewUnavailable(message: string): ApiError {
    return new ApiError('PREVIEW_UNAVAILABLE', message);
  }

  static compositionError(message: string): ApiError {
    return new ApiError('TEMPLATE_COMPOSITION_ERROR', message);
  }

  toResponseBody(): ApiErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/**
 * The 400 for input that failed validation, wherever in the request it was: a body field, a query
 * or path parameter, or the body as a whole (an empty path).
 */
export function invalidRequest(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): ApiError {
  return ApiError.badRequest(
    'Invalid request.',
    issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
  );
}

/**
 * The contract error `error` stands for, or `undefined` when it is not one.
 *
 * An `ApiError` from this package is one. So is an error shaped like one — named `ApiError`,
 * carrying a code this contract defines — because an `ApiError` class from another copy of this
 * package, or from the other VintaSend API package, is not this class. That is the ordinary case
 * for a host passing one `authenticate` to both APIs: whichever package it imported `ApiError`
 * from, the other one sees a stranger, and an `instanceof` check would answer its 401 with a 500.
 */
export function asApiError(error: unknown): ApiError | undefined {
  if (error instanceof ApiError) {
    return error;
  }
  if (!(error instanceof Error) || error.name !== 'ApiError') {
    return undefined;
  }
  const { code, details } = error as Error & { code?: unknown; details?: JsonValue };
  if (typeof code !== 'string' || !Object.hasOwn(STATUS_BY_CODE, code)) {
    return undefined;
  }
  return new ApiError(code as ApiErrorCode, error.message, details);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The 404 body for a template the store does not have. */
export function describeMissing(templateKey: string, version: number | null): string {
  if (version === null) {
    return `No template with key '${templateKey}' was found.`;
  }
  return `Template '${templateKey}' has no version ${version}.`;
}
