#!/usr/bin/env node

import { parseArgs } from 'node:util';
import * as pingan from './banks/pingan.mjs';
import { ExchangeApiError, serializeError } from './lib/errors.mjs';
import { formatChinaTime } from './lib/time.mjs';

export const BANKS = new Map([
  [pingan.bank.id, {
    ...pingan.bank,
    currencies: pingan.CURRENCIES,
    ranges: pingan.RANGES,
    allRanges: pingan.ALL_RANGES,
    getCurrent: pingan.getCurrent,
    getHistory: pingan.getHistory,
  }],
]);
const COMMANDS = new Set(['current', 'history', 'all']);

const USAGE = `用法:
  node scripts/exchange-rate.mjs [银行] [命令] [选项]

银行:
  pingan                平安银行

命令:
  current               当前购汇 / 结汇报价（默认；默认返回全部币种）
  history               每日历史报价和参考中间价（需指定 --currency）
  all                   当前报价 + 区间走势（需指定 --currency）

选项:
  --currency <列表>     币种代码或中文名称，支持重复传入 / 逗号分隔 / all
                        USD,HKD,GBP,JPY,EUR,AUD,NZD,CHF,SGD,CAD
  --range <列表>        history/all 的区间，支持重复传入 / 逗号分隔
                        1m,3m,6m,1y,all（默认 all；30/90/180/365 天）
  --json                输出 JSON
  -h, --help            显示帮助

示例:
  node scripts/exchange-rate.mjs pingan current --json
  node scripts/exchange-rate.mjs current --currency 美元,日元 --json
  node scripts/exchange-rate.mjs pingan history --currency USD --range 1m,1y --json
  node scripts/exchange-rate.mjs pingan all --currency USD,JPY --json

报价单位: 人民币元 / 100 外币。购汇 = 客户买外币；结汇 = 客户卖外币。
`;

export function parseOptions(args, banks = BANKS) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      currency: { type: 'string', multiple: true },
      range: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return { help: true, json: values.json };
  if (positionals.length > 2) invalid('参数过多，请查看 --help');
  const [first, second] = positionals.map(value => value.toLowerCase());
  const bankId = !first || COMMANDS.has(first) ? 'pingan' : first;
  const command = COMMANDS.has(first) ? first : second ?? 'current';
  if (COMMANDS.has(first) && second) invalid(`命令 ${first} 后不能再跟参数: ${second}`);

  const bank = banks.get(bankId);
  if (!bank) invalid(`未知银行: ${bankId}（可选: ${[...banks.keys()].join(', ')}）`);
  if (!COMMANDS.has(command)) invalid(`未知命令: ${command}（可选: ${[...COMMANDS].join(', ')}）`);
  if (command === 'current' && values.range) invalid('current 命令只查询最新报价，--range 用于 history/all');
  if (command !== 'current' && !values.currency) {
    invalid(`${command} 请通过 --currency 指定币种；全部币种使用 --currency all`);
  }

  const selected = parseCurrencies(values.currency, bank);
  const currencies = command === 'current' ? selected : selected ?? Object.keys(bank.currencies);
  const ranges = command === 'current' ? [] : parseRanges(values.range, bank);
  return { bank, command, currencies, ranges, json: values.json, help: false };
}

export async function loadResult({ bank, command, currencies, ranges, now = new Date() }) {
  const result = {
    bank: { id: bank.id, name: bank.name },
    fetchedAt: now.toISOString(),
    baseAmount: bank.baseAmount,
    quoteCurrency: bank.quoteCurrency,
  };
  // Complete the single current request before starting the three history workers.
  if (command !== 'history') {
    try {
      result.current = await bank.getCurrent({ currencies });
    } catch (error) {
      result.current = { updateTime: null, quotes: [], warnings: [], errors: [serializeError(error, 'current')] };
    }
  }
  if (command !== 'current') {
    try {
      result.history = await bank.getHistory({ currencies, ranges, now });
    } catch (error) {
      result.history = { trends: {}, warnings: [], errors: [serializeError(error, 'history')] };
    }
  }

  const hasData = Boolean(result.current?.quotes.length)
    || Object.values(result.history?.trends ?? {})
      .some(trends => Object.values(trends).some(trend => trend.points.length > 0));
  const incomplete = [result.current, result.history]
    .some(section => section?.errors.length || section?.warnings.length);
  result.status = hasData ? incomplete ? 'partial' : 'ok' : 'error';
  if (!hasData) result.error = '未获取到任何有效汇率数据';
  return result;
}

