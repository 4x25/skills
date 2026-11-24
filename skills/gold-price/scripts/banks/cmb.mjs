import { GoldApiError, postForm, postJson } from '../lib/http.mjs';
import { serializeError } from '../lib/errors.mjs';
import { round } from '../lib/num.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const MODULE_BASE_URL = 'https://mbmodule-openapi.paas.cmbchina.com';
const DETAIL_BASE_URL = 'https://mobile.cmbchina.com';
const HEADERS = {
  accept: 'application/json',
  'user-agent': 'gold-price-skill/1.0 (+https://github.com/4x25/skills)',
};

// 抓包自黄金频道 tabmetaldefault 页面，见 references/cmb-api.md
const METAL_PAGE_ID = '47E5BC8D-207E-38AD-AAEB-B4F09C268D29';
const MET_DEAL_MODULE_ID = 'DBFBA590-7121-3487-AE59-FA78BF1DC7F8';
const MET_PHY_MODULE_ID = 'C8207F8B-7A0B-3E88-B853-A9BA9E092309';

const FALLBACK_PHYSICAL = Object.freeze({
  splCod: 'FJ003',
  prdCod: 'GLD0318',
  prdStd: 'K0010',
});

const PHYSICAL_WEIGHTS = new Set([10, 20, 50, 100]);
const SPEC_CODE_PATTERN = /^K0(\d{3})$/;

// 灵活买卖（黄金活期）的涨跌幅标签；zDvlCur 是今日涨跌额（元/克）而非百分比，
// 页面"今日"读 zDifCur（zPrcDif 同值）；zDifMo3 未在页面展示，不采集。
export const RANGES = Object.freeze({
  today: { label: '今日', field: 'zDifCur' },
  '1m': { label: '近1月', field: 'zDifMo1' },
  '3m': { label: '近3月', field: 'zDifMo2' },
  '1y': { label: '近1年', field: 'zDifMo4' },
});

export const ALL_RANGES = Object.freeze(Object.keys(RANGES));

export const bank = Object.freeze({ id: 'cmb', name: '招商银行' });

export async function getDigital({ ranges = ALL_RANGES, includeCurrent = true } = {}) {
  const errors = [];
  let prices = null;
  const wantChanges = includeCurrent || ranges.length > 0;

  // 招行的当前价与涨跌幅来自同一个接口：history 只要涨跌幅也得请求它。
  if (wantChanges) {
    try {
      prices = await fetchMetalPrice();
    } catch (error) {
      errors.push(serializeError(error, 'digital.current'));
    }
  }

  return {
    productName: '招行黄金活期',
    productCode: null,
    unit: 'CNY/g',
    current: includeCurrent && prices ? {
      price: prices.sellingRate,
      sellingRate: prices.sellingRate,
      buyingRate: prices.buyingRate,
      publishTime: null,
    } : null,
    trends: {},
    changes: prices ? toChanges(prices, ranges) : {},
    errors,
  };
}

export async function getPhysical() {
  const warnings = [];
  const errors = [];
  let product = null;
  let detail = null;

  try {
    product = await discoverValueBar();
  } catch (error) {
    warnings.push({
      ...serializeError(error, 'physical.discovery'),
      message: `高性价比金条发现失败，使用备用商品 ${FALLBACK_PHYSICAL.prdCod}: ${error?.message ?? error}`,
    });
  }

  try {
    detail = await fetchProductDetail(product ?? FALLBACK_PHYSICAL);
  } catch (error) {
    errors.push(serializeError(error, 'physical.detail'));
  }

  if (!detail) {
    return {
      productName: '高性价比金条',
      currency: 'CNY',
      quotes: [],
      warnings,
      errors,
    };
  }

  const quotes = [];
  const specs = collectSpecs(detail);

  if (!Array.isArray(detail.detailInfoList)) {
    errors.push(serializeError(
      new Error(`Empty detail info list payload for ${detail.productDetail?.productCode ?? 'unknown'}`),
      'physical.detail',
    ));
  }

  for (const { weight, spec } of specs) {
    try {
      quotes.push(toQuote(detail, spec, weight));
    } catch (error) {
      errors.push(serializeError(error, `physical.${weight}g`));
    }
  }

  quotes.sort((a, b) => a.weightGrams - b.weightGrams);

  const foundWeights = new Set(quotes.map(({ weightGrams }) => weightGrams));
  const missingWeights = [...PHYSICAL_WEIGHTS].filter((weight) => !foundWeights.has(weight));
  if (missingWeights.length > 0) {
    warnings.push({
      scope: 'physical.discovery',
      message: `未发现规格: ${missingWeights.map((weight) => `${weight}g`).join(', ')}`,
    });
  }

  return {
    productName: detail.productDetail?.productName ?? '高性价比金条',
    currency: 'CNY',
    quotes,
    warnings,
    errors,
  };
}

async function postModuleForm(modulePath, moduleId) {
  // 模块接口偶发返回 MDU0902 系统处理异常（success:false），加重试。
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await postForm(`${MODULE_BASE_URL}/product/v2/module/${modulePath}`, {
        pageID: METAL_PAGE_ID,
        moduleID: moduleId,
        extraParam: {},
      }, { headers: HEADERS });
    } catch (error) {
      if (!(error instanceof GoldApiError) || error.code !== 'MDU0902' || attempt === 3) {
        throw error;
      }
      lastError = error;
      await sleep(300 * 2 ** (attempt - 1));
    }
  }
  throw lastError ?? new GoldApiError('Request failed');
}

