import { setTimeout as sleep } from 'node:timers/promises';
import { ExchangeApiError } from './errors.mjs';

const MAX_RETRY_AFTER_MS = 10_000;

export async function fetchJson(url, {
  method = 'GET',
  headers = {},
  body,
  attempts = 3,
  timeoutMs = 15_000,
  retryDelayMs = 300,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError('attempts must be an integer >= 1');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('timeoutMs must be a positive integer');
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new RangeError('retryDelayMs must be finite and >= 0');
  }

  const target = url instanceof URL ? url : new URL(url);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let failure;
    try {
      const response = await fetchImpl(target, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        try {
          await response.body?.cancel();
        } catch {
          // Preserve the HTTP error even if the response body cannot be cancelled.
        }
        throw new ExchangeApiError(`HTTP ${response.status} ${response.statusText}`.trim(), {
          status: response.status,
          retryable: [408, 425, 429].includes(response.status) || response.status >= 500,
          retryAfterMs,
        });
      }

      try {
        return JSON.parse(await response.text());
      } catch (cause) {
        throw new ExchangeApiError('Response is not valid JSON', {
          code: 'INVALID_JSON', retryable: true, cause,
        });
      }
    } catch (cause) {
      failure = cause instanceof ExchangeApiError
        ? cause
        : new ExchangeApiError(cause?.message ?? String(cause), {
          code: cause?.cause?.code ?? cause?.code,
          retryable: true,
          cause,
        });
      if (!failure.retryable || attempt === attempts) throw failure;
    }

    const backoff = retryDelayMs * 2 ** (attempt - 1);
    const delay = failure.retryAfterMs == null
      ? backoff
      : Math.min(failure.retryAfterMs, MAX_RETRY_AFTER_MS);
    const jitter = Math.floor(Math.random() * Math.min(200, delay));
    await sleepImpl(delay + jitter);
  }
}

function parseRetryAfter(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
