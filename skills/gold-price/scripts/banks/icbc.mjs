import { serializeError } from '../lib/errors.mjs';
import { postJson } from '../lib/legacy-https.mjs';
import { round } from '../lib/num.mjs';

const BASE_URL = 'https://mywap2.icbc.com.cn/ICBCWAPBankB5/physicalPreciousMetals';
const HEADERS = {
  accept: 'application/json',
  'user-agent': 'gold-price-skill/1.0 (+https://github.com/4x25/skills)',
};

const ITEM_NAME = '如意金条';
const FALLBACK_ITEM_SEQ_NO = 'GOOD246112600024';
const PHYSICAL_WEIGHTS = new Set([10, 20, 50, 100]);
const SPEC_PATTERN = /^金(\d+(?:\.\d+)?)g$/i;

export const bank = Object.freeze({ id: 'icbc', name: '工商银行' });

export async function getPhysical() {
  const warnings = [];
  const itemSeqNo = await discoverItemSeqNo(warnings);

  let detail;
  try {
    detail = await postJson(`${BASE_URL}/queryGoodsDetails`, {
      sessionId: '',
      itemSeqNo,
      specSeqNo: '',
      ejectSellerCode: '',
    }, { headers: HEADERS });
    validateDetail(detail, itemSeqNo, warnings);
  } catch (error) {
    return {
      productName: ITEM_NAME,
      currency: 'CNY',
      itemSeqNo,
      priceDate: null,
      saleWindow: null,
      quotes: [],
      warnings,
      errors: [serializeError(error, 'physical.detail')],
    };
  }

  const specs = discoverSpecs(detail);
  const foundWeights = new Set(specs.map(({ weight }) => weight));
  const missingWeights = [...PHYSICAL_WEIGHTS].filter((weight) => !foundWeights.has(weight));
  if (missingWeights.length > 0) {
    warnings.push({
      scope: 'physical.discovery',
      message: `未发现规格: ${missingWeights.map((weight) => `${weight}g`).join(', ')}`,
    });
  }

  const quotes = [];
  const errors = [];

  for (const { weight, spec } of specs) {
    try {
      quotes.push(toQuote(detail, spec, weight));
    } catch (error) {
      errors.push(serializeError(error, `physical.${weight}g`));
    }
  }

  quotes.sort((a, b) => a.weightGrams - b.weightGrams);

  return {
    productName: firstNonEmpty(detail.itemName) ?? ITEM_NAME,
    currency: 'CNY',
    itemSeqNo: firstNonEmpty(detail.itemSeqNo) ?? itemSeqNo,
    priceDate: detail.busiDate ?? null,
    saleWindow: detail.dailySaleStartTime && detail.dailySaleEndTime
      ? { start: detail.dailySaleStartTime, end: detail.dailySaleEndTime }
      : null,
    quotes,
    warnings,
    errors,
  };
}

async function discoverItemSeqNo(warnings) {
  try {
    const body = await postJson(`${BASE_URL}/queryPreciousMetalsGoodsInfo`, {
      sessionId: '',
      qryType: '2',
      pageNo: 1,
      pageSize: 50,
      operType: '2',
    }, { headers: HEADERS });

    const candidates = (body.itemList ?? []).filter(
      (entry) => String(entry.itemName ?? '').trim() === ITEM_NAME,
    );
    const item = candidates.find(
      (entry) => entry.itemSeqNo === FALLBACK_ITEM_SEQ_NO,
    ) ?? candidates[0];

    if (item?.itemSeqNo) {
      if (item.itemSeqNo !== FALLBACK_ITEM_SEQ_NO) {
        warnings.push({
          scope: 'physical.discovery',
          message: `未找到已知商品代码 ${FALLBACK_ITEM_SEQ_NO}，使用同名商品 ${item.itemSeqNo}`,
        });
      }
      return item.itemSeqNo;
    }

    warnings.push({
      scope: 'physical.discovery',
      message: `未找到“${ITEM_NAME}”，无法确认商品身份，使用备用商品代码 ${FALLBACK_ITEM_SEQ_NO}`,
    });
  } catch (error) {
    warnings.push({
      ...serializeError(error, 'physical.discovery'),
      message: `商品列表查询失败，无法确认商品身份，使用备用商品代码 ${FALLBACK_ITEM_SEQ_NO}: ${error?.message ?? error}`,
    });
  }

  return FALLBACK_ITEM_SEQ_NO;
}

function validateDetail(detail, requestedCode, warnings) {
  const name = firstNonEmpty(detail?.itemName);
  if (!name) {
    warnings.push({
      scope: 'physical.identity',
      message: '商品详情缺少 itemName，无法确认商品身份',
    });
  } else if (name !== ITEM_NAME) {
    throw new Error(`商品名称不匹配: expected ${ITEM_NAME}, got ${name}`);
  }

  const code = firstNonEmpty(detail?.itemSeqNo);
  if (!code) {
    warnings.push({
      scope: 'physical.identity',
      message: '商品详情缺少 itemSeqNo，无法确认商品代码',
    });
  } else if (code !== requestedCode) {
    throw new Error(`商品代码不匹配: requested ${requestedCode}, got ${code}`);
  }
}

function discoverSpecs(detail) {
  const byWeight = new Map();

  for (const spec of detail.specificationList ?? []) {
    if (!spec) continue;

    const specName = firstNonEmpty(spec.specName);
    const match = SPEC_PATTERN.exec(specName ?? '');
    if (!match) continue;

    const weight = Number(match[1]);
    if (!PHYSICAL_WEIGHTS.has(weight) || byWeight.has(weight)) continue;
    byWeight.set(weight, { weight, spec });
  }

  return [...byWeight.values()].sort((a, b) => a.weight - b.weight);
}

function toQuote(detail, spec, weight) {
  const specName = firstNonEmpty(spec.specName);
  if (!specName) throw new Error('Missing specification name');

  const totalPrice = toNumber(spec.salePriceByPiece);
  if (totalPrice == null || totalPrice <= 0) {
    throw new Error(`Invalid price for ${specName}`);
  }

  const apiPricePerGram = toNumber(spec.salePriceByWeight);
  const pricePerGram = apiPricePerGram != null && apiPricePerGram > 0
    ? apiPricePerGram
    : round(totalPrice / weight);

  if (pricePerGram == null || pricePerGram <= 0) {
    throw new Error(`Invalid price per gram for ${specName}`);
  }

  const remainingQuota = toNumber(spec.residualQuota);
  const quotaControlled = flagToBoolean(spec.quotaFlag) === true;
  const soldOut = quotaControlled && remainingQuota != null && remainingQuota <= 0;

  return {
    sku: `${weight}g`,
    productCode: firstNonEmpty(spec.pptxnno, spec.prodCode, spec.specSeqNo),
    productName: firstNonEmpty(detail.itemName),
    spec: specName,
    weightGrams: weight,
    totalPrice,
    pricePerGram,
    saleStatus: null,
    tradable: soldOut ? false : null,
    quotaControlled,
    remainingQuota,
    specSeqNo: firstNonEmpty(spec.specSeqNo),
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function flagToBoolean(value) {
  if (value === '1' || value === 1 || value === true) return true;
  if (value === '0' || value === 0 || value === false) return false;
  return null;
}

function toNumber(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
