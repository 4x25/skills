import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { ALL_RANGES, CURRENCIES, createClient, normalizeCurrent, normalizeTrend } from '../scripts/banks/pingan.mjs';
import { ExchangeApiError } from '../scripts/lib/errors.mjs';

const UPDATE = '2026-11-06 08:55:26';
const currentBody = () => ({
  responseCode: '000000',
  data: {
    updateTime: UPDATE,
    settleList: [
      { ccy: 'USD', ccyName: '美元', sellingRate: '668.3651', buyingRate: '665.6280' },
      { ccy: 'JPY', ccyName: '日元', sellingRate: '4.2427', buyingRate: '4.2162' },
    ],
  },
});
const historyBody = (currency = 'USD') => ({
  responseCode: '000000',
  data: {
    updateTime: UPDATE,
    currentBuyingRate: '9999',
    currentSellingRate: '10000',
    rateList: [
      { ccy: currency, exchangeDate: '20261105', sellingRate: '668.3651', buyingRate: '665.6280', middleRate: '666.8050' },
      { ccy: currency, exchangeDate: '20261007', sellingRate: '673.5416', buyingRate: '668.5101', middleRate: '670.6100' },
    ],
  },
});
const RANGE = { currency: 'USD', range: '1m', startDate: '2026-10-07', endDate: '2026-11-06' };

test('current quote directions are customer purchase and settlement, including JPY per-100 units', () => {
  const result = normalizeCurrent(currentBody(), { currencies: ['USD', 'JPY'] });
  assert.equal(result.updateTime, '2026-11-06T08:55:26+08:00');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.errors, []);
  const [usd, jpy] = result.quotes;
  assert.equal(usd.purchaseRate, 668.3651);
  assert.equal(usd.settlementRate, 665.628);
  assert.equal(usd.spread, 2.7371);
  assert.equal(jpy.purchaseRate, 4.2427);
  assert.equal(jpy.purchasePerUnit, 0.042427);
  assert.equal(jpy.settlementPerUnit, 0.042162);
  assert.equal(Number((10_000 * jpy.purchaseRate / 100).toFixed(2)), 424.27);
  assert.equal(Number((10_000 * jpy.settlementRate / 100).toFixed(2)), 421.62);
});

test('current selection filters locally and reports missing currencies', () => {
  const result = normalizeCurrent(currentBody(), { currencies: ['JPY', 'EUR'] });
  assert.deepEqual(result.quotes.map(quote => quote.currency), ['JPY']);
  assert.ok(result.warnings.some(warning => warning.scope === 'current.EUR' && warning.code === 'MISSING_CURRENCY'));
});

test('default all-currency query diagnoses a missing known currency without discarding nine quotes', () => {
  const body = currentBody();
  body.data.settleList = Object.entries(CURRENCIES).filter(([currency]) => currency !== 'JPY')
    .map(([currency, definition]) => ({ ccy: currency, ccyName: definition.name, sellingRate: '2', buyingRate: '1' }));
  const result = normalizeCurrent(body);
  assert.equal(result.quotes.length, 9);
  assert.deepEqual(result.warnings, [{ scope: 'current.JPY', message: '未返回该币种的有效报价', code: 'MISSING_CURRENCY' }]);
});

test('selected quotes are unaffected by invalid rates for an unselected currency', () => {
  const body = currentBody();
  body.data.settleList[0].sellingRate = null;
  const result = normalizeCurrent(body, { currencies: ['JPY'] });
  assert.equal(result.quotes.length, 1);
  assert.deepEqual(result.warnings, []);
});

test('a one-sided current quote remains useful but carries a warning', () => {
  const body = currentBody();
  body.data.settleList[1].sellingRate = '0';
  const result = normalizeCurrent(body, { currencies: ['JPY'] });
  assert.equal(result.quotes[0].purchaseRate, null);
  assert.equal(result.quotes[0].purchasePerUnit, null);
  assert.equal(result.quotes[0].settlementRate, 4.2162);
  assert.equal(result.quotes[0].spread, null);
  assert.ok(result.warnings.some(warning => warning.code === 'INVALID_RATE'));
});

