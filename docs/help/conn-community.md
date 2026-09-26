# 社群机器人：Reddit / Discord / Telegram

这篇讲社群运营用的三个连接：Reddit 版块、Discord 服务器、Telegram 群。三家规矩差别很大，先看表。

| 连接 | 一句话 | 要准备什么 |
|---|---|---|
| Reddit API | 读版务名单、发置顶帖、全站搜索讨论 | 在 Reddit 注册一个应用；User-Agent 要写对；一分钟最多 60 次调用 |
| Discord 机器人 | 读消息与成员、发公告、删消息、禁言 | 建一个 Bot，邀请进你的服务器 |
| Telegram 机器人 | 读群消息、发公告、删消息、禁言封禁 | 找 @BotFather 建，并设成群管理员 |

三家有一点一样：**没连也能整理规则、攒草稿、攒审批**，真发出去那一跳才需要连接。

## Reddit API

要先在 Reddit 注册一个 script 或 web 应用，拿 client id + secret 换令牌。

- **User-Agent 必须是 Reddit 认的格式**，写错一律 429。
- 这条渠道上的「群发」就是发一条**置顶帖**。给每个订阅者发私信是明令禁止的：会被举报成垃圾信，封的是这个号。
- 一分钟最多 60 次调用。超了我们自己先排队，而不是等 Reddit 回 429。

**怎么做**

1. 到 [https://www.reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) 建一个应用（选 script 或 web app）。
2. 复制 client id 与 secret，走 OAuth 换一把访问令牌。
3. 把 User-Agent 按 `平台:应用 id:版本 (by /u/你的用户名)` 的格式写好。
4. 把令牌、User-Agent 与版块名填进表单。它们只存在这台电脑上。

**链接**

- [Reddit 应用管理页](https://www.reddit.com/prefs/apps)
- [Reddit API 文档](https://www.reddit.com/dev/api)

**要知道的**

subreddit **没有成员名册，也没有入群审批**（关注是单向的）。所以「待审入群」那一块在这条渠道上永远是空的——那不是没连，是这件事在 Reddit 上不存在。读得到的是版务名单，也就是谁说了算。

## Discord 机器人

能读频道消息与成员、发公告、删消息、禁言。

- **禁言是设一个到期时刻**，到点自动解除，上限 28 天；它不是一个开关。
- 封禁永远要人点。
- 发公告必须说清发到哪个频道——没有「全服务器广播」这个选项。

**怎么做**

1. 到 [Discord 开发者后台](https://discord.com/developers/applications) 建一个应用，在 Bot 页添加一个 Bot，并复制令牌。
2. 在 OAuth2 → URL Generator 里勾上 bot，以及要用的权限：读消息、发消息、管理消息、超时成员。
3. 用生成的链接，把这个 Bot 邀请进你的服务器。
4. 打开 Discord 的开发者模式，右键服务器，复制它的 id。
5. 把令牌与服务器 id 填进表单。它们只存在这台电脑上。

**链接**

- [Discord 开发者后台](https://discord.com/developers/applications)
- [Bot 文档](https://discord.com/developers/docs/intro)

**没连会怎样**

没连也能整理规则、攒公告草稿、攒审批——真发出去那一跳才需要它。Bot 没有管理员权限时，删消息与禁言会失败；我们会把平台原话端出来，不翻译成「出错了」。

## Telegram 机器人

能读群里的消息、发公告、删消息、禁言封禁。

- **业务错误藏在 200 里**：Telegram 出错时状态码照样是 200，内容是 `{"ok": false, ...}`。所以「发出去了」看的是 `ok` 那一格，不是状态码——这一点我们替你判了。
- 机器人必须是群管理员，否则删消息与禁言都做不了。

**怎么做**

1. 在 Telegram 里找 [BotFather](https://t.me/botfather)（@BotFather），发 `/newbot`，按提示起名字。
2. 复制它给你的那串令牌。
3. 把机器人拉进你的群，并设成管理员。要删消息与禁言，就必须做这一步。
4. 拿到群 id：把机器人加进群后发一条消息，或者用 @userinfobot。
5. 把令牌与群 id 填进表单。它们只存在这台电脑上。

**链接**

- [BotFather](https://t.me/botfather)
- [Bot API 文档](https://core.telegram.org/bots/api)

**没连会怎样**

没连也能整理群规、攒公告草稿、攒审批——真发出去那一跳才需要它。

## 常见问题

- **Reddit 一直回 429**：先检查 User-Agent 是不是 `平台:应用 id:版本 (by /u/你的用户名)` 这个格式，写错一律 429。
- **Reddit 能不能给订阅者群发私信**：不能，Reddit 明令禁止，会封号。这条渠道上的群发就是发置顶帖。
- **Discord / Telegram 删不了消息、禁不了言**：机器人得有管理员权限。Discord 会把平台原话端给你看。
- **品牌在 Reddit 上被讨论了能不能看到**：Reddit 这张卡有全站搜索，和 Google Alerts 互补，看 [Google 家的几个连接](help:conn-google)。