async function fetchMetalPrice() {
  const body = await postModuleForm('met-deal', MET_DEAL_MODULE_ID);
  const metalPrice = body?.data?.bizInfo?.MetalPrice;
  if (!metalPrice) throw new Error('Empty metal price payload');

  const sellingRate = toNumber(metalPrice.zBuyPrc);
  const buyingRate = toNumber(metalPrice.zSelPrc);
  if (sellingRate == null || sellingRate <= 0) {
    throw new Error('Invalid current selling rate');
  }

  return { sellingRate, buyingRate, raw: metalPrice };
}

function toChanges(prices, ranges) {
  const changes = {};
  for (const range of ranges) {
    const definition = RANGES[range];
    if (!definition) continue;
    const percent = toNumber(prices.raw[definition.field]);
    if (percent == null) continue;
    changes[range] = { label: definition.label, changePercent: percent };
  }
  return changes;
}

async function discoverValueBar() {
  const body = await postModuleForm('met-phy', MET_PHY_MODULE_ID);

  const modules = body?.data?.moduleRepeatList;
  if (!Array.isArray(modules)) throw new Error('Empty physical module payload');

  const valueBar = modules.find(
    (item) => String(item?.PrdName ?? '').includes('高性价比金条')
      || String(item?.PrdDes ?? '').includes('高性价比金条'),
  );

  if (!valueBar?.GSplCod || !valueBar?.GPrdCod) {
    throw new Error('未在实物金条板块找到高性价比金条推荐位');
  }

  return {
    splCod: valueBar.GSplCod,
    prdCod: valueBar.GPrdCod,
    prdStd: valueBar.GPrdStd || FALLBACK_PHYSICAL.prdStd,
  };
}

async function fetchProductDetail({ splCod, prdCod, prdStd }) {
  // zxlCod 传错会 500，不传可正常返回，故不发送。
  const body = await postJson(`${DETAIL_BASE_URL}/igoldsilver/gold-silver-detail/query-product-detail`, {
    bbkNbr: '571',
    outFlag: 'Y',
    orderDetailJumpFlag: '',
    changeJumpFlag: '',
    prdDsc: '',
    splCod,
    prdTyp: 'GLD',
    prdCod,
    prdStd,
    fromAttentionList: '',
  }, { headers: HEADERS });

  if (Number(body?.bizResult?.code) !== 200) {
    throw new Error(`API ${body?.bizResult?.code ?? 'unknown'}: ${body?.bizResult?.message ?? 'unknown error'}`);
  }

  const data = body.bizResult.data;
  if (!data?.productDetail) throw new Error(`Empty product detail payload for ${prdCod}`);

  return data;
}

function collectSpecs(detail) {
  const byWeight = new Map();

  for (const spec of detail.detailInfoList ?? []) {
    if (!spec?.standards) continue;

    const match = SPEC_CODE_PATTERN.exec(String(spec.standards));
    if (!match) continue;

    const weight = Number(match[1]);
    if (!PHYSICAL_WEIGHTS.has(weight)) continue;

    // 同规格可能有多个商品（如刻字款），优先取默认款。
    if (byWeight.has(weight)) {
      if (String(spec.zxlDefaultFlag ?? '') !== 'Y') continue;
    }
    byWeight.set(weight, { weight, spec });
  }

  return [...byWeight.values()].sort((a, b) => a.weight - b.weight);
}

function toQuote(detail, spec, weight) {
  const product = detail.productDetail ?? {};
  const productCode = `${product.supplierCode ?? ''}${product.productCode ?? ''}${spec.standards ?? ''}` || null;
  const specName = String(spec.standardsDescription ?? '').trim();
  if (!specName) throw new Error(`Missing spec description for ${productCode}`);

  const totalPrice = toNumber(spec.price);
  if (totalPrice == null || totalPrice <= 0) {
    throw new Error(`Invalid price for ${specName}`);
  }

  const saleFlag = String(spec.saleFlag ?? '').trim();
  const buyStatus = String(spec.buyStatus ?? '').trim();
  const tradable = saleFlag === 'Y' && buyStatus === 'E'
    ? true
    : saleFlag === 'N' || buyStatus === 'S' || buyStatus === 'F'
      ? false
      : null;

  // startTime/endTime 可能在 detailInfoList 项或 productDetail 上（不同商品返回位置不同）。
  const saleWindow = toSaleWindow(spec.startTime, spec.endTime)
    ?? toSaleWindow(product.startTime, product.endTime);

  return {
    sku: `${weight}g`,
    productCode,
    productName: spec.productName ?? product.productName ?? null,
    spec: specName,
    weightGrams: weight,
    totalPrice,
    pricePerGram: round(totalPrice / weight),
    saleStatus: saleFlag || null,
    tradable,
    saleWindow,
  };
}

function toSaleWindow(startTime, endTime) {
  const start = toTimeOfDay(startTime);
  const end = toTimeOfDay(endTime);
  return start && end ? { start, end } : null;
}

function toTimeOfDay(value) {
  const match = /^(\d{2})(\d{2})(\d{2})$/.exec(String(value ?? ''));
  return match ? `${match[1]}:${match[2]}` : null;
}

function toNumber(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;

  const number = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}