test('missing bank update time stays null instead of being replaced with fetch time', () => {
  const body = currentBody();
  delete body.data.updateTime;
  const result = normalizeCurrent(body);
  assert.equal(result.updateTime, null);
  assert.ok(result.warnings.some(warning => warning.code === 'INVALID_UPDATE_TIME'));
});

test('invalid and duplicate current rows are diagnosed without losing valid quotes', () => {
  const body = currentBody();
  body.data.settleList.push(null, { ccy: 'bad' }, { ...body.data.settleList[0], sellingRate: '100' });
  const result = normalizeCurrent(body);
  assert.equal(result.quotes.length, 2);
  assert.equal(result.quotes[0].purchaseRate, 668.3651);
  assert.ok(result.warnings.some(warning => warning.code === 'INVALID_CURRENCY'));
  assert.ok(result.warnings.some(warning => warning.code === 'DUPLICATE_CURRENCY'));
  assert.ok(result.warnings.some(warning => warning.code === 'INVERTED_SPREAD'));
});

test('history sorts dates and preserves all three independently returned rate series', () => {
  const result = normalizeTrend(historyBody(), RANGE);
  assert.deepEqual(result.points.map(point => point.date), ['2026-10-07', '2026-11-05']);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.basis, 'daily');
  assert.equal(result.points.at(-1).middleRate, 666.805);
  assert.notEqual(result.points.at(-1).middleRate, (665.628 + 668.3651) / 2);
  assert.equal(result.summary.purchase.firstRate, 673.5416);
  assert.equal(result.summary.purchase.lastRate, 668.3651);
  assert.equal(result.summary.settlement.firstRate, 668.5101);
  assert.equal(result.summary.settlement.lastRate, 665.628);
  assert.equal(result.summary.middle.firstRate, 670.61);
  assert.equal(result.summary.middle.lastRate, 666.805);
  assert.equal(result.summary.middle.change, -3.805);
  assert.equal(result.summary.middle.changePercent, Number(((666.805 / 670.61 - 1) * 100).toFixed(4)));
  assert.equal(Object.hasOwn(result, 'currentBuyingRate'), false);
});

test('weekend repeated rates remain separate historical dates', () => {
  const body = historyBody();
  const point = body.data.rateList[0];
  body.data.rateList = [{ ...point, exchangeDate: '20261101' }, { ...point, exchangeDate: '20261031' }];
  const result = normalizeTrend(body, RANGE);
  assert.equal(result.points.length, 2);
  assert.equal(result.summary.middle.change, 0);
  assert.deepEqual(result.points.map(point => point.date), ['2026-10-31', '2026-11-01']);
});

test('invalid, mismatched, out-of-range and duplicate history records carry warnings', () => {
  const body = historyBody();
  const point = body.data.rateList[0];
  body.data.rateList.push(
    null,
    { ...point, ccy: 'JPY' },
    { ...point, exchangeDate: '20260229' },
    { ...point, exchangeDate: '20261006' },
    { ...point, exchangeDate: '20261107' },
    { ...point },
  );
  const result = normalizeTrend(body, RANGE);
  assert.equal(result.points.length, 2);
  assert.ok(result.warnings.some(warning => warning.code === 'INVALID_POINT'));
  assert.ok(result.warnings.some(warning => warning.code === 'DUPLICATE_DATE'));
});

test('missing historical rate fields are null and summaries skip only that series point', () => {
  const body = historyBody();
  body.data.rateList[0].buyingRate = '';
  const result = normalizeTrend(body, RANGE);
  assert.equal(result.points.at(-1).settlementRate, null);
  assert.equal(result.summary.purchase.count, 2);
  assert.equal(result.summary.settlement.count, 1);
  assert.equal(result.summary.middle.count, 2);
  assert.ok(result.warnings.some(warning => warning.code === 'INVALID_RATE'));
});

test('empty historical lists have explicit warnings and null summaries', () => {
  const body = historyBody();
  body.data.rateList = [];
  const result = normalizeTrend(body, RANGE);
  assert.deepEqual(result.points, []);
  assert.deepEqual(result.summary, { purchase: null, settlement: null, middle: null });
  assert.ok(result.warnings.some(warning => warning.code === 'EMPTY_HISTORY'));
});

