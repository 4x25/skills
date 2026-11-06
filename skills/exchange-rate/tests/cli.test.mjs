import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { BANKS, formatHuman, loadResult, parseOptions } from '../scripts/exchange-rate.mjs';
import { CURRENCIES, createClient } from '../scripts/banks/pingan.mjs';
import { ExchangeApiError } from '../scripts/lib/errors.mjs';

const SCRIPT = join(import.meta.dirname, '../scripts/exchange-rate.mjs');
const NOW = new Date('2026-11-05T16:00:00Z');
const current = () => ({
  updateTime: '2026-11-06T08:55:26+08:00',
  quotes: [{ currency: 'JPY', currencyName: '日元', purchaseRate: 4.2427, settlementRate: 4.2162, spread: 0.0265 }],
  warnings: [], errors: [],
});
const history = () => ({
  trends: { JPY: { '1m': {
    currency: 'JPY', currencyName: '日元', label: '近一月', startDate: '2026-10-07', endDate: '2026-11-06',
    points: [{ date: '2026-11-05', purchaseRate: 4.24, settlementRate: 4.21, middleRate: 4.22 }],
    summary: { purchase: null, settlement: null, middle: null },
  } } },
  warnings: [], errors: [],
});
const adapter = overrides => ({
  id: 'test', name: '测试银行', baseAmount: 100, quoteCurrency: 'CNY',
  getCurrent: async () => current(), getHistory: async () => history(), ...overrides,
});

test('default and shorthand CLI select Ping An current without historical requests', () => {
  const options = parseOptions([]);
  assert.equal(options.bank.id, 'pingan');
  assert.equal(options.command, 'current');
  assert.equal(options.currencies, null);
  assert.deepEqual(options.ranges, []);
  assert.equal(parseOptions(['current']).bank.id, 'pingan');
  assert.equal(parseOptions(['pingan']).command, 'current');
});

test('currency codes, Chinese aliases, repeated options and Chinese commas normalize and deduplicate', () => {
  const options = parseOptions(['PINGAN', 'current', '--currency', '美元，jpy', '--currency', 'usd,日元', '--json']);
  assert.deepEqual(options.currencies, ['USD', 'JPY']);
  assert.equal(options.json, true);
  assert.deepEqual(parseOptions(['current', '--currency', '美金,港币,新西兰元,瑞士法郎,新加坡元,加拿大元']).currencies, ['USD', 'HKD', 'NZD', 'CHF', 'SGD', 'CAD']);
});

test('history and all require deliberate currency selection and default to all four ranges', () => {
  const options = parseOptions(['history', '--currency', 'usd']);
  assert.deepEqual(options.currencies, ['USD']);
  assert.deepEqual(options.ranges, ['1m', '3m', '6m', '1y']);
  assert.equal(parseOptions(['all', '--currency', 'all']).currencies.length, 10);
  assert.equal(parseOptions(['current', '--currency', 'all']).currencies, null);
});

test('range selection supports repetition and preserves requested order', () => {
  const options = parseOptions(['pingan', 'all', '--currency', 'USD', '--range', '1Y,1m', '--range', '1m']);
  assert.deepEqual(options.ranges, ['1y', '1m']);
  assert.deepEqual(parseOptions(['history', '--currency', 'USD', '--range', 'all,1m']).ranges, ['1m', '3m', '6m', '1y']);
});

test('unknown or incompatible arguments fail locally, including all mixed with invalid values', () => {
  for (const args of [
    ['icbc'], ['pingan', 'unknown'], ['pingan', 'current', 'extra'], ['current', 'pingan'],
    ['history'], ['all'], ['current', '--range', '1m'], ['current', '--currency', ''],
    ['current', '--currency', 'RUB'], ['current', '--currency', 'all,RUB'],
    ['history', '--currency', 'USD', '--range', ''], ['history', '--currency', 'USD', '--range', 'realtime'],
    ['history', '--currency', 'USD', '--range', 'all,unknown'], ['current', '--currency', '__proto__'],
  ]) {
    assert.throws(() => parseOptions(args), error => error.code === 'INVALID_ARGUMENT', args.join(' '));
  }
  assert.throws(() => parseOptions(['--unknown']), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
});

test('help and fatal JSON errors run through the Node 26 CLI entry point', () => {
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /人民币元 \/ 100 外币/);
  const failure = spawnSync(process.execPath, [SCRIPT, 'current', '--currency', 'RUB', '--json'], { encoding: 'utf8' });
  assert.equal(failure.status, 1);
  assert.equal(failure.stderr, '');
  const body = JSON.parse(failure.stdout);
  assert.equal(body.status, 'error');
  assert.equal(body.code, 'INVALID_ARGUMENT');
  assert.match(body.error, /未知币种/);
});

