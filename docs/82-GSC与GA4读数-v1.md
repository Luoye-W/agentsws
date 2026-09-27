# 82 Search Console 与 Google Analytics 4 的真实读数 v1

> WP158（Luoye 09-27 定：GSC 和 GA4 要接）。本文件回答三件事：OpenConnector 上这两家有什么、
> 我们挑了哪几个口、怎么缓存与出错。**全文没有连过真 Google、没有用真账号**——provider 定义是从
> 本机 OpenConnector 镜像里读出来的（`ghcr.io/oomol-lab/open-connector`，本机常驻容器
> `agentsws-openconnector` 用的那一份，镜像 digest `sha256:aa088c5d…`，源码 revision
> `c6f55b58`，即我们钉的 v1.6.5；用自己起的临时容器 `wp158-oc-probe` 拷出 `src/providers/google_*`
> 后当场删掉），配额与返回形状对照 Google 官方文档。

## 1 一句话结论

- 两家都在 OpenConnector 里，服务名 `google_search_console` / `google_analytics`，授权都是
  **OAuth2**（另可用服务账号 JSON），令牌由 OpenConnector 保管、自动续期。
- 我们只用**读**口：GSC 四个（站点列表、搜索分析、网址检查、站点详情），GA4 三个（媒体资源列表、
  出报表、配额快照）。写口一个都不标 `read`，所以永远签不进我们的只读令牌。
- **授权范围的坑**：OpenConnector 这两家的 OAuth 同时申请只读与读写两个 scope（见 §2），
  v1.6.5 没有让我们只要只读的开关。我们这一侧用只读令牌兜住（写口签不出来），但 Google 授权页上
  用户会看到「管理」字样——要不要给上游提一个「只读授权」选项，列进 WP158 报告 §3。

## 2 授权

| | Search Console | GA4 |
|---|---|---|
| 上游服务名 | `google_search_console` | `google_analytics` |
| 授权方式 | `oauth2`、`custom_credential`（服务账号 JSON，可选委派用户） | 同左 |
| OAuth 申请的 scope | `webmasters.readonly` **+** `webmasters` | `analytics.readonly` **+** `analytics.edit` |
| 我们要的 scope | 只要 `webmasters.readonly` | 只要 `analytics.readonly` |
| 授权参数 | `access_type=offline`、`prompt=consent`（拿刷新令牌） | 同左 |

- 我们用到的每一个读口，上游登记的 `requiredScopes` 都只有只读那一个。
- **令牌只在连接器里**：我们手里只有 OpenConnector 的连接 id 和一张 120 秒的只读执行令牌
  （`role-read`，只允许这几个读口、只允许这一条连接，用完即吊销，同 WP46 店铺数据那一套）。
  Google 的 access / refresh token 从不经过我们的进程，不进库、日志、事件、模型。

## 3 读口清单（我们用的标 ✓）

### 3.1 Search Console（`google_search_console.*`）

| 动作 | 上游类型 | 用 | 入参 | 返回 |
|---|---|---|---|---|
| `list_sites` | read | ✓ | 无 | `{ sites: [{ siteUrl, permissionLevel }] }` |
| `get_site` | read | ✓（备用） | `siteUrl` | `{ site: { siteUrl, permissionLevel } }` |
| `query_search_analytics` | read | ✓ | `siteUrl`、`startDate`、`endDate`（必填，YYYY-MM-DD）；`dimensions`（date / hour / query / page / country / device / searchAppearance）、`type`（web…）、`dimensionFilterGroups`、`aggregationType`、`rowLimit`（1–25000）、`startRow`、`dataState`（final / all / hourly_all） | `{ rows: [{ keys, clicks, impressions, ctr, position }], responseAggregationType, metadata: { firstIncompleteDate, firstIncompleteHour } }` |
| `inspect_url` | read | ✓ | `siteUrl`、`inspectionUrl`、`languageCode?` | `{ inspectionResult }`（Google 原样：`indexStatusResult.verdict / coverageState / googleCanonical / userCanonical …`） |
| `list_sitemaps` / `get_sitemap` | read | 不用 | | |
| `add_site` / `submit_sitemap` | write | ✗ | | |
| `delete_site` / `delete_sitemap` | destructive | ✗ | | |

