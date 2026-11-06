import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { mapLimit } from '../scripts/lib/concurrency.mjs';
import { positiveNumber, round, summarize } from '../scripts/lib/num.mjs';
import { chinaDate, dateRange, formatChinaTime, fromChinaDateTime, fromCompactDate } from '../scripts/lib/time.mjs';

test('positiveNumber accepts bank numeric strings and correctly grouped thousands', () => {
  assert.equal(positiveNumber(' 668.3651 '), 668.3651);
  assert.equal(positiveNumber('1,234.5678'), 1234.5678);
  assert.equal(positiveNumber(4.2427), 4.2427);
  for (const value of [null, undefined, '', ' ', '1,23', '6,6,5', 'NaN', 'Infinity', '1e3', '-1', 0, -1, NaN, Infinity, true, {}, []]) {
    assert.equal(positiveNumber(value), null, String(value));
  }
});

test('round normalizes negative zero and keeps rate precision', () => {
  assert.equal(round(668.3651 - 665.628), 2.7371);
  assert.equal(round(4.2427 / 100, 6), 0.042427);
  assert.equal(Object.is(round(-0.00001), -0), false);
});

test('each rate summary uses its own valid points', () => {
  const points = [
    { date: '2026-11-01', price: null },
    { date: '2026-11-02', price: 100 },
    { date: '2026-11-03', price: 90 },
    { date: '2026-11-04', price: 110 },
  ];
  assert.deepEqual(summarize(points, 'price'), {
    count: 3, startDate: '2026-11-02', endDate: '2026-11-04',
    firstRate: 100, lastRate: 110, change: 10, changePercent: 10, minRate: 90, maxRate: 110,
  });
  assert.equal(summarize(points, 'missing'), null);
  assert.equal(summarize([], 'price'), null);
});

test('ranges use China dates across UTC midnight and fixed day counts', () => {
  const now = new Date('2026-11-05T16:00:00Z');
  assert.equal(chinaDate(now), '2026-11-06');
  assert.deepEqual(dateRange(30, now), { startDate: '2026-10-07', endDate: '2026-11-06' });
  assert.deepEqual(dateRange(90, now), { startDate: '2026-08-08', endDate: '2026-11-06' });
  assert.deepEqual(dateRange(180, now), { startDate: '2026-05-10', endDate: '2026-11-06' });
  assert.deepEqual(dateRange(365, now), { startDate: '2025-11-06', endDate: '2026-11-06' });
  assert.equal(dateRange(365, new Date('2024-03-01T00:00:00Z')).startDate, '2023-03-02');
  assert.throws(() => dateRange(0), RangeError);
});

test('bank dates are validated and historical dates retain date-only precision', () => {
  assert.equal(fromCompactDate('20240229'), '2024-02-29');
  for (const value of ['20260229', '20261131', '20261301', '2026-11-06', null]) {
    assert.equal(fromCompactDate(value), null);
  }
  assert.equal(fromChinaDateTime('2026-11-06 08:55:26'), '2026-11-06T08:55:26+08:00');
  for (const value of ['2026-02-29 08:00:00', '2026-11-06 24:00:00', '2026-11-06 08:60:00', null]) {
    assert.equal(fromChinaDateTime(value), null);
  }
  assert.equal(formatChinaTime('2026-11-05T16:00:00Z'), '2026-11-06 00:00:00');
  assert.equal(formatChinaTime('2026-11-06T08:55:26+08:00'), '2026-11-06 08:55:26');
  assert.equal(formatChinaTime(null), '--');
});

test('mapLimit preserves task order, captures failures and caps concurrency', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapLimit([0, 1, 2, 3, 4, 5], 3, async item => {
    active += 1;
    peak = Math.max(peak, active);
    await setImmediate();
    active -= 1;
    if (item === 2) throw new Error('test failure');
    return item * 2;
  });
  assert.equal(peak, 3);
  assert.equal(results[2].status, 'rejected');
  assert.equal(results[2].reason.message, 'test failure');
  assert.deepEqual(results.filter(result => result.status === 'fulfilled').map(result => result.value), [0, 2, 6, 8, 10]);
  assert.deepEqual(await mapLimit([], 3, () => assert.fail('unexpected task')), []);
  await assert.rejects(mapLimit([], 0, () => {}), RangeError);
});
