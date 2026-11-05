import { mapLimit } from '../lib/concurrency.mjs';
import { serializeError } from '../lib/errors.mjs';
import { fetchJson } from '../lib/http.mjs';
import { fromChinaDateTime, fromCompactTime } from '../lib/time.mjs';
import { round } from '../lib/num.mjs';

const BASE_URL = 'https://rmb.pingan.com.cn';
const HEADERS = {
  accept: 'application/json',
  'user-agent': 'gold-price-skill/1.0 (+https://github.com/4x25/skills)',
};

const DIGITAL_CODE = 'GOLD_SHARE';
const PHYSICAL_SEED_CODE = '10550037';
const PHYSICAL_WEIGHTS = new Set([10, 20, 50, 100]);
const PHYSICAL_SPEC_PATTERN = /^(\d+(?:\.\d+)?)(?:克|g|G)?$/;

export const RANGES = Object.freeze({
  realtime: { label: '实时', searchType: '1', dateType: null },
  '1m': { label: '近1月', searchType: '2', dateType: 2 },
  '3m': { label: '近3月', searchType: '2', dateType: 3 },
  '6m': { label: '近6月', searchType: '2', dateType: 4 },
  '1y': { label: '近1年', searchType: '2', dateType: 5 },
});

export const ALL_RANGES = Object.freeze(Object.keys(RANGES));

export const bank = Object.freeze({ id: 'pingan', name: '平安银行' });

export async function getDigital({ ranges = ALL_RANGES, includeCurrent = true } = {}) {
  const tasks = [];

  if (includeCurrent) tasks.push({ type: 'current' });
  for (const range of ranges) tasks.push({ type: 'trend', range });

  const results = await mapLimit(tasks, 3, async (task) => (
    task.type === 'current'
      ? fetchDigitalCurrent()
      : fetchDigitalTrend(task.range)
  ));

  const digital = {
    productName: '平安金活期',
    productCode: DIGITAL_CODE,
    unit: 'CNY/g',
    current: null,
    trends: {},
    errors: [],
  };

  results.forEach((result, index) => {
    const task = tasks[index];

    if (result.status === 'rejected') {
      const scope = task.type === 'current'
        ? 'digital.current'
        : `digital.trends.${task.range}`;
      digital.errors.push(serializeError(result.reason, scope));
      return;
    }

    if (task.type === 'current') {
      digital.current = result.value;
    } else {
      digital.trends[task.range] = result.value;
    }
  });

  return digital;
}

export async function getPhysical() {
  const seed = await fetchPhysicalDetail(PHYSICAL_SEED_CODE);
  const skus = discoverPhysicalSkus(seed);
  const warnings = [];

  const foundWeights = new Set(skus.map(({ weight }) => weight));
  const missingWeights = [...PHYSICAL_WEIGHTS].filter((weight) => !foundWeights.has(weight));
  if (missingWeights.length > 0) {
    warnings.push({
      scope: 'physical.discovery',
      message: `未发现规格: ${missingWeights.map((weight) => `${weight}g`).join(', ')}`,
    });
  }

  const results = await mapLimit(skus, 3, async ({ weight, code }) => {
    const detail = code === PHYSICAL_SEED_CODE ? seed : await fetchPhysicalDetail(code);
    return toPhysicalQuote(detail, weight, code);
  });

  const quotes = [];
  const errors = [];

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      errors.push(serializeError(result.reason, `physical.${skus[index].weight}g`));
      return;
    }
    quotes.push(result.value);
  });

  quotes.sort((a, b) => a.weightGrams - b.weightGrams);

  return {
    productName: seed.swjProductSeriesRealName ?? '平安浇铸金条',
    currency: 'CNY',
    quotes,
    warnings,
    errors,
  };
}

async function fetchDigitalCurrent() {
  const body = await fetchPingAn(
    '/bron/ibank/cust/bron-ibank-pd/gold/product/acct/getPopCurrGoldPrice.do',
    {
      channelCode: 'C0012',
      productCode: 'Au',
      priceType: '1',
      holdAmt: '',
      access_source: 'H5',
    },
  );

  const data = body?.data;
  if (!data) throw new Error('Empty current price payload');

  const sellingRate = toNumber(data.sellingRate);
  if (sellingRate == null || sellingRate <= 0) {
    throw new Error('Invalid current selling rate');
  }

  return {
    price: sellingRate,
    sellingRate,
    buyingRate: toNumber(data.buyingRate),
    publishTime: fromCompactTime(data.publishTime),
  };
}

