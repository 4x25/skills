# 平安银行外汇牌价接口

抓包与直连验证日期：2026-11-06。浏览器操作覆盖列表、美元和日元详情及全部四个趋势页签，Node.js 26 直连验证无需登录、Cookie、签名或 Referer。

页面入口：

- 列表：`https://b.pingan.com.cn/exchange/cbf/foreign-exchange-trend-list.html`
- 详情：`https://b.pingan.com.cn/exchange/cbf/foreign-exchange-trend-detail.html?ccy=USD`

Base URL：`https://rmb.pingan.com.cn/account/cmp/cust/acct/forex/exchange/`

外层响应：

```json
{
  "data": {},
  "responseCode": "000000",
  "responseMsg": "成功"
}
```

`responseCode` 必须为 `000000`；响应不一定包含 `success`。脚本显式设置 `Accept: application/json` 和带标识的 `User-Agent`，其余采用 Node.js `fetch` 默认请求头。

## 当前报价列表

```text
GET qryExchangePriceList.do
```

无查询参数，`data.settleList` 返回全部 10 个币种：USD、HKD、GBP、JPY、EUR、AUD、NZD、CHF、SGD、CAD。脚本在本地筛选所需币种。

```json
{
  "data": {
    "settleList": [
      {
        "ccy": "USD",
        "ccyName": "美元",
        "buyingRate": "665.6280",
        "sellingRate": "668.3651",
        "rmbToCcyRate": "14.9619",
        "bChangeFlag": "-1",
        "sChangeFlag": "1"
      }
    ],
    "updateTime": "2026-11-06 08:55:26"
  }
}
```

此处为抓包样本，不是固定报价。

| 银行字段 | 客户方向与脚本字段 |
| --- | --- |
| `ccy` / `ccyName` | `currency` / `currencyName` |
| `sellingRate` | 客户买外币，页面“买入外币价”，输出 `purchaseRate` |
| `buyingRate` | 客户卖外币，页面“卖出外币价”，输出 `settlementRate` |
| `updateTime` | 列表更新时间，输出带 `+08:00` 的 `current.updateTime` |

原始单位为人民币元／100 外币，日元也如此。`purchasePerUnit`／`settlementPerUnit` 将报价除以 100，保留六位小数；`spread` 为两者原始价之差，保留四位小数。

`rmbToCcyRate` 是另一报价方向的页面辅助字段，可能含千位分隔符；脚本使用正向买卖价自行换算金额。`bChangeFlag`／`sChangeFlag` 是页面箭头方向，不是涨跌幅，本次输出聚焦报价与区间汇总。

## 历史详情

```text
POST qryExchangeHisPriceDetail.do
Content-Type: application/x-www-form-urlencoded;charset=UTF-8

ccy=USD&startDate=2026-10-07&endDate=2026-11-06
```

使用 `URLSearchParams` 作为请求体，Node.js 自动设置表单 Content-Type。`ccy` 使用大写 ISO 币种代码，日期格式为 `YYYY-MM-DD`。

页签根据查询当天向前减固定天数：

| 页签 | CLI 区间 | 回溯天数 | 2026-11-06 的 startDate | 美元／日元样本点数 |
| --- | --- | --- | --- | --- |
| 近一月 | `1m` | 30 | 2026-10-07 | 30 |
| 近三月 | `3m` | 90 | 2026-08-08 | 90 |
| 近半年 | `6m` | 180 | 2026-05-10 | 180 |
| 近一年 | `1y` | 365 | 2025-11-06 | 365 |

脚本以中国标准时间确定查询当天，所有区间共享同一 `now`，避免跨午夜时日期不一致。样本包含起始日期，最新点为前一日（2026-11-05）；未来的实际点数和末日以返回数据为准。

```json
{
  "data": {
    "currentBuyingRate": "665.6280",
    "currentSellingRate": "668.3651",
    "rateList": [
      {
        "ccy": "USD",
        "ccyName": "美元",
        "exchangeDate": "20261105",
        "buyingRate": "665.6280",
        "sellingRate": "668.3651",
        "middleRate": "666.8050"
      }
    ],
    "updateTime": "2026-11-06 08:51:40"
  }
}
```

| 银行字段 | 输出与解释 |
| --- | --- |
| `rateList[].exchangeDate` | 历史日期 `YYYYMMDD` → `date: YYYY-MM-DD` |
| `rateList[].sellingRate` | 每日购汇报价 `purchaseRate` |
| `rateList[].buyingRate` | 每日结汇报价 `settlementRate` |
| `rateList[].middleRate` | 银行参考中间价 `middleRate`，也是网页曲线数据 |
| `updateTime` | 响应更新时间，不是历史点的发布时间 |

响应的 `rateList` 通常日期倒序，脚本转为升序。保留周末重复报价，不合并日期、不插值。币种或日期无效、日期越界、非正数价格和重复记录会产生警告；只保留可用数据，各序列独立汇总。

### 中间价与最新价的区别

网页说明曲线使用日终收盘中间价，其 JavaScript 实际读取 `rateList[].middleRate`。样本中 `666.8050` 与 `(665.6280 + 668.3651) / 2 = 666.99655` 不同，因此严格保留银行返回值，不重新计算替代。

`currentBuyingRate`／`currentSellingRate` 是历史详情接口的辅助字段，详情头部可能与当前列表不同；不将其当成最新报价来源。获取当前报价使用 `qryExchangePriceList.do`，获取每日历史报价使用 `rateList`。接口没有三项报价的独立采样时刻，不断言它们严格同时收盘采样。

页面声明“现钞现汇同价”；当前与历史接口均只提供一组买卖报价，按页面口径说明，实际结售汇以交易时银行报价为准。

## 复核流程

1. 浏览器打开列表，核对人民币／100 外币单位和两列客户交易方向。
2. 点击至少两个币种，记录详情 XHR 请求。
3. 四个趋势页签绑定的是 `touchstart`；常规鼠标点击可能不会触发查询。使用触摸操作，或在浏览器中对对应 `.details-tab-item` 分发 `touchstart` 事件。
4. 等待图表序列更新，记录 POST 请求的 `ccy`、`startDate`、`endDate` 及 `rateList`。
5. 用 Node.js 无登录直连重放，核对成功码、日期、单位和字段；仅保存脱敏后的相关响应数据，不把整份浏览器网络日志纳入技能。

内部网页接口可能无通知变更。保持低请求频率；普通单币种全部历史为 4 次请求，当前全部币种只需 1 次请求。
