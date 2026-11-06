import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { loadResult, parseOptions } from '../scripts/exchange-rate.mjs';
import { RANGES } from '../scripts/banks/pingan.mjs';
import { dateRange } from '../scripts/lib/time.mjs';

test('live Ping An: all ten current quotes and all forty currency/range histories', {
  skip: process.env.FX_LIVE_TEST !== '1',
  timeout: 180_000,
}, async t => {
  const options = parseOptions(['pingan', 'all', '--currency', 'all', '--json']);
  const now = new Date();
  const result = await loadResult({ ...options, now });
  if (process.env.FX_LIVE_OUTPUT) {
    await writeFile(process.env.FX_LIVE_OUTPUT, JSON.stringify(result, null, 2) + '\n');
  }
  assert.equal(result.status, 'ok', JSON.stringify({ current: result.current?.errors, history: result.history?.errors, warnings: result.history?.warnings }));
  assert.equal(result.baseAmount, 100);
  assert.equal(result.quoteCurrency, 'CNY');
  assert.match(result.current.updateTime, /\+08:00$/);
  assert.deepEqual(result.current.quotes.map(quote => quote.currency).toSorted(), options.currencies.toSorted());
  for (const quote of result.current.quotes) {
    assert.ok(quote.purchaseRate > 0 && quote.settlementRate > 0, quote.currency);
    assert.ok(Math.abs(quote.purchasePerUnit - quote.purchaseRate / 100) < 1e-10);
    assert.ok(Math.abs(quote.settlementPerUnit - quote.settlementRate / 100) < 1e-10);
  }

  let series = 0;
  for (const currency of options.currencies) {
    assert.deepEqual(Object.keys(result.history.trends[currency]), options.ranges);
    for (const range of options.ranges) {
      const trend = result.history.trends[currency][range];
      assert.equal(trend.currency, currency);
      assert.equal(trend.basis, 'daily');
      const dates = dateRange(RANGES[range].days, now);
      assert.equal(trend.startDate, dates.startDate);
      assert.equal(trend.endDate, dates.endDate);
      assert.ok(trend.points.length > 0, `${currency}/${range} empty`);
      assert.match(trend.updateTime, /\+08:00$/);
      trend.points.forEach((point, index) => {
        assert.ok(point.date >= trend.startDate && point.date <= trend.endDate);
        if (index) assert.ok(trend.points[index - 1].date < point.date);
        assert.ok(point.purchaseRate > 0 && point.settlementRate > 0 && point.middleRate > 0);
      });
      for (const [key, field] of [['purchase', 'purchaseRate'], ['settlement', 'settlementRate'], ['middle', 'middleRate']]) {
        assert.equal(trend.summary[key].count, trend.points.length);
        assert.equal(trend.summary[key].firstRate, trend.points[0][field]);
        assert.equal(trend.summary[key].lastRate, trend.points.at(-1)[field]);
      }
      series += 1;
    }
  }
  assert.equal(series, 40);
  t.diagnostic(`Validated ${result.current.quotes.length} currencies and ${series} histories, fetched at ${result.fetchedAt}`);
});
