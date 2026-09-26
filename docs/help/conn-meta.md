# Meta 家的几个连接（Facebook / Instagram / WhatsApp）

这篇讲 Meta 的六个连接各管什么、怎么接。它们都从 Meta 开发者后台起步，大多数权限**要过审核**，不急的可以最后接。

| 连接 | 一句话 | 要不要审核 / 花不花钱 |
|---|---|---|
| Meta 广告（Facebook / Instagram） | 让广告后台那一块亮起来（Google 那种「去授权」方式） | 审核周期比 Google 那几个长 |
| Instagram Graph API | 红人：按名字查商业账号的粉丝与互动 | 权限要过审核 |
| Facebook Graph API | 红人：搜主页、读关注数与类目 | 「主页公开内容访问」是审核制 |
| Meta Graph API（FB 主页 + IG） | 社媒运营：读帖子、发布与排期、回评论 | 连上就能读；能发要过 App Review |
| Meta Marketing API（投放） | 投放：读表现、改预算与出价、暂停、换素材 | 广告权限要过审核 |
| WhatsApp Business API | 用审批过的模板给客户发消息 | 要过商业验证，模板要审核 |

先记住一条：**社媒那张 Meta 卡（能发帖）和投放那张 Meta 卡（能动预算）是两张**，权限不一样，别把两把钥匙做成一把。

## Meta 广告（Facebook / Instagram）

要你自己在 Meta 开发者后台建一个应用。审核周期比 Google 那几个长，不急的话可以最后接。

**怎么做**

