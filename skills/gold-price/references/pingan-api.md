# 平安银行黄金接口

抓包日期：2026-11-05。以下接口均为网页端实际调用，GET 请求无需登录、Cookie、签名或特殊请求头；脚本只显式设置 `Accept: application/json` 和带标识的 `User-Agent`，其余为 Node.js `fetch` 默认请求头。

Base URL：`https://rmb.pingan.com.cn`

响应外层统一为：

```json
{
  "data": {},
  "responseCode": "000000",
  "responseMsg": "成功!",
  "success": true
}
```

`responseCode` 为 `000000` 表示成功。

## 数字黄金：平安金活期

产品代码：`GOLD_SHARE`，单位元/克。

### 当前价

```text
GET /bron/ibank/cust/bron-ibank-pd/gold/product/acct/getPopCurrGoldPrice.do
  ?channelCode=C0012
  &productCode=Au
  &priceType=1
  &holdAmt=
  &access_source=H5
```

关键字段：

| 字段 | 说明 |
| --- | --- |
| `data.sellingRate` | 银行卖出价，即页面展示的当前金价 |
| `data.buyingRate` | 银行买入价 |
| `data.publishTime` | 报价时间，`YYYYMMDDHHmmss`，UTC+8 |

### 实时走势

```text
GET /bron/ibank/cust/bron-ibank-pd/gold/product/acct/getPopGoldPriceList.do
  ?access_source=H5
  &searchType=1
  &prdCode=GOLD_SHARE
```

返回交易时段内约每 5 分钟一个点：

```json
{
  "data": {
    "list": [
      {
        "publishTime": "20261105093004",
        "productCode": "Au",
        "priceType": "1",
        "sellingRate": 882.5,
        "buyingRate": 882.5,
        "popPublishTime": 1793842200000
      }
    ]
  }
}
```

### 区间走势

```text
GET /bron/ibank/cust/bron-ibank-pd/gold/product/acct/getPopGoldPriceList.do
  ?channelCode=C0012
  &searchType=2
  &dateType=<dateType>
  &access_source=H5
  &prdCode=GOLD_SHARE
```

`dateType` 与页签对应关系：

| dateType | 页签 | 抓包样本点数 |
| --- | --- | --- |
| 2 | 近1月 | 20 |
| 3 | 近3月 | 60 |
| 4 | 近6月 | 124 |
| 5 | 近1年 | 242 |

区间数据为每个交易日一个点，通常在 `16:55` 左右，字段与实时走势相同。

## 实物黄金：平安浇铸金条

### 商品详情与 SKU 报价

```text
GET /bron/ibank/pop/goldPhysical/product/queryGoldPhysicalDetail.do
  ?prdCode=<prdCode>
  &access_source=H5
```

页面入口商品代码为 `10550037`（10g）。响应中的 `data.productSpecificationList` 给出全部规格到商品代码的映射，例如：

```json
{
  "swjProductSpecification": "20克",
  "prdCode": "10550038"
}
```

只保留 10g、20g、50g、100g，忽略 `50克*10`、`100克*10` 等组合规格。注意 50g 的规格文案是 `50`（没有“克”字）。

当前已知代码：

| 规格 | prdCode |
| --- | --- |
| 10g | 10550037 |
| 20g | 10550038 |
| 50g | 10550033 |
| 100g | 10550034 |

关键字段：

| 字段 | 说明 |
| --- | --- |
| `data.prdPrice` | 该规格一条的总价，元 |
| `data.prdWeight` | 克重 |
| `data.prdName` | 商品名称 |
| `data.swjProductSpecification` | 规格文案 |
| `data.saleStatus` | `ON_SALE` 表示在售 |
| `data.isTradeTime` | `1` 表示当前在交易时段 |
| `data.systemTime` | 请求时的银行服务器时间，UTC+8；不是价格发布时间 |

每克价格由 `prdPrice / prdWeight` 计算，页面本身不直接返回每克单价。若详情缺少 `prdWeight` 或字段不可解析，脚本回退到规格本身的克重（10/20/50/100），并以规格克重作为 `weightGrams` 和单价计算依据。

### 页面入口

- 数字金：`https://b.pingan.com.cn/fin/mobile/gold_current_detail.html`
- 实物金：`https://b.pingan.com.cn/aum/mobile2/detail_gold_genuine.html?prdCode=10550037`

## 维护提示

- 这些是网页内部接口，不是公开 API，可能无通知变更。
- 抓包方式：浏览器打开页面，切换到目标页签或规格，记录 XHR 请求和响应。
- 若 `prdCode` 变化，优先从入口商品详情的 `productSpecificationList` 重新发现；入口代码本身变化时更新 `PHYSICAL_SEED_CODE`。
- 请求频率保持克制，避免对银行接口造成压力。
