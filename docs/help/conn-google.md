# Google 家的几个连接

这篇讲 Google 的六个连接各管什么、怎么接。前四个要用你自己的 Google Cloud 项目，最后一个 Google Alerts 什么都不用申请。

| 连接 | 一句话 | 要不要审核 / 花不花钱 |
|---|---|---|
| Gmail（Google 授权） | 用你自己的 Google OAuth 应用读写 Gmail | 属于「受限权限」，经第三方服务器访问要一年一次 CASA 安全评估；同意屏幕选「内部」可以免掉 |
| Google Analytics 4 | 网站的分析数据 | 不属于受限权限，不用安全评估 |
| Google Search Console | 网站在 Google 搜索里的表现 | 和 GA4 共用一个项目，多启用一个 API |
| YouTube Data API | 按关键词搜频道、读订阅数与主题 | 一把 API 密钥就行；全站一天 10000 单位配额 |
| Google Ads API | 广告表现、改预算与出价、暂停 | developer token 要等审核 |
| Google Alerts（品牌监控） | 品牌在新闻、博客、评测里的提及 | 免费、不用申请、不要 key |

只想收发邮件？不用走 Gmail 这条，看 [连邮箱](help:conn-email)，填一个授权码就行。

## Gmail（Google 授权）

要你自己在 Google Cloud 建一个 OAuth 应用。只想收发邮件的话，先看 [连邮箱](help:conn-email)（「任意邮箱」那条）。

**怎么做**

1. 打开 Google Cloud Console，新建一个项目。
2. 在「API 和服务」里启用 Gmail API。
3. 配置 OAuth 同意屏幕，用户类型选「内部」。组织内部使用可以免掉第三方安全评估。
4. 到 [Google Cloud 凭据页](https://console.cloud.google.com/apis/credentials) 建一个「OAuth 客户端 ID」，类型选「Web 应用」，回调地址填本机 OpenConnector 的地址。
5. 把客户端 ID 与密钥配进 OpenConnector，然后回来点「去授权」。

**链接**

- [Google OAuth 客户端（凭据页）](https://console.cloud.google.com/apis/credentials)
- [Google 受限权限与 CASA 评估](https://support.google.com/cloud/answer/9110914)

**为什么这么麻烦**

Gmail 的读写属于 Google 的「受限权限」：经第三方服务器访问，要做一年一次的 CASA 安全评估。所以这一版走的是你自己的 OAuth 应用。只想收发客服信的话，「任意邮箱」那条更省事。

## Google Analytics 4

用你自己的 Google OAuth 应用授权一次就行。GA4 的分析数据不属于受限权限，不用做安全评估。

**怎么做**

1. 在 Google Cloud Console 里启用 Google Analytics Data API。
2. 建一个 OAuth 客户端 ID（可以和 Gmail 共用一个项目）。
3. 把客户端 ID 与密钥配进 OpenConnector。
4. 回来点「去授权」，在 Google 页面上选你要接的那个 GA4 媒体资源。

**链接**

- [GA4 Data API](https://developers.google.com/analytics/devguides/reporting/data/v1)

**连上之后**

岗位面板里的 GA4 那一块会亮起来。具体的活跃用户、事件数据下一版才接。

## Google Search Console

和 GA4 用同一个 Google 项目，多启用一个 API 就行。

**怎么做**

1. 在 Google Cloud Console 里启用 Search Console API。
2. 沿用 GA4 那个 OAuth 客户端 ID。
3. 把客户端 ID 与密钥配进 OpenConnector。
4. 回来点「去授权」，选你已经验证过所有权的那个站点。

**链接**

- [Search Console API](https://developers.google.com/webmaster-tools)

**连上之后**

岗位面板里的 Search Console 那一块会亮起来。查询词与落地页数据下一版才接。

## YouTube Data API

用来按关键词搜频道、读频道的订阅数与主题。

**配额是全站一天 10000 单位**，不是每个工作区各算各的。搜一次花 100 单位，读一个频道花 1 单位。所以「搜人」不是可以随便点的按钮。

**怎么做**

1. 打开 Google Cloud 控制台，新建（或选一个）项目。
2. 在「API 和服务 → 库」里启用 YouTube Data API v3。
3. 到 [Google Cloud 凭据页](https://console.cloud.google.com/apis/credentials) 点「创建凭据 → API 密钥」，复制那串密钥。
4. （建议）给这把密钥加限制：只允许 YouTube Data API v3。
5. 把密钥填进表单。它只存在这台电脑上。

**链接**

- [Google Cloud 凭据页](https://console.cloud.google.com/apis/credentials)
- [YouTube Data API 配额说明](https://developers.google.com/youtube/v3/determine_quota_cost)

**没连会怎样**

红人这条职责没有它照样能用：找人靠导入你手上那张表与公共红人库，建联、合作、审核、归因一样不少。同一把 key 也供社媒运营的 YouTube 那条职责（读写我们自己的频道）——连一次，两处都亮。

## Google Ads API

管搜索、购物、PMax、YouTube 广告：读表现、改预算与出价、暂停。

**三样东西缺一不可**：OAuth 令牌、developer token、客户 id。读数据走 GAQL，改东西要带 updateMask——这些我们都处理好了，你只要把这三格填对。

**怎么做**

1. 在 Google Cloud 建一个项目，启用 Google Ads API，并做 OAuth 授权。
2. 在 Google Ads 后台 → 工具 → API Center 申请 developer token（基础访问权限就够用），**然后等审核**。
3. 抄下 Google Ads 后台右上角那串十位客户 id，去掉横杠。
4. 把三格填进表单。它们只存在这台电脑上。

**链接**

- [Google Ads API 快速开始](https://developers.google.com/google-ads/api/docs/start)
- [API Center（申请 developer token）](https://ads.google.com)

**现在管到哪**

Merchant Center 的商品 feed 也归投放这条职责，但那一侧还没接——现在这张卡只管广告。

## Google Alerts（品牌监控）

免费、不用申请、不要 key：在 Google Alerts 里建一条提醒，把投递方式改成 RSS，把地址贴过来就行。这是**唯一**一个不用申请、不要钱、也不违反谁的条款的新闻监控入口。

它给的是新闻、博客与评测。Reddit 上的讨论由 Reddit 那张卡的全站搜索补上，看 [社群机器人](help:conn-community)。

**怎么做**

1. 打开 [Google Alerts](https://www.google.com/alerts)，用你的 Google 账号登录。
2. 建一条提醒，关键词填品牌名。中英文各建一条更稳。
3. 点提醒右边的铅笔 → 「投递到」选 **RSS 源**。
4. 复制那个 feed 地址，填进表单。它只存在这台电脑上。

**链接**

- [Google Alerts](https://www.google.com/alerts)

**要知道的**

Google Alerts 有延迟（几小时到一天），也会漏东西——它不是全网监控。拉不到的时候，面板上会照实说「这条 feed 没拉到」，**不会显示今天 0 条提及**：这两件事在品牌监控这条职责上必须分得开。

## 常见问题

- **这几个能不能共用一个 Google 项目**：可以。GA4 可以和 Gmail 共用一个项目；Search Console 直接沿用 GA4 的 OAuth 客户端 ID。
- **GA4 / Search Console 连上了，怎么没有数字**：这一版连上只会让面板那一块亮起来，具体数据下一版才接。
- **YouTube 搜人为什么不让多点**：全站一天只有 10000 单位，搜一次就花 100。读单个频道只花 1 单位。
- **Google Alerts 今天没提醒，是不是没人提我们**：不一定。它有延迟、也会漏；拉不到时面板会写「这条 feed 没拉到」，不会写成 0 条。
