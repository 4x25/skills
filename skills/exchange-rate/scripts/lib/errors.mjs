export class ExchangeApiError extends Error {
  constructor(message, { code, status, retryable = false, retryAfterMs, cause } = {}) {
    super(message, { cause });
    this.name = 'ExchangeApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export function serializeError(error, scope) {
  const result = { message: error?.message ?? String(error) };
  if (scope) result.scope = scope;
  if (error?.code != null) result.code = error.code;
  if (error?.status != null) result.httpStatus = error.status;
  if (error?.retryable != null) result.retryable = error.retryable;
  return result;
}