async function fetchDigitalTrend(range) {
  const definition = RANGES[range];
  if (!definition) throw new Error(`Unknown range: ${range}`);

  const params = {
    access_source: 'H5',
    searchType: definition.searchType,
    prdCode: DIGITAL_CODE,
  };
  if (definition.dateType != null) {
    params.channelCode = 'C0012';
    params.dateType = String(definition.dateType);
  }

  const body = await fetchPingAn(
    '/bron/ibank/cust/bron-ibank-pd/gold/product/acct/getPopGoldPriceList.do',
    params,
  );

  const list = body?.data?.list;
  if (!Array.isArray(list)) throw new Error('Empty price list payload');

  const points = list
    .map((item) => ({
      time: fromCompactTime(item.publishTime),
      price: toNumber(item.sellingRate),
      buyingRate: toNumber(item.buyingRate),
    }))
    .filter((point) => point.time && point.price != null && point.price > 0)
    .sort((a, b) => a.time.localeCompare(b.time));

  if (list.length > 0 && points.length === 0) {
    throw new Error(`No valid price points for ${definition.label}`);
  }

  return {
    label: definition.label,
    summary: summarize(points),
    points,
  };
}

async function fetchPhysicalDetail(prdCode) {
  const body = await fetchPingAn(
    '/bron/ibank/pop/goldPhysical/product/queryGoldPhysicalDetail.do',
    { prdCode, access_source: 'H5' },
  );

  if (!body?.data) throw new Error(`Empty physical product payload for ${prdCode}`);
  return body.data;
}

function discoverPhysicalSkus(seed) {
  const byWeight = new Map();

  for (const item of seed.productSpecificationList ?? []) {
    if (!item?.prdCode) continue;

    const spec = String(item.swjProductSpecification ?? '').trim();
    const match = PHYSICAL_SPEC_PATTERN.exec(spec);
    if (!match) continue;

    const weight = Number(match[1]);
    if (!PHYSICAL_WEIGHTS.has(weight) || byWeight.has(weight)) continue;
    byWeight.set(weight, { weight, code: item.prdCode });
  }

  if (!byWeight.has(10)) byWeight.set(10, { weight: 10, code: PHYSICAL_SEED_CODE });
  return [...byWeight.values()].sort((a, b) => a.weight - b.weight);
}

function toPhysicalQuote(detail, specWeight, fallbackCode) {
  const detailWeight = toNumber(detail.prdWeight);
  if (detailWeight != null && detailWeight !== specWeight) {
    throw new Error(
      `Weight mismatch for ${detail.prdCode}: spec ${specWeight}g, detail ${detailWeight}g`,
    );
  }

  const totalPrice = toNumber(detail.prdPrice);
  if (totalPrice == null || totalPrice <= 0) {
    throw new Error(`Invalid price for ${detail.prdCode}`);
  }

  const tradeTime = flagToBoolean(detail.isTradeTime);
  const onSale = detail.saleStatus == null ? null : detail.saleStatus === 'ON_SALE';
  const tradable = tradeTime === false || onSale === false
    ? false
    : tradeTime === true && onSale === true
      ? true
      : null;

  return {
    sku: `${specWeight}g`,
    productCode: detail.prdCode ?? fallbackCode,
    productName: detail.prdName ?? null,
    spec: detail.swjProductSpecification ?? null,
    weightGrams: specWeight,
    totalPrice,
    pricePerGram: round(totalPrice / specWeight),
    saleStatus: detail.saleStatus ?? null,
    tradable,
    serverTime: fromChinaDateTime(detail.systemTime),
  };
}

function summarize(points) {
  if (points.length === 0) return null;

  const first = points[0];
  const last = points.at(-1);
  const prices = points.map((point) => point.price);
  const change = last.price - first.price;

  return {
    count: points.length,
    startTime: first.time,
    endTime: last.time,
    firstPrice: first.price,
    lastPrice: last.price,
    change: round(change),
    changePercent: first.price === 0 ? null : round((change / first.price) * 100),
    minPrice: Math.min(...prices),
    maxPrice: Math.max(...prices),
  };
}

async function fetchPingAn(path, params) {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return fetchJson(url, { headers: HEADERS });
}

function toNumber(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function flagToBoolean(value) {
  if (value === '1' || value === 1 || value === true) return true;
  if (value === '0' || value === 0 || value === false) return false;
  return null;
}
