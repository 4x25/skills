import https from 'node:https';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { GoldApiError } from './http.mjs';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const LEGACY_HOST = 'mywap2.icbc.com.cn';

// ICBC's mwap2 endpoint requires legacy server connect support. Scope this flag
// to this host and request helper instead of changing TLS behavior globally.
const SECURE_OPTIONS = crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT;

export async function postJson(url, payload, {
  headers = {},
  attempts = 3,
  timeoutMs = 15_000,
  retryDelayMs = 300,
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError('attempts must be an integer >= 1');
  }

  const target = url instanceof URL ? url : new URL(url);
  if (target.hostname !== LEGACY_HOST) {
    throw new RangeError(`legacy TLS helper only supports ${LEGACY_HOST}`);
  }

  const body = JSON.stringify(payload);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestOnce(target, body, headers, timeoutMs);
    } catch (error) {
      const apiError = error instanceof GoldApiError
        ? error
        : new GoldApiError(error?.message ?? String(error), {
          retryable: isRetryableNetworkError(error),
          code: error?.code,
        });

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

function requestOnce(target, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(timeoutMs);
    const request = https.request(target, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...headers,
      },
      secureOptions: SECURE_OPTIONS,
      signal,
    }, (response) => {
      const status = response.statusCode ?? 0;

      if (status < 200 || status >= 300) {
        const retryAfterMs = parseRetryAfter(response.headers['retry-after']);
        const location = response.headers.location;
        response.resume();
        reject(new GoldApiError(
          `HTTP ${status}${location ? ` (redirect: ${location})` : ''}`,
          {
            retryable: RETRYABLE_STATUS.has(status),
            status,
            retryAfterMs,
          },
        ));
        return;
      }

      let text = '';
      let bytes = 0;
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy();
          reject(new GoldApiError('Response too large', { retryable: false }));
          return;
        }
        text += chunk;
      });
      response.on('error', (error) => {
        reject(new GoldApiError(error.message, {
          retryable: isRetryableNetworkError(error),
          code: error?.code,
        }));
      });
      response.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          reject(new GoldApiError('Response is not valid JSON', { retryable: true }));
          return;
        }

        if (parsed?.retCode != null && String(parsed.retCode) !== '0') {
          reject(new GoldApiError(`API ${parsed.retCode}: ${parsed.retMsg ?? 'unknown error'}`, {
            code: String(parsed.retCode),
          }));
          return;
        }

        resolve(parsed);
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    request.on('error', (error) => {
      reject(new GoldApiError(error.message, {
        retryable: isRetryableNetworkError(error),
        code: error?.code,
      }));
    });
    request.end(body);
  });
}

function parseRetryAfter(value) {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function isRetryableNetworkError(error) {
  const code = String(error?.code ?? '');
  if (code === 'ENOTFOUND'
    || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
    || code === 'SELF_SIGNED_CERT_IN_CHAIN') return false;
  if (code.startsWith('CERT_') || code.startsWith('ERR_TLS_')) return false;
  return true;
}
