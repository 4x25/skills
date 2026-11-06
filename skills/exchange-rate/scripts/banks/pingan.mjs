import { mapLimit } from '../lib/concurrency.mjs';
import { ExchangeApiError, serializeError } from '../lib/errors.mjs';
import { fetchJson } from '../lib/http.mjs';
import { positiveNumber, round, summarize } from '../lib/num.mjs';
import { dateRange, fromChinaDateTime, fromCompactDate } from '../lib/time.mjs';

const BASE_URL = 'https://rmb.pingan.com.cn/account/cmp/cust/acct/forex/exchange/';
const HEADERS = {
  accept: 'application/json',
  'user-agent': 'exchange-rate-skill/1.0 (+https://github.com/4x25/skills)',
};

export const bank = Object.freeze({
  id: 'pingan', name: '平安银行', baseAmount: 100, quoteCurrency: 'CNY',
});

export const CURRENCIES = Object.freeze({
  USD: { name: '美元', aliases: ['美金'] },
  HKD: { name: '港元', aliases: ['港币'] },
  GBP: { name: '英镑', aliases: [] },
  JPY: { name: '日元', aliases: ['日币'] },
  EUR: { name: '欧元', aliases: [] },
  AUD: { name: '澳元', aliases: ['澳币', '澳大利亚元'] },
  NZD: { name: '纽币', aliases: ['纽元', '新西兰元'] },
  CHF: { name: '瑞郎', aliases: ['瑞士法郎'] },
  SGD: { name: '新元', aliases: ['新币', '新加坡元'] },
  CAD: { name: '加元', aliases: ['加币', '加拿大元'] },
});

export const RANGES = Object.freeze({
  '1m': { label: '近一月', days: 30 },
  '3m': { label: '近三月', days: 90 },
  '6m': { label: '近半年', days: 180 },
  '1y': { label: '近一年', days: 365 },
});
export const ALL_RANGES = Object.freeze(Object.keys(RANGES));

const QUOTE_FIELDS = { purchaseRate: 'sellingRate', settlementRate: 'buyingRate' };
const HISTORY_FIELDS = { ...QUOTE_FIELDS, middleRate: 'middleRate' };

export function createClient({ request = fetchJson } = {}) {
  async function query(path, params) {
    const options = { headers: HEADERS };
    if (params) {
      options.method = 'POST';
      options.body = new URLSearchParams(params);
    }
    const body = await request(new URL(path, BASE_URL), options);
    if (body?.responseCode !== '000000' || body?.success === false) {
      throw new ExchangeApiError(`API ${body?.responseCode ?? 'unknown'}: ${body?.responseMsg ?? '无效响应'}`, {
        code: body?.responseCode ?? 'INVALID_RESPONSE',
      });
    }
    return body;
  }

  return {
    async getCurrent({ currencies = null } = {}) {
      validateCurrencies(currencies);
      return normalizeCurrent(await query('qryExchangePriceList.do'), { currencies });
    },

    async getHistory({ currencies, ranges = ALL_RANGES, now = new Date() } = {}) {
      validateCurrencies(currencies, true);
      if (!Array.isArray(ranges) || ranges.length === 0 || ranges.some(range => !Object.hasOwn(RANGES, range))) {
        throw new ExchangeApiError('请选择有效的汇率区间', { code: 'INVALID_ARGUMENT' });
      }
      const tasks = [...new Set(currencies)].flatMap(currency => [...new Set(ranges)].map(range => ({
        currency, range, ...dateRange(RANGES[range].days, now),
      })));
      const results = await mapLimit(tasks, 3, async task => normalizeTrend(
        await query('qryExchangeHisPriceDetail.do', {
          ccy: task.currency, startDate: task.startDate, endDate: task.endDate,
        }),
        task,
      ));
      const history = { trends: {}, warnings: [], errors: [] };
      results.forEach((result, index) => {
        const { currency, range } = tasks[index];
        if (result.status === 'rejected') {
          history.errors.push(serializeError(result.reason, `history.${currency}.${range}`));
          return;
        }
        const { warnings, ...trend } = result.value;
        history.trends[currency] ??= {};
        history.trends[currency][range] = trend;
        history.warnings.push(...warnings);
      });
      return history;
    },
  };
}

const client = createClient();
export const getCurrent = client.getCurrent;
export const getHistory = client.getHistory;