export function formatHuman(result) {
  const lines = [
    `${result.bank.name}  抓取时间: ${formatChinaTime(result.fetchedAt)} (UTC+8)`,
    `单位: 人民币元 / ${result.baseAmount} 外币；购汇 = 客户买外币，结汇 = 客户卖外币`,
  ];
  if (result.status !== 'ok') lines.push(`状态: ${result.status}${result.error ? ` (${result.error})` : ''}`);
  if (result.current) {
    lines.push('', `当前报价  银行更新时间: ${formatChinaTime(result.current.updateTime)} (UTC+8)`);
    for (const quote of result.current.quotes) {
      lines.push(`  ${quote.currencyName} (${quote.currency})  购汇 ${rate(quote.purchaseRate)}  结汇 ${rate(quote.settlementRate)}  价差 ${rate(quote.spread)}`);
    }
    appendIssues(lines, result.current);
  }
  if (result.history) {
    lines.push('', '历史每日报价；日终参考中间价采用银行返回值，实际成交以银行交易报价为准');
    for (const trends of Object.values(result.history.trends)) {
      for (const trend of Object.values(trends)) {
        lines.push(`  ${trend.currencyName} (${trend.currency}) · ${trend.label}  查询 ${trend.startDate} → ${trend.endDate}  ${trend.points.length} 个点`);
        for (const [key, label] of [['purchase', '购汇'], ['settlement', '结汇'], ['middle', '参考中间价']]) {
          const summary = trend.summary[key];
          if (!summary) {
            lines.push(`    ${label}: 暂无数据`);
            continue;
          }
          const sign = summary.changePercent > 0 ? '+' : '';
          lines.push(`    ${label}: ${rate(summary.firstRate)} → ${rate(summary.lastRate)}  ${sign}${summary.changePercent.toFixed(2)}%  最低 ${rate(summary.minRate)} / 最高 ${rate(summary.maxRate)}  (${summary.startDate} → ${summary.endDate})`);
        }
      }
    }
    appendIssues(lines, result.history);
  }
  return lines.join('\n');
}

export async function main(args = process.argv.slice(2)) {
  let jsonMode = args.includes('--json');
  try {
    const options = parseOptions(args);
    jsonMode = options.json;
    if (options.help) {
      console.log(USAGE);
      return;
    }
    const result = await loadResult(options);
    console.log(jsonMode ? JSON.stringify(result, null, 2) : formatHuman(result));
    if (result.status === 'error') process.exitCode = 1;
  } catch (error) {
    const info = serializeError(error);
    const { message, ...details } = info;
    if (jsonMode) console.log(JSON.stringify({ status: 'error', error: message, ...details }, null, 2));
    else console.error(`错误: ${message}`);
    process.exitCode = 1;
  }
}

function parseCurrencies(rawValues, bank) {
  if (!rawValues) return null;
  const aliases = new Map(Object.entries(bank.currencies).flatMap(([code, definition]) => (
    [code, definition.name, ...definition.aliases].map(alias => [alias.toLowerCase(), code])
  )));
  const tokens = splitValues(rawValues, '--currency');
  const currencies = tokens.map(token => {
    if (token === 'all') return token;
    const code = aliases.get(token);
    if (!code) invalid(`未知币种: ${token}（可选: ${Object.keys(bank.currencies).join(', ')}, all）`);
    return code;
  });
  return currencies.includes('all') ? null : [...new Set(currencies)];
}

function parseRanges(rawValues, bank) {
  if (!rawValues) return [...bank.allRanges];
  const ranges = splitValues(rawValues, '--range');
  for (const range of ranges) {
    if (range !== 'all' && !Object.hasOwn(bank.ranges, range)) {
      invalid(`未知区间: ${range}（可选: ${bank.allRanges.join(', ')}, all）`);
    }
  }
  return ranges.includes('all') ? [...bank.allRanges] : [...new Set(ranges)];
}

function splitValues(rawValues, option) {
  const tokens = rawValues.flatMap(value => value.split(/[,，]/u))
    .map(value => value.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) invalid(`${option} 不能为空`);
  return tokens;
}

function invalid(message) {
  throw new ExchangeApiError(message, { code: 'INVALID_ARGUMENT' });
}

function rate(value) {
  return value == null ? '--' : value.toFixed(4);
}

function appendIssues(lines, section) {
  for (const [issues, prefix] of [[section.warnings, '~'], [section.errors, '!']]) {
    for (const issue of issues) {
      const details = [issue.code && `code=${issue.code}`, issue.httpStatus && `http=${issue.httpStatus}`].filter(Boolean);
      lines.push(`  ${prefix} ${issue.scope}: ${issue.message}${details.length ? ` (${details.join(', ')})` : ''}`);
    }
  }
}

if (import.meta.main) await main();