1. 打开 [Meta for Developers](https://developers.facebook.com/apps)，建一个「商务」类型的应用。
2. 给它加上「营销 API」产品。
3. 在应用设置里拿到应用编号与密钥。
4. 把这两个值配进 OpenConnector。
5. 回来点「去授权」，选你要接的广告账户。

**链接**

- [Meta for Developers](https://developers.facebook.com/apps)

**连上之后**

岗位面板里的广告后台那一块会亮起来。花费、ROAS 数据下一版才接。

## Instagram Graph API

Instagram **没有「按关键词搜人」这回事**：官方只让你按名字查明确指名的商业账号。所以 IG 上找人的主力永远是导入与公共库，这条连接补的是「这个人现在多少粉、互动怎么样」。

**怎么做**

1. 把你的 Instagram 账号切成「商业账号」，并关联一个 Facebook 主页。
2. 在 [Meta 开发者后台](https://developers.facebook.com/apps) 建一个应用，加上 Instagram Graph API。
3. 申请权限 `instagram_basic` 与 `instagram_manage_insights`（**要过审核**）。
4. 用图形 API 浏览器换一个长期令牌，并抄下你自己的 IG 商业账号 id。
5. 把令牌和 id 填进表单。它们只存在这台电脑上。

**链接**

- [Meta 开发者后台](https://developers.facebook.com/apps)
- [business_discovery 文档](https://developers.facebook.com/docs/instagram-api/guides/business-discovery)

**没批下来会怎样**

权限没批下来之前，这条职责照样能用，只是「按名字查资料」那一块空着；找人靠导入与公共库。

## Facebook Graph API

用来搜主页、读主页的关注数与类目。

**搜主页要「主页公开内容访问」权限，那是审核制的。** 没批下来时我们会照实说「要过审核」，不会给你一个空列表假装没搜到。建联走主页私信，不走邮箱：很多主页压根没留邮箱。

**怎么做**

1. 在 [Meta 开发者后台](https://developers.facebook.com/apps) 建一个应用，类型选「商务」。
2. 申请权限 Page Public Content Access。要写清楚用途，**审核制**。
3. 用图形 API 浏览器换一个长期访问令牌。
4. 把令牌填进表单。它只存在这台电脑上。

**链接**

- [Meta 开发者后台](https://developers.facebook.com/apps)
- [主页搜索文档](https://developers.facebook.com/docs/graph-api/reference/page/)

**没连会怎样**

没有它这条职责照样能用：找人靠导入与公共库，建联靠人工到主页发私信。

## Meta Graph API（FB 主页 + IG）

一把 token 同时管 FB 主页和 IG 商业号：读帖子与表现、发布与排期、回评论。

**连上就能读，能发要过 App Review**——这是两件事，别把「还没批」当成「连接失败」。排期这件事我们替你按 Meta 的规矩写好了：只写时间、不关「立即发布」的话，帖子会当场发出去。

**怎么做**

1. 把 IG 切成商业账号，并关联你的 FB 主页（只发 FB 的话可以跳过这步）。
2. 在 [Meta 开发者后台](https://developers.facebook.com/apps) 建一个应用，加上 Facebook 登录与 Instagram Graph API。
3. 申请 `pages_manage_posts` / `pages_read_engagement` / `instagram_content_publish`（**要过审核**）。
4. 用图形 API 浏览器换一个长期主页令牌，并抄下主页 id 与 IG 账号 id。
5. 把令牌与 id 填进表单。它们只存在这台电脑上。

**链接**

- [Meta 开发者后台](https://developers.facebook.com/apps)
- [主页发布文档](https://developers.facebook.com/docs/pages-api)

**没连会怎样**

没连也能排内容、写草稿、攒审批——真发出去那一跳才需要它。发布权限还在审核里的时候，到点了我们提醒你去后台手工发一下，不会假装已经发出去了。

## Meta Marketing API（投放）

用来读广告账户与 campaign 的表现、改预算与出价、暂停、换素材。

**它和社媒那张 Meta 卡（上面的 Meta Graph API（FB 主页 + IG））是两张**：这张要「管理广告」权限（能动预算），那张要「发主页帖子」权限（能发帖）。具体权限名写在卡上「要准备什么」里。同一次授权可以一起授下来，但别把两把钥匙做成一把。

**怎么做**

1. 在 [Meta 开发者后台](https://developers.facebook.com/apps) 建一个应用，加上 Marketing API。
2. 申请 `ads_management` 与 `ads_read` 权限（**要过审核**）。
3. 用图形 API 浏览器换一个长期令牌，并抄下商务管理平台 id（可选）。
4. 把令牌填进表单。它只存在这台电脑上。

**链接**

- [Meta 开发者后台](https://developers.facebook.com/apps)
- [Marketing API 文档](https://developers.facebook.com/docs/marketing-apis)

**没连会怎样**

没连也能看提案、攒审批、排计划——真正动到账户那一跳才需要它。权限还在审核里的时候，我们照实说「还没批」，不会假装改过了。

## WhatsApp Business API

**下面三条规矩都是 Meta 的，不是我们的：**

- 要过商业验证。
- 主动发消息只能用审批过的模板（`template.name` 必填），而且收件人必须先 opt-in（同意接收）。
- 对方给你发过消息之后，才有 24 小时窗口可以自由回复。

违反了，封的是这个品牌的号。所以少了模板名、或者没核过 opt-in 时，我们**当场拦下（block）**，不是让你点一下就发；窗口过了的自由文本也发不出去，会让你改成选一个模板。

**怎么做**

1. 在 Meta 商务管理平台过商业验证，并把号码接进 WhatsApp Business 平台。
2. 在开发者后台建一个应用，加上 WhatsApp 产品，拿到号码 id。
3. 建一个系统用户，生成长期访问令牌（权限要有 `whatsapp_business_messaging`）。
4. 在后台建好要用的消息模板，等它审核通过。模板名与语言，就是表单里要对上的那两格。
5. 把令牌与号码 id 填进表单。它们只存在这台电脑上。

**链接**

- [WhatsApp Cloud API 文档](https://developers.facebook.com/docs/whatsapp/cloud-api)

**群发是怎么发的**

群发是**一个一个发**的（Cloud API 没有批量接口），所以卡面上那个「发给多少人」，就是要打多少跳。中途被限流或者掉线，我们**停下来**，不接着发、也不重试——重试一条可能已经送达的模板消息，代价是对方收到两条一样的。

## 常见问题

- **权限还在审核，是不是连接失败了**：不是。Meta Graph API 连上就能读，能发要等 App Review；投放那张在审核期间会照实写「还没批」。
- **一个 Meta 应用能不能把几张卡都授了**：同一次授权可以一起授下来，但社媒（发帖）和投放（动预算）是两张卡、两把钥匙，别合成一把。
- **IG 上能不能按关键词找红人**：不能，Instagram 官方就没有这个接口。找人靠导入与公共库，这条连接只补粉丝和互动。
- **WhatsApp 群发发到一半停了**：被限流或掉线时我们会停下、不重试，免得对方收到两条一样的。
