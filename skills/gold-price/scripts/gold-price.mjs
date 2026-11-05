#!/usr/bin/env node

import { parseArgs } from 'node:util';
import {
  ALL_RANGES,
  RANGES,
  bank as pingan,
  getDigital as getPinganDigital,
  getPhysical as getPinganPhysical,
} from './banks/pingan.mjs';
import { bank as icbc, getPhysical as getIcbcPhysical } from './banks/icbc.mjs';
import { serializeError } from './lib/errors.mjs';
import { formatChinaMinute, formatChinaTime } from './lib/time.mjs';
import { round } from './lib/num.mjs';

const BANKS = new Map([
  [pingan.id, {
    ...pingan,
    ranges: RANGES,
    allRanges: ALL_RANGES,
    getDigital: getPinganDigital,
    getPhysical: getPinganPhysical,
  }],
  [icbc.id, {
    ...icbc,
    getPhysical: getIcbcPhysical,
  }],
]);

const COMMANDS = new Set(['current', 'history', 'physical', 'all']);

let jsonMode = process.argv.includes('--json');

const USAGE = `用法:
  node scripts/gold-price.mjs [银行] [命令] [选项]

银行:
  pingan                平安银行（数字金 + 实物金）
  icbc                  工商银行（实物金）

命令:
  current               可用的最新价 + 实物黄金各 SKU 报价（默认）
  history               数字金区间走势（仅支持数字金的银行）
  physical              实物黄金各 SKU 报价
  all                   可用数据全部返回

选项:
  --range <列表>        history/all 使用的区间，仅数字金银行；逗号分隔
                        realtime,1m,3m,6m,1y,all（默认 all）
  --json                输出 JSON
  -h, --help            显示帮助

示例:
  node scripts/gold-price.mjs pingan current --json
  node scripts/gold-price.mjs pingan history --range 1m,3m --json
  node scripts/gold-price.mjs icbc physical --json
  node scripts/gold-price.mjs pingan all --json
`;

const priceFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatPrice(value) {
  return value == null ? '--' : priceFormatter.format(value);
}

