# 招商银行黄金接口

抓包日期：2026-11-24。接口为手机银行 H5 页面实际调用，无需登录、Cookie 或签名，只需常规 JSON/Form 请求头；`zxlCod` 参数例外（见下文）。脚本只显式设置 `Accept: application/json` 和带标识的 `User-Agent`。

页面入口：`https://mbmodulecdn.cmbimg.com/mb5web/tabmetaldefault.html`（黄金频道）。

## 数字黄金：招行黄金活期（灵活买卖）

数据来自频道页的“灵活买卖”模块（黄金活期，1克起购、实时报价）。

```text
POST https://mbmodule-openapi.paas.cmbchina.com/product/v2/module/met-deal
Content-Type: application/x-www-form-urlencoded
```

请求体为单键表单，`params` 的值是整个 JSON 字符串：

```text
params={"pageID":"47E5BC8D-207E-38AD-AAEB-B4F09C268D29","moduleID":"DBFBA590-7121-3487-AE59-FA78BF1DC7F8","extraParam":{}}
```

响应外层 `{code, data, msg, success}`，`code` 为 `SUC0000` 且 `success` 为 `true` 表示成功。价格位于 `data.bizInfo.MetalPrice`：

| 字段 | 说明 |
| --- | --- |
| `zBuyPrc` | 实时买入价，元/克；页面“实时买入价”，即客户向银行买入（银行卖出价） |
| `zSelPrc` | 客户卖出价（银行买入价），元/克 |
| `zDifCur` / `zPrcDif` | 今日涨跌幅，%，如 `-0.52`；页面“涨跌幅数据-今日”读此字段 |
| `zDvlCur` | 今日涨跌额，元/克（如 `-4.11`）；页面显示在价格旁边，脚本不采集 |
| `zDifMo1` | 近1月涨跌幅，% |
| `zDifMo2` | 近3月涨跌幅，% |
| `zDifMo3` | 近6月涨跌幅，%（页面未展示，脚本不采集） |
| `zDifMo4` | 近1年涨跌幅，% |

注意 `zDifCur` 与 `zDvlCur` 数值可能巧合接近，但语义不同：前者是百分比，后者是元/克。今日基准价可由 `zBuyPrc - zDvlCur` 推算（如 787.71 - (-4.11) = 791.82），`zDvlCur / 基准价` 与 `zDifCur` 一致，可作交叉校验。

接口不返回报价时间戳，`publishTime` 固定为 `null`。涨跌幅是单点数值而非走势序列，因此招行的数字金没有 `trends`，只有 `changes`（`digital.changes.<range>.changePercent`）。

注意：该接口偶发返回 `{"code":"MDU0902","msg":"系统处理异常","success":false}`，HTTP 状态仍是 200。脚本在 `scripts/banks/cmb.mjs` 的 `postModuleForm` 中对 `MDU0902` 最多尝试 3 次（含首次请求）。

## 实物金条：高性价比金条

频道页“实物金条”板块（`实物金条金币`）通过模块接口返回推荐位列表：

```text
POST https://mbmodule-openapi.paas.cmbchina.com/product/v2/module/met-phy
Content-Type: application/x-www-form-urlencoded
```

请求体同上，`moduleID` 为 `C8207F8B-7A0B-3E88-B853-A9BA9E092309`。

`data.moduleRepeatList[]` 中 `PrdName` 或 `PrdDes` 含“高性价比金条”的推荐位即目标商品（目前为“富贵圆满招行金投资金条”）：

```json
{
  "PrdName": "富贵圆满招行金投资金条",
  "PrdDes": "高性价比金条，精美细腻",
  "GSplCod": "FJ003",
  "GPrdCod": "GLD0318",
  "GPrdStd": "K0010",
  "GZxlCod": "XL0017"
}
```

备用商品：`FJ003` / `GLD0318` / `K0010`（推荐位发现失败时使用，并产生 warning）。

### 商品详情与 SKU 报价

```text
POST https://mobile.cmbchina.com/igoldsilver/gold-silver-detail/query-product-detail
Content-Type: application/json
```

请求：

```json
{
  "bbkNbr": "571",
  "outFlag": "Y",
  "orderDetailJumpFlag": "",
  "changeJumpFlag": "",
  "prdDsc": "",
  "splCod": "FJ003",
  "prdTyp": "GLD",
  "prdCod": "GLD0318",
  "prdStd": "K0010",
  "fromAttentionList": ""
}
```

