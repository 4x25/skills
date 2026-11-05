# 工商银行实物金接口

抓包日期：2026-11-05。接口为网页端实际调用，POST JSON，无需登录、Cookie 或签名；`sessionId` 传空字符串即可。

Base URL：`https://mywap2.icbc.com.cn/ICBCWAPBankB5/physicalPreciousMetals`

## TLS 兼容性

`mywap2.icbc.com.cn` 要求旧版 TLS 重协商兼容。Node.js 内置 `fetch`（undici）会报：

```text
unsafe legacy renegotiation disabled
```

因此工商银行模块使用 `node:https`，并在请求级设置：

```js
secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT
```

该选项只作用于 `scripts/lib/legacy-https.mjs`，且 helper 只允许访问 `mywap2.icbc.com.cn`，不修改全局 TLS 设置，也不影响平安银行。请求使用 `AbortSignal.timeout()` 控制总时限，并限制响应体大小为 2MB。

## 商品发现

```text
POST /queryPreciousMetalsGoodsInfo
Content-Type: application/json
```

请求：

```json
{
  "sessionId": "",
  "qryType": "2",
  "pageNo": 1,
  "pageSize": 50,
  "operType": "2"
}
```

响应中的 `itemList[]` 包含商品名称和 `itemSeqNo`。目标商品：

```json
{
  "itemName": "如意金条",
  "itemSeqNo": "GOOD246112600024",
  "itemSubtitle": "5克起 | Au999.9",
  "classifyName": "投资金"
}
```

备用商品代码：`GOOD246112600024`。若列表接口失败或找不到商品，脚本会使用该代码并产生 warning；详情返回后还会校验 `itemName` 和 `itemSeqNo`，不匹配则报错，避免把其他商品当成如意金条。

## 商品详情与规格报价

```text
POST /queryGoodsDetails
Content-Type: application/json
```

请求：

```json
{
  "sessionId": "",
  "itemSeqNo": "GOOD246112600024",
  "specSeqNo": "",
  "ejectSellerCode": ""
}
```

顶层字段：

| 字段 | 说明 |
| --- | --- |
| `retCode` | `"0"` 表示成功 |
| `retMsg` | 提示信息 |
| `itemName` | 商品名称，例如 `如意金条` |
| `itemSeqNo` | 商品代码 |
| `itemSubtitle` | 例如 `5克起 | Au999.9` |
| `busiDate` | 业务日期，`YYYY-MM-DD` |
| `dailySaleStartTime` | 每日销售开始时间，例如 `09:10:00` |
| `dailySaleEndTime` | 每日销售结束时间，例如 `22:30:00` |
| `specificationList[]` | 全部规格及报价 |

`specificationList[]` 关键字段：

| 字段 | 说明 |
| --- | --- |
| `specName` | 规格名称，例如 `金10g` |
| `specSeqNo` | 规格代码 |
| `salePriceByPiece` | 每条总价，元 |
| `salePriceByWeight` | 每克售价，元/克 |
| `prodBasicPrice` | 基础金价，元/克 |
| `prodCode` | 商品代码 |
| `pptxnno` | 页面展示的“产品交易代码” |
| `residualQuota` | 剩余额度 |
| `quotaFlag` | 是否启用额度控制 |

目标规格：`金10g`、`金20g`、`金50g`、`金100g`。忽略 `金5g`、`金200g` 等其他规格。`pricePerGram` 优先使用 `salePriceByWeight`，缺失或非正时回退为 `salePriceByPiece / 克重`。输出的 `productCode` 优先取 `pptxnno`（产品交易代码），缺失时回退 `prodCode` 或 `specSeqNo`。

抓包样本（2026-11-05）：

| 规格 | 总价 | 每克售价 | pptxnno |
| --- | --- | --- | --- |
| 金10g | 9,008.70 | 900.87 | 050100002 |
| 金20g | 17,997.40 | 899.87 | 050100003 |
| 金50g | 44,993.50 | 899.87 | 000010050 |
| 金100g | 89,987.00 | 899.87 | 000010100 |

## 页面入口

```text
https://mywap2.icbc.com.cn/ICBCWAPBankB5/physicalPreciousMetals/index.html?hideTitle=1#/precious_metal_product_detail
```

直接打开该 URL 且不带商品参数时页面会提示“找不到该商品”；正常路径是从列表页点击“如意金条”，或使用带 `itemSeqNo` 的链接。

## 状态说明

- 工商详情接口没有明确的 `saleStatus` 字段，脚本固定输出 `saleStatus: null`。
- 仅当 `quotaFlag` 启用（`1`）且 `residualQuota <= 0` 时，脚本将 `tradable` 设为 `false` 并输出 `quotaControlled: true`；其余情况 `tradable` 为 `null`，并返回 `saleWindow` 供调用方判断。
- `busiDate` 是接口的业务日期，不是请求时间；脚本输出为 `priceDate`。

## 维护提示

- 这些是网页内部接口，不是公开 API，可能无通知变更。
- 若商品代码变化，优先从 `queryPreciousMetalsGoodsInfo` 的 `itemList` 重新发现；备用代码在 `scripts/banks/icbc.mjs` 中维护。
- 请求频率保持克制，避免对银行接口造成压力。
