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

function parseBodyResponse(text) {
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
    throw new GoldApiError(
      `API ${body.code ?? 'unknown'}: ${body.msg ?? body.responseMsg ?? 'API reported failure'}`,
      { code: body.code },
    );
  }

  return body;
}

function buildFormBody(params) {
  // 招行模块接口要求单键 params=<整个 JSON> 的表单编码。
  const body = new URLSearchParams();
  body.set('params', JSON.stringify(params));
  return body;
}

export async function fetchJson(url, {
  headers = {},
  attempts = 3,
  timeoutMs = 15_000,
  retryDelayMs = 300,
} = {}) {
  return requestWithRetry(url, {
    method: 'GET',
    headers,
    attempts,
    timeoutMs,
    retryDelayMs,
  });
}

export async function postForm(url, params, {
  headers = {},
  attempts = 3,
  timeoutMs = 15_000,
  retryDelayMs = 300,
} = {}) {
  return requestWithRetry(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: buildFormBody(params),
    attempts,
    timeoutMs,
    retryDelayMs,
  });
}

export async function postJson(url, payload, {
  headers = {},
  attempts = 3,
  timeoutMs = 15_000,
  retryDelayMs = 300,
} = {}) {
  return requestWithRetry(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    attempts,
    timeoutMs,
    retryDelayMs,
  });
}

async function requestWithRetry(url, {
  method,
  headers,
  body,
  attempts,
  timeoutMs,
  retryDelayMs,
}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError('attempts must be an integer >= 1');
  }

  const target = url instanceof URL ? url : new URL(url);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(target, {
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
          // The body may already be unusable; the status is what matters.
        }

        throw new GoldApiError(`HTTP ${response.status} ${response.statusText}`.trim(), {
          retryable: RETRYABLE_STATUS.has(response.status),
          status: response.status,
          retryAfterMs,
        });
      }

      const text = await response.text();
      return parseBodyResponse(text);
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
