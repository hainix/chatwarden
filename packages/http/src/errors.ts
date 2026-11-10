import {
  AuditQueryError,
  ExcerptError,
  ProfileError,
  ReportQueryError,
  RulesError,
  safeWarn,
  SanctionError,
} from '@chatwarden/core';
import type { Logger } from '@chatwarden/core';
import type { KitResponse } from './types.js';

/** Every error the API answers with, by code. The status and the message are fixed per code and never echo input. */
const TABLE = {
  invalid_request: { status: 400, message: 'The request is not valid.' },
  invalid_json: { status: 400, message: 'The request body is not valid JSON.' },
  forbidden_key: { status: 400, message: 'The request body contains a key that is not allowed.' },
  invalid_query: { status: 400, message: 'The query is not valid.' },
  invalid_value: { status: 400, message: 'A value is out of range.' },
  invalid_profile: { status: 400, message: 'The moderation profile is not valid.' },
  invalid_sanction: { status: 400, message: 'The sanction is not valid.' },
  invalid_rules: { status: 400, message: 'The rules are not valid.' },
  invalid_excerpt: { status: 400, message: 'The excerpt is not valid.' },
  invalid_term: { status: 400, message: 'The term change was refused.' },
  invalid_gap_ref: { status: 400, message: 'The rule reference for this gap is not valid.' },
  invalid_idempotency_key: { status: 400, message: 'The idempotency key is missing or not valid.' },
  unauthorized: { status: 401, message: 'Authentication is required.' },
  forbidden: { status: 403, message: 'You do not have permission to do this.' },
  not_found: { status: 404, message: 'Not found.' },
  method_not_allowed: { status: 405, message: 'Method not allowed.' },
  already_decided: { status: 409, message: 'The report has already been decided.' },
  in_progress: { status: 409, message: 'A request with this idempotency key is still being processed.' },
  idempotency_mismatch: { status: 409, message: 'This idempotency key was used with a different request.' },
  payload_too_large: { status: 413, message: 'The request body is too large.' },
  rate_limited: { status: 429, message: 'Too many requests. Try again later.' },
} as const;

export type ErrorCode = keyof typeof TABLE;

/** An error with a fixed status, code and message. Handlers throw these; {@link withErrors} turns them into responses. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  /** Response headers to send with the error. A `method_not_allowed` always carries `allow` (empty when none given). */
  readonly headers: Readonly<Record<string, string>> | undefined;
  constructor(code: ErrorCode, headers?: Record<string, string>) {
    super(TABLE[code].message);
    this.name = 'HttpError';
    this.code = code;
    this.status = TABLE[code].status;
    this.headers = headers === undefined ? undefined : { ...headers };
  }
}

/** The request is well formed but its content is not acceptable. 400 `invalid_request`. */
export class ValidationError extends HttpError {
  constructor() {
    super('invalid_request');
    this.name = 'ValidationError';
  }
}

/** The id the request names does not exist. 404 `not_found`. */
export class NotFoundError extends HttpError {
  constructor() {
    super('not_found');
    this.name = 'NotFoundError';
  }
}

/** The fixed response for a code. */
export function errorResponse(code: ErrorCode, headers?: Record<string, string>): KitResponse {
  const { status, message } = TABLE[code];
  const res: KitResponse = { status, body: { error: code, message } };
  // A 405 must carry `allow` (RFC 9110); an empty one means "no method is allowed here".
  if (code === 'method_not_allowed') res.headers = { allow: '', ...headers };
  else if (headers !== undefined) res.headers = { ...headers };
  return res;
}

const codeFor = (err: unknown): ErrorCode | null => {
  if (err instanceof HttpError) return err.code;
  if (err instanceof ReportQueryError || err instanceof AuditQueryError) return 'invalid_query';
  if (err instanceof ProfileError) return 'invalid_profile';
  if (err instanceof SanctionError) return 'invalid_sanction';
  if (err instanceof RulesError) return 'invalid_rules';
  if (err instanceof ExcerptError) return 'invalid_excerpt';
  if (err instanceof RangeError) return 'invalid_value';
  return null;
};

/**
 * Wrap a handler so that nothing it throws (or rejects with) escapes:
 * - a validation-type error (`ReportQueryError`, `AuditQueryError`, `RangeError`, `ProfileError`, `SanctionError`,
 *   `RulesError`, `ExcerptError`, `ValidationError`) -> 400
 * - `NotFoundError` -> 404; `HttpError` -> its own status and headers (401, 403, 413, ...); a `RangeError` is
 *   also logged, class only
 * - anything else -> 500 `{ error: 'internal' }`, logged with the error class only.
 * The body is always `{ error: <code>, message: <fixed text> }`; no input and no error message is echoed.
 */
export function withErrors<A extends unknown[]>(
  handler: (...args: A) => KitResponse | Promise<KitResponse>,
  logger?: Logger,
): (...args: A) => Promise<KitResponse> {
  return async (...args: A): Promise<KitResponse> => {
    try {
      return await handler(...args);
    } catch (err) {
      const code = codeFor(err);
      if (err instanceof HttpError) return errorResponse(err.code, err.headers === undefined ? undefined : { ...err.headers });
      if (code !== null) {
        // A RangeError is a 400 by contract, but an engine RangeError (stack overflow, invalid array length) looks the
        // same; log the class (never the message) so the two can be told apart.
        if (err instanceof RangeError) safeWarn(logger, 'chatwarden.http_range_error', { error: err.name });
        return errorResponse(code);
      }
      safeWarn(logger, 'chatwarden.http_error', { error: err instanceof Error ? err.name : typeof err });
      return { status: 500, body: { error: 'internal' } };
    }
  };
}