响应外层 `{sysCode, sysMsg, bizResult}`，`bizResult.code` 为 `200` 表示成功，数据在 `bizResult.data`。

**`zxlCod` 必须省略或与商品完全匹配，传错会返回 `code: 500` 的“查询失败”**；省略时响应的 `productDetail.zxlCod` 会给出正确值，脚本直接不发送。

关键结构：

| 字段 | 说明 |
| --- | --- |
| `productDetail` | 当前请求规格的详情；`price` 为该规格总价（含千分位逗号） |
| `productDetail.productStandardList[]` | 全部可选规格：`standards`（如 `K0010`）、`standardsDescription`（如 `10克`） |
| `detailInfoList[]` | 全部规格的报价明细，一次请求即可拿到所有 SKU 价格 |

`detailInfoList[]` 关键字段：

| 字段 | 说明 |
| --- | --- |
| `standards` / `standardsDescription` | 规格代码（`K0010`）与克重文案（`10克`） |
| `price` | 该规格总价，元；数字或含千分位的字符串 |
| `productName` | 商品名（同规格可能有刻字款等多个商品） |
| `zxlDefaultFlag` | `Y` 为该系列默认款；同克重多个商品时优先取默认款 |
| `saleFlag` | `Y` 在售 |
| `buyStatus` | `E` 可购买；已观察到 `A`（非交易时段等场景） |
| `startTime` / `endTime` | 销售时段，`HHmmss`，如 `093000` / `153000` |
| `earliestShippingDate` | 最早发货日期 |

`startTime`/`endTime` 在部分商品（如 `GLD0035`）的 `productDetail` 上，在另一些商品（如 `GLD0318`）的 `detailInfoList[]` 项上；脚本两处都会尝试。

规格代码 `K00nn` 中 `nn` 即克重（`K0010`=10g、`K0020`=20g、`K0050`=50g、`K0100`=100g）。只保留 10g、20g、50g、100g，忽略 200g/500g/1000g。

`productCode` 输出为 `供应商代码 + 商品代码 + 规格代码` 拼接（如 `FJ003GLD0318K0010`），与接口 `serialStandardPrdList` 中的 SKU 标识一致。

`tradable`：`saleFlag === 'Y' && buyStatus === 'E'` 时为 `true`；`saleFlag === 'N'` 或 `buyStatus` 为 `S`/`F` 时为 `false`；其余（如非交易时段观察到的 `buyStatus: 'A'`）为 `null`。销售时段输出为 `saleWindow`（如 `09:30-15:30`）。

抓包样本（2026-11-24，富贵圆满招行金投资金条）：

| 规格 | 总价 | 元/克 |
| --- | --- | --- |
| 10g | 7,962.30 | 796.23 |
| 20g | 15,924.60 | 796.23 |
| 50g | 39,686.50 | 793.73 |
| 100g | 79,373.00 | 793.73 |

### 相关但未使用的接口

详情页还会调用（均无需登录，脚本未使用）：

- `GET /igoldsilver/base/unlogin/msid` — 会话 id
- `POST /igoldsilver/gold-silver-detail/all-day-product` — 全天候销售标签与时段
- `POST /igoldsilver/attention/get-attention-status` — 关注状态

## 与其他银行的差异

- 招行数字金只有当前价 + 4 个区间涨跌幅（今日/近1月/近3月/近1年），没有走势点序列，也不返回报价时间。
- 实物金固定取“高性价比金条”推荐位商品（平安、工商则是各自唯一投资金条商品）。
- 一次详情请求即可获得全部 SKU 价格，无需逐规格请求。
- 实物金接口无 `saleStatus`（平安语义）也无 `quotaControlled`（工商语义）；在售判断用 `saleFlag` + `buyStatus`。

## 维护提示

- 这些是 H5 页面内部接口，可能无通知变更。
- `pageID` / `moduleID` 是频道页配置的模块标识，若失效可重新抓包：浏览器打开 `tabmetaldefault.html`，在 XHR 里找 `met-deal` / `met-phy` 请求即可看到当前值。
- 若“高性价比金条”推荐位换商品，`met-phy` 的 `moduleRepeatList` 会自动发现新商品代码；备用代码在 `scripts/banks/cmb.mjs` 的 `FALLBACK_PHYSICAL` 中维护。
- 请求频率保持克制，避免对银行接口造成压力。