- `siteUrl` 两种属性都认：**网址前缀**写 `https://www.example.com/`，**域名属性**写
  `sc-domain:example.com`——`list_sites` 给什么我们就原样存什么、原样传回去。
- `permissionLevel` 为 `siteUnverifiedUser` 的站点读不到数据，下拉里不列。
- `rows[].keys` 的顺序 = 请求里 `dimensions` 的顺序；`ctr` 是 0–1 的小数；`position` 是平均排名。
- 行按点击降序给；单次最多 25 000 行，用 `startRow` 翻页。

### 3.2 GA4（`google_analytics.*`）

| 动作 | 上游类型 | 用 | 入参 | 返回 |
|---|---|---|---|---|
| `list_properties` | read | ✓ | `pageSize?`（≤200）、`pageToken?` | `{ properties: [{ propertyId, property, displayName, propertyType, account, accountDisplayName, parent, raw }], nextPageToken }` |
| `list_account_summaries` | read | 备用 | 同上 | 按账户分组的同一份东西 |
| `run_report` | read | ✓ | `propertyId`、`dateRanges[{ startDate, endDate, name? }]`、`metrics`（必填）；`dimensions`、`dimensionFilter`、`orderBys`、`limit`、`metricAggregations`、`returnPropertyQuota`… | `{ report: { dimensionHeaders, metricHeaders, rows: [{ dimensions: {名: 值}, metrics: {名: 值}, dimensionValues, metricValues }], rowCount, metadata: { currencyCode, timeZone }, propertyQuota, totals, … } }` |
| `get_property_quotas_snapshot` | read | ✓（配额用尽时说清剩多少） | `propertyId` | `{ propertyQuotasSnapshot: { corePropertyQuota … } }` |
| `get_metadata` / `get_property_overview` / `check_compatibility` | read | 不用 | | |
| `run_pages_report` 等「业务报表」 | 上游标 **write**（其实是读，上游标错了） | 不用，一律走 `run_report` | | |
| 自定义维度 / 指标、改属性、改保留期 | write / destructive | ✗ | | |

- 指标值一律是**字符串**（`"123"`、`"45.67"`），我们解析时转数、转不了就当没有，不编。
- `metrics` 是按表头名做键的对象（OpenConnector 做过一层归一），不用再按下标对。

## 4 配额与限流（官方文档，09-27 查）

| | 限额 | 用尽时 |
|---|---|---|
| GSC 搜索分析 | 每站点 1 200 次 / 分、每用户 1 200 次 / 分；每项目 40 000 次 / 分、3 000 万次 / 天；另有按 10 分钟与按天计的「负载配额」（按行数 / 维度复杂度算） | HTTP 429 或 403，消息里带 `quota exceeded` / `rateLimitExceeded` |
| GSC 网址检查 | 每站点 600 次 / 分、**2 000 次 / 天** | 同上 |
| GSC 其它（站点列表…） | 每用户 20 次 / 秒、200 次 / 分 | 同上 |
| GA4 Data API（标准媒体资源） | 每媒体资源每天 200 000 token、每小时 40 000；**每项目每媒体资源每小时 14 000**；同时最多 10 个请求；每项目每资源每小时最多 10 次服务端错误（超了整小时被封） | HTTP 429 `RESOURCE_EXHAUSTED`；按小时 / 太平洋时间零点恢复 |

我们一天的用量（每个品牌）：

- GSC：1 次站点列表（选站点时才调）+ 1 次「按日期」探最新完整日 + 本周与上周各 1–2 页「查询 × 页面」
  + 最多 10 次网址检查 ≈ **15 次 / 天**，离任何一条限额都差三个数量级。
- GA4：1 次落地页报表 + 1 次总量（两段日期）+ 1 次事件表 ≈ **3 次 / 天**，一次报表几十个 token。
- 同一天之内的重复读（面板刷新、手动「现在跑一轮」）都吃**当天缓存**，不再打上游；只有「换了站点 /
  换了连接 / 过了一天」才重拉。

