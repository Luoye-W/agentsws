---
group: connect
order: 140
positions: [web-ops, dtc-ops, ads, pr]
roles: [ads.google, kol.youtube, social.youtube, dtc.analytics, dtc.seo, pr.monitoring]
---
# Google 家的几个连接

这篇讲 Google 的六个连接各管什么、怎么接。前四个要用你自己的 Google Cloud 项目，最后一个 Google Alerts 什么都不用申请。

| 连接 | 一句话 | 要不要审核 / 花不花钱 |
|---|---|---|
| Gmail（Google 授权） | 用你自己的 Google OAuth 应用读写 Gmail | 属于「受限权限」，经第三方服务器访问要一年一次 CASA 安全评估；同意屏幕选「内部」可以免掉 |
| Google Analytics 4 | 网站的分析数据 | 不属于受限权限，不用安全评估 |
| Google Search Console | 网站在 Google 搜索里的表现 | 和 GA4 共用一个项目，多启用一个 API |
| YouTube Data API | 按关键词搜频道、读订阅数与主题 | 一把 API 密钥就行；全站一天 10000 单位配额 |
| Google Ads API | 广告表现、改预算与出价、暂停 | 能动真账户要在 Cloud 项目里申请访问级别 |
| Google Alerts（信息监控） | 自家、竞品、行业在新闻、博客、论坛里的提及 | 免费、不用申请、不要 key |

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

在面板上选一下是哪个媒体资源（只有一个就自动选好）。之后每天读一次：活跃用户、转化率、事件，以及按页面收入表里 GA4 口径的那两列。

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

在「SEO 与 GEO」面板上选一下是哪个站点（域名属性、网址前缀都行；只有一个就自动选好）。之后每天早上读一次：「今天值得动的 5 件事」、查询词与落地页都是真数。

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

**要两样**：OAuth 令牌和客户 id。读数据走 GAQL，改东西要带 updateMask——这些我们都处理好了，你只要把这两格填对。

以前还要去 Google Ads 后台的 API Center 申请一个 developer token，**现在不用了**：Google 已经取消了 developer token，能动哪些账户改看**生成这把授权的那个 Google Cloud 项目**的访问级别。刚启用 API 时只能动测试账户，要动你真实的广告账户，得在同一个项目里再申请一级。

**怎么做**

1. 在 Google Cloud 控制台建一个项目，启用 Google Ads API。
2. 在同一个项目的 Google Ads API 页申请更高一级的访问（要动真账户就要它）。
3. 用这个项目做 OAuth 授权，拿到访问令牌。
4. 抄下 Google Ads 后台右上角那串十位客户 id，去掉横杠。
5. 把两格填进表单。它们只存在这台电脑上。

连上之后如果报 403，多半是这个项目的访问级别还不够，回第 2 步看一眼。

**链接**

- [Google Ads API 快速开始](https://developers.google.com/google-ads/api/docs/start)
- [访问级别说明（Google 官方）](https://developers.google.com/google-ads/api/docs/api-policy/developer-token)

**现在管到哪**

Merchant Center 的商品 feed 也归投放这条职责，但那一侧还没接——现在这张卡只管广告。

## Google Alerts（信息监控）

信息监控盯自家、竞品和行业的新闻、博客、论坛，主要靠 Google Alerts：每盯一个词建一条提醒，投递到 **RSS**，把 RSS 链接贴给我。免费、不用申请、不要 key，可以建很多条。

要盯哪些词不用你从零想：跟我说「帮我盯一下竞品」，我按品牌档案和竞品列一份清单（每条带查询语句和理由），你确认后照着建。

**怎么建一条**

1. 打开 [Google Alerts](https://www.google.com/alerts)，用你的 Google 账号登录。
2. 在搜索框里填清单上那一条的查询语句，例如 `"Aventon" -job`。
3. 点「显示选项」，这样设：
   - 频率：**即时**
   - 来源：自动
   - 语言、地区：照清单上那一条
   - 数量：**所有结果**（默认是「只要最好的」，会漏掉很多）
   - 投递到：**RSS 供稿**（不要选邮箱）

   > 截图位：「显示选项」展开后的样子，「数量」选「所有结果」、「投递到」选「RSS 供稿」。

4. 点「创建提醒」。在提醒列表里，那一条右边有个 RSS 图标，右键复制链接。

   > 截图位：提醒列表里的 RSS 图标。

5. 把链接贴回对话里那张卡（每一行旁边有格子，也可以一次贴一批）。我会当场拉一次，拉到了才算配好。

**贴错了会怎样**

贴进来的不是 `https://www.google.com/alerts/feeds/` 开头、也不是能读的 RSS，我会当场说「这条还是邮箱投递」——回 Google Alerts 把那一条的「投递到」改成 RSS 再复制。

**也能订网站自己的 RSS**

很多博客、论坛、店铺博客有自己的 RSS。把它贴过来就行；那是整个站的新内容，我按品牌和竞品的词在本地筛，命中了才算一条。

**链接**

- [Google Alerts](https://www.google.com/alerts)

**要知道的**

- 默认每天拉一次（本地早上 9 点后），关机错过的开机补一次；想改频率跟我说。
- Google Alerts 一条只留最近约 20 条。哪条一次来了 20 条全是新的，我会把它改成每 4 小时拉一次，并在简报里说一声。
- 它有延迟（几小时到一天），也会漏。拉不到的时候，那一条在「连接」卡上亮红点，面板上照实写「没拉到」，**不会显示 0 条**。

## 常见问题

- **这几个能不能共用一个 Google 项目**：可以。GA4 可以和 Gmail 共用一个项目；Search Console 直接沿用 GA4 的 OAuth 客户端 ID。
- **GA4 / Search Console 连上了，怎么没有数字**：先看面板上有没有「选一下」那张小卡——选好站点 / 媒体资源才开始读。Search Console 的数有两三天延迟，我们读的是最近一个完整的 7 天。
- **Google 授权页上写着能「管理」，你们会改我的设置吗**：不会。授权是连接器统一申请的，我们这边只签得出读数的令牌，改设置的动作一个都调不动。
- **YouTube 搜人为什么不让多点**：全站一天只有 10000 单位，搜一次就花 100。读单个频道只花 1 单位。
- **Google Alerts 今天没提醒，是不是没人提我们**：不一定。它有延迟、也会漏；拉不到时那一条亮红点、面板写「没拉到」，不会写成 0 条。
- **为什么一定要选「所有结果」和 RSS**：「只要最好的」会筛掉大部分提及；邮箱投递我们读不到，只有 RSS 能自动拉。