function formatTimeOfDay(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function formatSaleWindow(value) {
  const start = formatTimeOfDay(value?.start);
  const end = formatTimeOfDay(value?.end);
  return start && end ? `${start}-${end}` : null;
}

function parseRanges(rawValues, bank) {
  if (!rawValues?.length) return [...bank.allRanges];

  const requested = rawValues
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (requested.length === 0) throw new Error('--range 不能为空');

  for (const range of requested) {
    if (range === 'all') continue;
    if (!Object.hasOwn(bank.ranges, range)) {
      throw new Error(`未知区间: ${range}（可选: ${bank.allRanges.join(', ')}, all）`);
    }
  }

  if (requested.includes('all')) return [...bank.allRanges];
  return [...new Set(requested)];
}

function attachDigitalSpread(physical, digitalCurrent) {
  if (!digitalCurrent?.price) return;

  for (const quote of physical.quotes) {
    if (quote.pricePerGram == null) continue;
    quote.spreadVsDigital = round(quote.pricePerGram - digitalCurrent.price);
  }
}

async function loadDigital(bank, options) {
  try {
    return await bank.getDigital(options);
  } catch (error) {
    return {
      productName: '数字黄金',
      productCode: null,
      unit: 'CNY/g',
      current: null,
      trends: {},
      errors: [serializeError(error, 'digital')],
    };
  }
}

async function loadPhysical(bank) {
  try {
    return await bank.getPhysical();
  } catch (error) {
    return {
      productName: '实物黄金',
      currency: 'CNY',
      quotes: [],
      warnings: [],
      errors: [serializeError(error, 'physical')],
    };
  }
}

async function loadResult(bank, command, ranges) {
  const result = {
    bank: { id: bank.id, name: bank.name },
    fetchedAt: new Date().toISOString(),
  };

  const wantsDigital = Boolean(bank.getDigital) && command !== 'physical';
  const wantsPhysical = Boolean(bank.getPhysical) && command !== 'history';
  let digitalOptions = null;

  if (wantsDigital) {
    if (command === 'current') {
      digitalOptions = { includeCurrent: true, ranges: [] };
    } else if (command === 'history') {
      digitalOptions = { includeCurrent: false, ranges };
    } else {
      digitalOptions = { includeCurrent: true, ranges };
    }
  }

  const [digital, physical] = await Promise.all([
    digitalOptions ? loadDigital(bank, digitalOptions) : null,
    wantsPhysical ? loadPhysical(bank) : null,
  ]);

  if (digital) result.digital = digital;
  if (physical) {
    attachDigitalSpread(physical, digital?.current);
    result.physical = physical;
  }

  return result;
}

function markStatus(result) {
  const hasDigital = result.digital?.current?.price != null
    || Object.values(result.digital?.trends ?? {})
      .some((trend) => (trend.points?.length ?? 0) > 0);
  const hasPhysical = (result.physical?.quotes?.length ?? 0) > 0;
  const hasErrors = Boolean(result.digital?.errors?.length || result.physical?.errors?.length);
  const hasWarnings = Boolean(result.physical?.warnings?.length);

  if (!hasDigital && !hasPhysical) {
    result.status = 'error';
    result.error = '未获取到任何数据';
  } else if (hasErrors || hasWarnings) {
    result.status = 'partial';
  } else {
    result.status = 'ok';
  }
}

function formatError(error) {
  const details = [
    error.code == null ? null : `code=${error.code}`,
    error.httpStatus == null ? null : `http=${error.httpStatus}`,
  ].filter(Boolean);
  const prefix = error.scope ? `${error.scope}: ` : '';
  const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
  return `${prefix}${error.message}${suffix}`;
}

function printHuman(result) {
  const lines = [`${result.bank.name}  ${formatChinaTime(result.fetchedAt)}`];

  if (result.status !== 'ok') {
    lines.push(`状态: ${result.status}${result.error ? ` (${result.error})` : ''}`);
  }

  if (result.digital) {
    lines.push('', `数字黄金 · ${result.digital.productName} (${result.digital.productCode})`);

    if (result.digital.current) {
      lines.push(
        `  最新价: ${formatPrice(result.digital.current.price)} 元/克  (${formatChinaTime(result.digital.current.publishTime)})`,
      );
    }

    for (const trend of Object.values(result.digital.trends ?? {})) {
      const summary = trend.summary;
      if (!summary) {
        lines.push(`  ${trend.label}: 暂无数据`);
        continue;
      }

      const percent = summary.changePercent == null
        ? '--'
        : `${summary.changePercent > 0 ? '+' : ''}${summary.changePercent.toFixed(2)}%`;
      lines.push(
        `  ${trend.label}: ${formatPrice(summary.lastPrice)} 元/克  ${percent}  ${summary.count} 个点  (${formatChinaMinute(summary.startTime)} → ${formatChinaMinute(summary.endTime)})`,
      );
    }

    for (const error of result.digital.errors ?? []) {
      lines.push(`  ! ${formatError(error)}`);
    }
  }

  if (result.physical) {
    lines.push('', `实物黄金 · ${result.physical.productName}`);
    const serverTime = result.physical.quotes.find((quote) => quote.serverTime)?.serverTime;
    if (serverTime) lines.push(`  服务器时间: ${formatChinaTime(serverTime)}`);
    if (result.physical.priceDate) lines.push(`  价格日期: ${result.physical.priceDate}`);

    const saleWindow = formatSaleWindow(result.physical.saleWindow);
    for (const quote of result.physical.quotes) {
      const spread = quote.spreadVsDigital == null
        ? ''
        : `  vs 数字金 ${quote.spreadVsDigital > 0 ? '+' : ''}${quote.spreadVsDigital.toFixed(2)} 元/克`;
      const soldOut = quote.tradable === false && quote.remainingQuota === 0;
      const tradingState = soldOut
        ? '  [售罄]'
        : quote.tradable === false
          ? '  [停售]'
          : quote.tradable === null
            ? saleWindow
              ? `  [销售 ${saleWindow}]`
              : '  [交易状态未知]'
            : '';
      lines.push(
        `  ${quote.sku.padEnd(5)} ${formatPrice(quote.totalPrice).padStart(12)} 元/条  ${formatPrice(quote.pricePerGram)} 元/克${spread}${tradingState}`,
      );
    }

    for (const warning of result.physical.warnings ?? []) {
      lines.push(`  ~ ${formatError(warning)}`);
    }

    for (const error of result.physical.errors ?? []) {
      lines.push(`  ! ${formatError(error)}`);
    }
  }

  console.log(lines.join('\n'));
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      range: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  jsonMode = values.json;

  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (positionals.length > 2) {
    throw new Error('参数过多，请查看 --help');
  }

  const [first, second] = positionals;
  let bankId;
  let command;

  if (!first) {
    if (second) throw new Error(`缺少银行或命令: ${second}`);
    bankId = 'pingan';
    command = 'current';
  } else if (COMMANDS.has(first)) {
    if (second) throw new Error(`命令 ${first} 后不能再跟参数: ${second}`);
    bankId = 'pingan';
    command = first;
  } else {
    bankId = first;
    command = second ?? 'current';
  }

  const bank = BANKS.get(bankId);
  if (!bank) {
    throw new Error(`未知银行: ${bankId}（可选: ${[...BANKS.keys()].join(', ')}）`);
  }
  if (!COMMANDS.has(command)) {
    throw new Error(`未知命令: ${command}（可选: ${[...COMMANDS].join(', ')}）`);
  }
  if (command === 'history' && !bank.getDigital) {
    throw new Error(`${bank.name}暂不支持数字金走势`);
  }
  if (command === 'physical' && !bank.getPhysical) {
    throw new Error(`${bank.name}暂不支持实物金报价`);
  }
  if (!bank.getDigital && !bank.getPhysical) {
    throw new Error(`${bank.name}暂不支持任何黄金报价`);
  }
  if (values.range?.length && !bank.ranges) {
    throw new Error(`${bank.name}不支持 --range`);
  }
  if (values.range?.length && (command === 'current' || command === 'physical')) {
    throw new Error(`${command} 命令不支持 --range`);
  }

  const ranges = bank.getDigital && (command === 'history' || command === 'all')
    ? parseRanges(values.range, bank)
    : [];
  const result = await loadResult(bank, command, ranges);
  markStatus(result);

  if (result.status === 'error') process.exitCode = 1;

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printHuman(result);
  }
}

main().catch((error) => {
  const info = serializeError(error);

  if (jsonMode) {
    const body = { status: 'error', error: info.message };
    for (const key of ['code', 'httpStatus', 'retryable']) {
      if (info[key] != null) body[key] = info[key];
    }
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  } else {
    console.error(`错误: ${info.message}`);
  }
  process.exitCode = 1;
});
