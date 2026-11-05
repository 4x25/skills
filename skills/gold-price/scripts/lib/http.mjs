import { setTimeout as sleep } from 'node:timers/promises';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 10_000;

export class GoldApiError extends Error {
  constructor(message, { retryable = false, code, status, retryAfterMs } = {}) {
    super(message);
    this.name = 'GoldApiError';
    this.retryable = retryable;
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export async function fetchJson(url, {
  headers = {},
  attempts = 3,
  timeoutMs = 15_000,
  retryDelayMs = 300,
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError('attempts must be an integer >= 1');
  }

  const target = url instanceof URL ? url : new URL(url);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(target, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        try {
          await response.body?.cancel();
        } catch {
          // The body may already be unusable; the status is what matters.
        }

        throw new GoldApiError(`HTTP ${response.status} ${response.statusText}`.trim(), {
          retryable: RETRYABLE_STATUS.has(response.status),
          status: response.status,
          retryAfterMs,
        });
      }

      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new GoldApiError('Response is not valid JSON', { retryable: true });
      }

      if (body?.responseCode && body.responseCode !== '000000') {
        throw new GoldApiError(`API ${body.responseCode}: ${body.responseMsg ?? 'unknown error'}`, {
          code: body.responseCode,
        });
      }
      if (body?.success === false) {
        throw new GoldApiError(body.responseMsg ?? 'API reported failure');
      }

      return body;
    } catch (error) {
      const apiError = error instanceof GoldApiError
        ? error
        : new GoldApiError(error?.message ?? String(error), { retryable: true });

      if (!apiError.retryable || attempt === attempts) throw apiError;
      lastError = apiError;
    }

    const backoff = retryDelayMs * 2 ** (attempt - 1);
    const baseDelay = lastError?.retryAfterMs == null
      ? backoff
      : Math.min(lastError.retryAfterMs, MAX_RETRY_AFTER_MS);
    const jitter = Math.floor(Math.random() * Math.min(200, Math.max(1, baseDelay)));
    await sleep(baseDelay + jitter);
  }

  throw lastError ?? new GoldApiError('Request failed');
}

function parseRetryAfter(value) {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}