export function normalizeCurrent(body, { currencies = null } = {}) {
  const data = body?.data;
  if (!Array.isArray(data?.settleList)) {
    throw new ExchangeApiError('缺少 settleList 汇率列表', { code: 'INVALID_PAYLOAD' });
  }
  const warnings = [];
  const updateTime = normalizeUpdateTime(data.updateTime, 'current', warnings);
  const requested = currencies == null ? null : new Set(currencies);
  const quotes = new Map();

  for (const item of data.settleList) {
    const currency = item?.ccy;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      warn(warnings, 'current', '无效的币种代码', 'INVALID_CURRENCY');
      continue;
    }
    if (requested && !requested.has(currency)) continue;
    const scope = `current.${currency}`;
    const rates = normalizeRates(item, QUOTE_FIELDS, scope, warnings);
    if (Object.values(rates).every(rate => rate == null)) continue;
    if (quotes.has(currency)) {
      warn(warnings, scope, '币种重复，保留首条报价', 'DUPLICATE_CURRENCY');
      continue;
    }
    quotes.set(currency, {
      currency,
      currencyName: item.ccyName || CURRENCIES[currency]?.name || currency,
      ...rates,
      purchasePerUnit: rates.purchaseRate == null ? null : round(rates.purchaseRate / bank.baseAmount, 6),
      settlementPerUnit: rates.settlementRate == null ? null : round(rates.settlementRate / bank.baseAmount, 6),
      spread: rates.purchaseRate == null || rates.settlementRate == null
        ? null : round(rates.purchaseRate - rates.settlementRate),
    });
  }
  for (const currency of requested ?? Object.keys(CURRENCIES)) {
    if (!quotes.has(currency)) warn(warnings, `current.${currency}`, '未返回该币种的有效报价', 'MISSING_CURRENCY');
  }
  if (quotes.size === 0) warn(warnings, 'current', '汇率列表为空或没有有效报价', 'EMPTY_CURRENT');
  return { updateTime, quotes: [...quotes.values()], warnings, errors: [] };
}

export function normalizeTrend(body, { currency, range, startDate, endDate }) {
  const data = body?.data;
  if (!Array.isArray(data?.rateList)) {
    throw new ExchangeApiError('缺少 rateList 历史汇率列表', { code: 'INVALID_PAYLOAD' });
  }
  const scope = `history.${currency}.${range}`;
  const warnings = [];
  const updateTime = normalizeUpdateTime(data.updateTime, scope, warnings);
  const byDate = new Map();

  for (const item of data.rateList) {
    const date = fromCompactDate(item?.exchangeDate);
    if (item?.ccy !== currency || !date || date < startDate || date > endDate) {
      warn(warnings, scope, '丢弃币种或日期无效的历史记录', 'INVALID_POINT');
      continue;
    }
    const rates = normalizeRates(item, HISTORY_FIELDS, `${scope}.${date}`, warnings);
    if (Object.values(rates).every(rate => rate == null)) continue;
    if (byDate.has(date)) {
      warn(warnings, `${scope}.${date}`, '日期重复，保留首条记录', 'DUPLICATE_DATE');
      continue;
    }
    byDate.set(date, { date, ...rates });
  }
  const points = [...byDate.values()].toSorted((a, b) => a.date.localeCompare(b.date));
  if (points.length === 0) warn(warnings, scope, '该区间没有有效历史汇率', 'EMPTY_HISTORY');
  return {
    currency,
    currencyName: CURRENCIES[currency]?.name ?? currency,
    label: RANGES[range].label,
    basis: 'daily',
    startDate,
    endDate,
    updateTime,
    points,
    summary: {
      purchase: summarize(points, 'purchaseRate'),
      settlement: summarize(points, 'settlementRate'),
      middle: summarize(points, 'middleRate'),
    },
    warnings,
  };
}

function normalizeRates(item, fields, scope, warnings) {
  const rates = {};
  for (const [field, source] of Object.entries(fields)) {
    rates[field] = positiveNumber(item[source]);
    if (rates[field] == null) warn(warnings, `${scope}.${field}`, `${source} 缺失或不是有效正数`, 'INVALID_RATE');
  }
  if (rates.purchaseRate != null && rates.settlementRate != null && rates.purchaseRate < rates.settlementRate) {
    warn(warnings, scope, '购汇价低于结汇价，请核对银行原始数据', 'INVERTED_SPREAD');
  }
  return rates;
}

function normalizeUpdateTime(value, scope, warnings) {
  const time = fromChinaDateTime(value);
  if (!time) warn(warnings, scope, '银行更新时间缺失或无效', 'INVALID_UPDATE_TIME');
  return time;
}

function validateCurrencies(currencies, required = false) {
  if (currencies == null && !required) return;
  if (!Array.isArray(currencies) || currencies.length === 0
    || currencies.some(currency => !Object.hasOwn(CURRENCIES, currency))) {
    throw new ExchangeApiError('请选择平安银行支持的币种', { code: 'INVALID_ARGUMENT' });
  }
}

function warn(warnings, scope, message, code) {
  warnings.push({ scope, message, code });
}
