---
name: gold-price
description: 查询银行实物黄金和数字黄金的最新价格与区间价格走势。当前支持平安银行数字金“平安金活期”和实物金“平安浇铸金条”（10g/20g/50g/100g），以及工商银行实物金“如意金条”（10g/20g/50g/100g）。当用户询问平安/工商银行金价、黄金价格走势、金条报价、数字黄金与实物黄金价差时使用。
---

# 黄金价格

查询银行黄金报价。数据直接来自银行网页实际调用的接口，不需要浏览器或登录，也没有第三方依赖。需要 Node.js 20+；当前 LTS 26 可直接运行。

## 支持的银行

| 银行 | 数字金 | 实物金 |
| --- | --- | --- |
| 平安银行 `pingan` | 平安金活期（实时 / 近1月 / 近3月 / 近6月 / 近1年） | 平安浇铸金条（10g / 20g / 50g / 100g） |
| 工商银行 `icbc` | — | 如意金条（10g / 20g / 50g / 100g） |

`history` 只适用于提供数字金的银行；工商银行目前只有实物金报价。

## 使用方式

在本技能目录下运行：

```bash
# 平安：数字金最新价 + 实物金 4 个 SKU（默认命令）
node scripts/gold-price.mjs pingan current --json

# 平安：数字金全部区间走势
node scripts/gold-price.mjs pingan history --json

# 平安：指定区间
node scripts/gold-price.mjs pingan history --range 1m,3m --json

# 工商：实物金 4 个 SKU
node scripts/gold-price.mjs icbc physical --json

# 工商：current 也只会返回实物金
node scripts/gold-price.mjs icbc current --json

# 某家银行可用的全部数据
node scripts/gold-price.mjs pingan all --json
node scripts/gold-price.mjs icbc all --json
```

`--json` 输出结构化数据；去掉后输出便于阅读的摘要。`pingan` 可省略，默认就是平安银行；命令省略时默认为 `current`。`--range` 只用于提供数字金的银行的 `history` 和 `all`。

## 输出说明

顶层字段：

| 字段 | 说明 |
| --- | --- |
| `status` | `ok`、`partial`（部分接口失败、数据不完整或存在 warning）或 `error`（完全没有数据） |
| `fetchedAt` | 本次抓取时间，UTC ISO 8601 |
| `bank` | 银行 id 和名称 |

分节错误位于 `digital.errors` 和 `physical.errors`，结构为 `{ scope, message, code?, httpStatus?, retryable? }`。参数错误等致命错误输出 `{ status: "error", error, code?, httpStatus?, retryable? }`。

数字金（仅平安）：

- `digital.current`：最新报价；接口失败时为 `null`。
- `digital.current.price`：单位元/克，`publishTime` 为报价发布时间（UTC+8）。
- `digital.trends.<range>`：区间走势，键为 `realtime`、`1m`、`3m`、`6m`、`1y`；失败的区间会缺失并记录在 `errors`。区间存在但无数据时 `points` 为空数组、`summary` 为 `null`。
- `points`：按时间升序的价格点；`summary` 含区间首尾价、涨跌额、涨跌幅、最低/最高价。

实物金：

- `physical.quotes[]`：每个 SKU 的 `totalPrice`（元/条）、`pricePerGram`（元/克）、`tradable`（`true`/`false`/`null`）。
- `physical.warnings[]`：例如未发现某个规格；存在 warning 时 `status` 为 `partial`。
- `physical.errors[]`：单个 SKU 失败时记录，其他 SKU 仍会返回。
- `spreadVsDigital`：实物金每克价格相对数字金最新价的溢价，单位元/克；仅在同一响应包含数字金最新价时出现（目前只有平安）。
- 平安额外提供 `serverTime`（请求时银行服务器时间，不是价格发布时间）。
- 工商额外提供 `itemSeqNo`、`priceDate`（业务日期）、`saleWindow`（每日销售时段）、`quotaControlled`（是否启用额度控制）、`remainingQuota`（剩余额度）和 `specSeqNo`。工商接口没有 `saleStatus`，该字段固定为 `null`。

平安报价时间为中国标准时间（UTC+8）的 ISO 8601 格式；工商只提供 `priceDate`（日期）和 `saleWindow`（无时区的本地时刻）。`fetchedAt` 为 UTC。

## 解读

- 平安金活期是数字黄金，可在手机银行实时交易。所谓“实时”报价实际约每 5 分钟更新一次，不是逐笔行情；回答时应同时给出 `publishTime`。
- 平安浇铸金条是实物黄金，按条报价；实物金通常高于数字金，具体价差以 `spreadVsDigital` 为准，会随行情变化。
- 工商银行如意金条是实物黄金，按条报价；`pricePerGram` 优先取接口的 `salePriceByWeight`，缺失或非正时用 `totalPrice / weightGrams` 计算；`priceDate` 是业务日期。
- 工商银行接口没有返回明确的交易状态，`tradable` 通常为 `null`；仅当 `quotaControlled` 为 `true` 且 `remainingQuota <= 0` 时标记为 `false`。销售时段见 `saleWindow`。
- 实物金 SKU 通过各银行商品详情接口的规格列表发现，只保留 10g、20g、50g、100g 四个规格。
- 平安和工商的实物金页面都不提供历史走势接口；`history` 只返回数字金走势，不要为实物金编造历史价格。

## 注意

- 接口为银行内部网页接口，可能随时调整；字段变化时参考 `references/pingan-api.md` 或 `references/icbc-api.md` 重新抓包。
- 报价有交易时段限制（平安数字金周一至周五 9:30-17:00，平安实物金 9:30-15:30；工商实物金以返回的 `saleWindow` 为准，节假日除外），非交易时段返回最近一次报价。
- 请控制请求频率，避免频繁轮询；银行分节各自最多 3 个并发请求，`all` 时可能并行，峰值约 6 个。网络错误和 5xx 会做有限重试。
- 工商银行 `mywap2.icbc.com.cn` 需要旧版 TLS 重协商兼容；脚本仅在 `legacy-https.mjs` 中对该请求启用 `SSL_OP_LEGACY_SERVER_CONNECT`，不影响其他银行。

## 扩展其他银行

1. 在 `scripts/banks/` 新增 `<bank>.mjs`，导出：
   - `bank`：`{ id, name }`
   - `getDigital({ ranges, includeCurrent })`（可选，仅数字金银行）
   - `getPhysical()`（可选）
   - `RANGES` / `ALL_RANGES`（可选，仅数字金银行）
2. 在 `scripts/gold-price.mjs` 的 `BANKS` 注册表中注册；只注册该银行实际支持的能力。
3. 保持与现有模块相同的输出结构；在 `references/` 记录接口、参数和字段映射。