test('missing list schemas fail with INVALID_PAYLOAD', () => {
  assert.throws(() => normalizeCurrent({ data: {} }), error => error.code === 'INVALID_PAYLOAD');
  assert.throws(() => normalizeTrend({ data: { rateList: null } }, RANGE), error => error.code === 'INVALID_PAYLOAD');
});

test('client uses GET for current and form POST with the captured day ranges for history', async () => {
  const calls = [];
  const client = createClient({ request: async (url, options) => {
    calls.push({ url, options });
    return options.body ? historyBody(options.body.get('ccy')) : currentBody();
  } });
  await client.getCurrent({ currencies: ['USD'] });
  await client.getHistory({ currencies: ['USD'], ranges: ALL_RANGES, now: new Date('2026-11-05T16:00:00Z') });
  assert.equal(calls[0].url.pathname.endsWith('/qryExchangePriceList.do'), true);
  assert.equal(calls[0].options.method ?? 'GET', 'GET');
  assert.equal(calls[0].url.search, '');
  assert.equal(calls[0].options.headers.accept, 'application/json');
  assert.equal(Object.hasOwn(calls[0].options.headers, 'cookie'), false);
  assert.equal(Object.hasOwn(calls[0].options.headers, 'referer'), false);
  assert.deepEqual(calls.slice(1).map(({ options }) => Object.fromEntries(options.body)), [
    { ccy: 'USD', startDate: '2026-10-07', endDate: '2026-11-06' },
    { ccy: 'USD', startDate: '2026-08-08', endDate: '2026-11-06' },
    { ccy: 'USD', startDate: '2026-05-10', endDate: '2026-11-06' },
    { ccy: 'USD', startDate: '2025-11-06', endDate: '2026-11-06' },
  ]);
  assert.ok(calls.slice(1).every(({ url, options }) => url.pathname.endsWith('/qryExchangeHisPriceDetail.do') && options.method === 'POST'));
});

test('one failed currency/range does not discard seven successful ranges; peak concurrency is three', async () => {
  let active = 0;
  let peak = 0;
  const client = createClient({ request: async (_, { body }) => {
    active += 1;
    peak = Math.max(peak, active);
    await setImmediate();
    active -= 1;
    if (body.get('ccy') === 'USD' && body.get('startDate') === '2026-08-08') {
      throw new ExchangeApiError('temporary failure', { status: 503, retryable: true });
    }
    return historyBody(body.get('ccy'));
  } });
  const history = await client.getHistory({ currencies: ['USD', 'JPY'], now: new Date('2026-11-06T00:00:00Z') });
  assert.equal(peak, 3);
  assert.equal(Object.keys(history.trends.USD).length, 3);
  assert.equal(Object.keys(history.trends.JPY).length, 4);
  assert.deepEqual(history.errors, [{ scope: 'history.USD.3m', message: 'temporary failure', httpStatus: 503, retryable: true }]);
});

test('business failure and missing success codes are rejected without inventing data', async () => {
  for (const body of [{ responseCode: '000001', responseMsg: 'failed' }, { data: currentBody().data }, { responseCode: '000000', success: false }]) {
    let calls = 0;
    const client = createClient({ request: async () => { calls += 1; return body; } });
    await assert.rejects(client.getCurrent(), error => error instanceof ExchangeApiError && !error.retryable);
    assert.equal(calls, 1);
  }
});

test('invalid library currency/range arguments fail before requests', async () => {
  const client = createClient({ request: () => assert.fail('unexpected request') });
  for (const options of [{}, { currencies: [] }, { currencies: ['RUB'] }, { currencies: ['USD'], ranges: [] }, { currencies: ['USD'], ranges: ['realtime'] }]) {
    await assert.rejects(client.getHistory(options), error => error.code === 'INVALID_ARGUMENT');
  }
  await assert.rejects(client.getCurrent({ currencies: ['RUB'] }), error => error.code === 'INVALID_ARGUMENT');
});