test('current results contain explicit quote units and never request history', async () => {
  const result = await loadResult({
    bank: adapter({ getHistory: () => assert.fail('unexpected historical request') }),
    command: 'current', currencies: ['JPY'], ranges: [], now: NOW,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.baseAmount, 100);
  assert.equal(result.quoteCurrency, 'CNY');
  assert.equal(result.fetchedAt, '2026-11-05T16:00:00.000Z');
  assert.equal(Object.hasOwn(result, 'history'), false);
});

test('all completes current before history and shares one reference time', async () => {
  const calls = [];
  const result = await loadResult({
    bank: adapter({
      getCurrent: async () => { calls.push('current'); return current(); },
      getHistory: async options => { calls.push('history'); assert.equal(options.now, NOW); return history(); },
    }),
    command: 'all', currencies: ['JPY'], ranges: ['1m'], now: NOW,
  });
  assert.deepEqual(calls, ['current', 'history']);
  assert.equal(result.status, 'ok');
});

test('current failure still permits history success and produces partial data', async () => {
  const result = await loadResult({
    bank: adapter({ getCurrent: async () => { throw new ExchangeApiError('failure', { status: 503, retryable: true }); } }),
    command: 'all', currencies: ['JPY'], ranges: ['1m'], now: NOW,
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.current.errors[0].scope, 'current');
  assert.equal(result.current.errors[0].httpStatus, 503);
  assert.equal(result.history.trends.JPY['1m'].points.length, 1);
});

test('history failure preserves current quotes; both failures produce error', async () => {
  const fail = async () => { throw new Error('failure'); };
  const options = { command: 'all', currencies: ['JPY'], ranges: ['1m'], now: NOW };
  const partial = await loadResult({ ...options, bank: adapter({ getHistory: fail }) });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.current.quotes.length, 1);
  const failed = await loadResult({ ...options, bank: adapter({ getCurrent: fail, getHistory: fail }) });
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /有效汇率/);
});

test('warnings mark otherwise valid output partial and all-empty history is error', async () => {
  const result = await loadResult({
    bank: adapter({ getCurrent: async () => ({ ...current(), warnings: [{ scope: 'current.JPY', message: 'missing field' }] }) }),
    command: 'current', currencies: ['JPY'], ranges: [], now: NOW,
  });
  assert.equal(result.status, 'partial');
  const empty = await loadResult({
    bank: adapter({ getHistory: async () => ({ trends: {}, warnings: [{ scope: 'history', message: 'empty' }], errors: [] }) }),
    command: 'history', currencies: ['JPY'], ranges: ['1m'], now: NOW,
  });
  assert.equal(empty.status, 'error');
});

test('default current and explicit currency all mark a nine-currency response partial', async () => {
  const client = createClient({ request: async () => ({
    responseCode: '000000',
    data: {
      updateTime: '2026-11-06 08:55:26',
      settleList: Object.entries(CURRENCIES).filter(([currency]) => currency !== 'JPY')
        .map(([currency, definition]) => ({ ccy: currency, ccyName: definition.name, sellingRate: '2', buyingRate: '1' })),
    },
  }) });
  for (const args of [[], ['current', '--currency', 'all']]) {
    const options = parseOptions(args);
    const result = await loadResult({ ...options, bank: { ...options.bank, ...client }, now: NOW });
    assert.equal(result.status, 'partial');
    assert.equal(result.current.quotes.length, 9);
    assert.ok(result.current.warnings.some(warning => warning.scope === 'current.JPY' && warning.code === 'MISSING_CURRENCY'));
  }
});

test('human output states customer directions, units and distinct bank update time', async () => {
  const result = await loadResult({ bank: adapter(), command: 'all', currencies: ['JPY'], ranges: ['1m'], now: NOW });
  const text = formatHuman(result);
  assert.match(text, /人民币元 \/ 100 外币/);
  assert.match(text, /购汇 = 客户买外币，结汇 = 客户卖外币/);
  assert.match(text, /银行更新时间: 2026-11-06 08:55:26/);
  assert.match(text, /购汇 4\.2427  结汇 4\.2162/);
  assert.match(text, /历史每日报价/);
  assert.match(text, /参考中间价/);
  assert.match(text, /购汇: 暂无数据/);
});

test('bank registry exposes extension metadata and query methods', () => {
  const bank = BANKS.get('pingan');
  assert.equal(bank.baseAmount, 100);
  assert.equal(Object.keys(bank.currencies).length, 10);
  assert.equal(typeof bank.getCurrent, 'function');
  assert.equal(typeof bank.getHistory, 'function');
});