OpenConnector 把上游 429 原样透成 429，我们的适配器映射为 `rate_limited`。配额用尽时卡上说人话：
「Google 这边今天的读取额度用完了，先用昨天那份；明天早上自动再读」。

## 5 窗口与时区

- **Search Console 的日期是太平洋时间**（官方文档：PT，UTC−7 / −8），而且最近两三天的数据还没定稿。
  所以「近 7 天」不从今天往回数：先用 `dimensions: ['date']` 探一次**最近一个有数的完整日**（没探到就用
  太平洋时间的今天往前 3 天），以它为终点取 7 天（本周），再往前 7 天（上周）。两段等长、都已定稿——
  否则本周那段里夹着两三个空日子，每个词都会被误判成「在掉」。
- 本周与上周各取一次「查询 × 页面」，按（查询, 页面）对上，得到 `clicks_prev_week`。上周那一次
  **没翻完**（行数撞到上限）时，本周有、上周没有的那一对不填 0（不知道 ≠ 0，契约 `GscRow` 的规矩）；
  翻完了才填 0。
- **GA4** 的日期按媒体资源自己的时区算，数据一般 24–48 小时后才稳定。我们用与 GSC **同一段日期**
  （同一周）去问 GA4，好让「点击」与「会话 / 转化」对得上；两边时区不同差的是几小时的边，写进卡上的口径说明。
- 六个信号的阈值与窗口一律照 `@agentsws/seo-core` 现有定义（排名 3–20、曝光 > 500 且点击率 < 0.5%、
  周环比降 30% 且上周 ≥ 10 次点击、7 个词以上……），不因接了真数据改数。

## 6 我们拿这些数做什么

| 用处 | 来自 | 落在哪 |
|---|---|---|
| 六个信号 → 每天 5 件事 | GSC 本周 + 上周「查询 × 页面」 | `seo.today`（报告卡） |
| 「没被收录 / 在跳转 / 规范网址不对」 | GSC 网址检查（按曝光排前 10 页） | 5 件事里「交建站」那条车道 |
| 查询词表、落地页表 | 同一份 GSC 行（按查询 / 按页面汇总；页面的平均排名按曝光加权） | `gsc.top_queries`、`gsc.landing_pages` |
| 按页面：点击 / 订单 / 收入 | GSC 点击 + Shopify `landing_site`（**主口径**）+ GA4 落地页（**并排口径**） | `seo.page_revenue` |
| 活跃用户、转化率、事件 | GA4 总量与事件表 | `analytics.*` 三块 |

GA4 那一侧只看**自然搜索**来的会话（`sessionDefaultChannelGroup = Organic Search`）：这张表回答的是
「搜索带来的人买没买」，把广告与邮件带来的会话混进来就不是这个问题了。「转化」= GA4 的购买
（`ecommercePurchases`），关键事件（`keyEvents`）另列；GA4 口径收入 = `purchaseRevenue`。
Shopify `landing_site` 仍是主口径（它是真订单），GA4 的数只作对照——两边对不上是常态
（GA4 被拦截器挡、跨设备、归因模型不同），卡上写明两种口径各是什么。

## 7 缓存与失败（照 WP46）

- 按天缓存（每个品牌一份，只在内存里）：键是「连接 id + 站点 / 媒体资源 + 日期窗口」。
- 上游失败：**保留上一份**，面板照常出、标「用的是上一份」，记一条事件 `data.refresh_failed`
  （只有 `source`、原因码、截短的上游原话，没有任何行数据、没有令牌）。
- 没选站点 / 媒体资源：不打任何读数请求，面板上出一张「选一下是哪个站点」的小卡（一句话 + 下拉）；
  只有一个可选时自动选上，不问。选了立刻重读一遍并重出今天的 5 件事。
- 选择记在品牌目录的 `google-reads.json`（只有站点 URL 与媒体资源 id，没有任何凭据）。
