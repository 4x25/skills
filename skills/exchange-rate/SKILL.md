---
name: exchange-rate
description: 查询银行购汇、结汇报价与区间汇率走势。当前支持平安银行美元、港元、英镑、日元、欧元、澳元、纽币、瑞郎、新元和加元。当用户询问银行汇率、外汇牌价、买入或卖出外币的价格、购汇结汇价差、外币兑换人民币金额、近一月到一年的汇率趋势时使用。
---

# 银行汇率

使用银行网页实际调用的接口查询报价。需要 Node.js 26（LTS），使用内置 `fetch`，无需安装依赖、登录或启动浏览器。

## 支持范围

| 银行 | 币种 | 趋势区间 |
| --- | --- | --- |
| 平安银行 `pingan` | USD 美元、HKD 港元、GBP 英镑、JPY 日元、EUR 欧元、AUD 澳元、NZD 纽币、CHF 瑞郎、SGD 新元、CAD 加元 | `1m` 近一月、`3m` 近三月、`6m` 近半年、`1y` 近一年 |

先确认用户要查询的银行、币种和购汇／结汇方向。其他银行需使用对应数据源，不能用平安报价代替。

## 使用方式

在本技能目录下运行：

```bash
# 当前全部 10 种外币的购汇 / 结汇报价（默认命令）
node scripts/exchange-rate.mjs pingan current --json

# 指定币种；代码不区分大小写，也接受中文名称和常见别名
node scripts/exchange-rate.mjs current --currency USD,EUR,JPY --json
node scripts/exchange-rate.mjs current --currency 美元,日元 --json

# 指定币种的全部四个趋势区间
node scripts/exchange-rate.mjs pingan history --currency USD --json

# 指定区间
node scripts/exchange-rate.mjs pingan history --currency USD,JPY --range 1m,1y --json

# 当前报价 + 全部趋势区间
node scripts/exchange-rate.mjs pingan all --currency USD --json

# 明确查询全部币种、全部区间（1 个当前请求 + 40 个历史请求）
node scripts/exchange-rate.mjs pingan all --currency all --json
```

`pingan` 可省略，命令默认为 `current`。`current` 默认查询全部币种；`history` 和 `all` 需要显式指定 `--currency`，以免一次普通查询产生 40 个历史请求。`--currency` 和 `--range` 支持重复传入、英文或中文逗号分隔、`all`。`--range` 只用于 `history`／`all`，默认全部四个区间。去掉 `--json` 可查看文字摘要。

## 报价方向与单位

- `purchaseRate`：客户购汇，人民币买入外币，对应银行 `sellingRate`（银行卖出外币）。
- `settlementRate`：客户结汇，外币卖给银行换人民币，对应银行 `buyingRate`（银行买入外币）。
- 所有原始报价和历史汇率的单位均为 **人民币元／100 外币**，日元也按 100 日元报价。
- 当前报价的 `purchasePerUnit`／`settlementPerUnit` 已除以 100，单位为人民币元／1 外币。
- `spread` 是购汇价减结汇价，单位为人民币元／100 外币。

按外币金额 `amount` 估算：购汇需支付 `amount * purchaseRate / 100` 元；结汇可获得 `amount * settlementRate / 100` 元。按人民币预算购汇：外币数量约为 `cnyAmount * 100 / purchaseRate`。最后一步才四舍五入，人民币金额通常保留两位小数，注明为牌价估算，实际成交价和费用以银行为准。

平安页面声明“现钞现汇同价”，接口只提供一组购汇／结汇报价。按页面口径回答，并保留渠道及实际成交可能不同的提示。

## 输出结构

| 字段 | 说明 |
| --- | --- |
| `status` | `ok`、`partial`（部分失败或有数据警告）、`error`（没有有效报价或趋势数据） |
| `bank` | 银行 id 和名称 |
| `fetchedAt` | 本机抓取时间，UTC ISO 8601 |
| `baseAmount` / `quoteCurrency` | 原始报价基数 `100`、计价货币 `CNY` |
| `current.updateTime` | 银行返回的列表更新时间，UTC+8；不是各币种独立的报价发布时间 |
| `current.quotes[]` | 币种、名称、购汇价、结汇价、每单位外币价格、买卖价差 |
| `history.trends.<币种>.<区间>` | 指定币种的历史区间，例如 `history.trends.USD.1m` |
| `current/history.warnings[]` | 缺失币种、无效字段、空区间等数据警告 |
| `current/history.errors[]` | `{ scope, message, code?, httpStatus?, retryable? }` |

每个趋势区间包含：

- `label`、`currency`、`currencyName`、`basis: "daily"`。
- `startDate`／`endDate`：实际请求的日期范围。银行页签按 **30／90／180／365 天** 回溯，不是自然月。
- `updateTime`：历史接口响应的更新时间（UTC+8），不是最后一个历史点的日期。
- `points[]`：按日期升序，每个点包含 `date`、`purchaseRate`、`settlementRate`、`middleRate`。
- `summary.purchase`／`summary.settlement`／`summary.middle`：分别汇总每日购汇报价、结汇报价、参考中间价；含首末日期、首末汇率、涨跌额、涨跌幅、最低／最高值和有效点数。

## 解读与回答

1. 当前报价优先读取 `current`，同时给出币种、购汇／结汇方向、100 外币单位及银行 `updateTime`。银行更新时间缺失时明确说明，不用 `fetchedAt` 冒充。
2. 趋势数据是每日历史报价；网页曲线绘制的是 `middleRate` 日终参考中间价。接口没有三项报价各自的采样时刻，不能断言严格同时收盘采样。回答走势时说清采用购汇、结汇还是中间价序列，不能把参考中间价当实际成交价。
3. 保留银行原始 `middleRate`。抓包中它与同一记录的买卖价算术平均数可能不同；不要用均值覆盖、也不要根据当前价反推历史中间价。
4. 历史接口的 `currentBuyingRate`／`currentSellingRate` 没有进入输出；查询最新购汇／结汇报价始终使用当前列表接口。
5. 历史日期只有日期精度，保留 `YYYY-MM-DD`，不补造收盘时刻。周末可能重复前值，保留银行返回的日期记录。
6. 部分字段无效时对应汇率为 `null` 并有警告；各序列的汇总仅使用其有效点。失败的区间缺失并记录错误；空区间有空 `points` 和三项 `null` 汇总。检查 `status` 及警告／错误后再回答，不把缺失报价当零。

## 测试与维护

```bash
# 离线测试：参数、字段映射、单位、日期、汇总、重试及部分失败
node --test tests/*.test.mjs

# 真实银行接口：全部 10 币种、全部 4 区间
FX_LIVE_TEST=1 node --test tests/live.test.mjs
```

请求最多 3 个并发，每个请求超时 15 秒；网络错误、429 和 5xx 最多尝试 3 次，普通业务错误直接报告。避免频繁轮询。`partial` 保留可用数据并正常退出；`error` 和参数错误退出码为 1。

接口为银行内部网页接口，可能调整。字段或参数变化时阅读 `references/pingan-api.md`，重新打开页面并切换币种、区间抓包核对。

## 扩展银行

在 `scripts/banks/<银行>.mjs` 实现 `bank`、`CURRENCIES`、`RANGES`、`ALL_RANGES`、`getCurrent({ currencies })`、`getHistory({ currencies, ranges, now })`，在 `scripts/exchange-rate.mjs` 的 `BANKS` 注册；以客户购汇／结汇方向归一化报价，在 `references/` 记录真实接口，并补充测试。各银行报价基数由 `bank.baseAmount` 标明。
