import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { ExchangeApiError, serializeError } from '../scripts/lib/errors.mjs';
import { fetchJson } from '../scripts/lib/http.mjs';

const URL = 'https://bank.example/quotes';

test('fetchJson forwards form POST options and uses an AbortSignal', async () => {
  const body = new URLSearchParams({ ccy: 'USD' });
  const result = await fetchJson(URL, {
    method: 'POST', headers: { accept: 'application/json' }, body,
    fetchImpl: async (url, options) => {
      assert.equal(url.href, URL);
      assert.equal(options.method, 'POST');
      assert.equal(options.body, body);
      assert.deepEqual(options.headers, { accept: 'application/json' });
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ data: { rate: 1 } });
    },
  });
  assert.deepEqual(result, { data: { rate: 1 } });
});

test('transient 503 retries the same form request and then succeeds', async () => {
  let attempts = 0;
  const delays = [];
  const form = new URLSearchParams({ ccy: 'JPY' });
  const result = await fetchJson(URL, {
    method: 'POST', body: form, retryDelayMs: 0,
    sleepImpl: async delay => delays.push(delay),
    fetchImpl: async (_, options) => {
      assert.equal(options.body.toString(), 'ccy=JPY');
      attempts += 1;
      return attempts === 1 ? new Response('', { status: 503 }) : Response.json({ ok: true });
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [0]);
  assert.deepEqual(result, { ok: true });
});

test('429 respects Retry-After with a bounded wait', async () => {
  let attempts = 0;
  const delays = [];
  await fetchJson(URL, {
    sleepImpl: async delay => delays.push(delay),
    fetchImpl: async () => ++attempts === 1
      ? new Response('', { status: 429, headers: { 'retry-after': '3600' } })
      : Response.json({ ok: true }),
  });
  assert.equal(attempts, 2);
  assert.ok(delays[0] >= 10_000 && delays[0] < 10_200);
});

test('ordinary 403 fails immediately with HTTP status retained', async () => {
  let attempts = 0;
  await assert.rejects(fetchJson(URL, {
    sleepImpl: () => assert.fail('403 must not retry'),
    fetchImpl: async () => { attempts += 1; return new Response('', { status: 403 }); },
  }), error => error instanceof ExchangeApiError && error.status === 403 && error.retryable === false);
  assert.equal(attempts, 1);
});

test('network failures retry at most three times and retain the cause code', async () => {
  let attempts = 0;
  await assert.rejects(fetchJson(URL, {
    retryDelayMs: 0, sleepImpl: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) });
    },
  }), error => error.code === 'ECONNRESET' && error.retryable && error.cause instanceof TypeError);
  assert.equal(attempts, 3);
});

test('non-JSON responses produce a structured failure after bounded retries', async () => {
  let attempts = 0;
  await assert.rejects(fetchJson(URL, {
    retryDelayMs: 0, sleepImpl: async () => {},
    fetchImpl: async () => { attempts += 1; return new Response('<html>maintenance</html>'); },
  }), error => error.code === 'INVALID_JSON' && error.retryable === true);
  assert.equal(attempts, 3);
});

test('request timeout aborts the fetch and is retryable', async () => {
  await assert.rejects(fetchJson(URL, {
    attempts: 1, timeoutMs: 1,
    fetchImpl: async (_, { signal }) => {
      await sleep(5);
      signal.throwIfAborted();
      assert.fail('timeout did not abort');
    },
  }), error => error.retryable === true && error.cause.name === 'TimeoutError');
});

test('invalid retry settings are rejected before any request', async () => {
  for (const options of [{ attempts: 0 }, { attempts: 1.5 }, { timeoutMs: 0 }, { retryDelayMs: -1 }]) {
    await assert.rejects(fetchJson(URL, { ...options, fetchImpl: () => assert.fail('unexpected request') }), RangeError);
  }
});

test('error serialization keeps scope and safe diagnostic fields', () => {
  const error = new ExchangeApiError('HTTP 503', { status: 503, code: 'UNAVAILABLE', retryable: true });
  assert.deepEqual(serializeError(error, 'history.USD.1m'), {
    message: 'HTTP 503', scope: 'history.USD.1m', code: 'UNAVAILABLE', httpStatus: 503, retryable: true,
  });
  assert.deepEqual(serializeError('failure'), { message: 'failure' });
});
