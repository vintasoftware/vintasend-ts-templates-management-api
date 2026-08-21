import type { ApiErrorCode, ApiErrorResponse, JsonValue } from './contract/types.js';

/**
 * Several codes deliberately share a status.
 *
 * `INVALID_STATUS_TRANSITION` is a 409 that says specifically *why* a status change was refused,
 * which a UI branches on to explain the lifecycle rather than showing a bare "conflict".
 * `TEMPLATE_COMPOSITION_ERROR` is a 409 for the same reason `PREVIEW_UNAVAILABLE` is: the request
 * was well formed and the stored template is what cannot be assembled — a missing base, a loop, a
 * malformed tag — which is a fact about the template the caller asked about, and the message says
 * which.
 */
const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
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

  static badRequest(message: string, details?: JsonValue): ApiError {
    return new ApiError('BAD_REQUEST', message, details);
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
