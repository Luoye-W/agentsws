# WP124 在线聊天：免费本地档（官方转发 / 自建转发）+ 收费在线档

worktree：`../agentsws-wt/wp124-live-chat`，分支 `wp/124-live-chat`。**在 WP116、WP118 合并之后开工**（同改 `apps/cloud-worker`）；开工先读 `docs/72`（WP123 对标 KefuAgent 的结论，若已合入——在线聊天那一大节与它推荐的 Cloudflare 方案以它为准细化）与 `docs/73`（Fable 亲测 + 两档方案）。

## Luoye 定（09-19）
1. 在线聊天分**免费本地档**与**收费在线档**；两档同一个挂件、同一段嵌入代码，设置里切档，商家网站不用改。
2. **免费本地档**：云只做转发，干活（AI、对话存储、知识、接管）全在商家本机。官方托管的转发**每月 200 个对话**上限。
3. **再留一条路：用户可以很方便地自己开服务器部署转发**，通过一个接口与本地连起来；自建不设上限。
4. **收费在线档** =「**客服增值服务**」**30 积分 / 月**（与红人营销增值服务同价同机制）；AI 用量另按积分计。

## 先读
`docs/72`、`docs/73`、`docs/48` §4（L3 #11 聊天窗、在线值守）、`docs/63`（消息：`MessageSource` 扩展位）、`docs/64`、`docs/67`（WP118：订阅 term / cycle 与三块计费）、`docs/36`、`docs/21`；代码 `apps/server/src/{chat.ts,chat-widget.ts,widget.ts}`（现有访客面四道门与无依赖嵌入脚本——**复用，不重写**）、`packages/channels/src/chat/**`、`packages/standby/**`、`apps/cloud-worker/**`、`packages/metering`、`packages/support-core`、工作台 `pages/chat-sandbox.tsx` 与 `pages/messages.tsx`。
只读参考：`/Users/yeluo/Documents/KefuAgent` 的在线聊天实现与 spec 034 / 036。

## 定论
### A. 聊天转发器 `packages/chat-relay`（一份代码，三种部署）
- 职责只有转发：访客侧（HTTP + SSE / WebSocket，沿用现有四道门：来源白名单、限流、访客令牌、凭据不进 URL）↔ 商家本机（**本机主动外连**的一条长 WebSocket，带配对密钥；商家电脑不开端口、不要公网 IP）。**不存对话正文、不跑 AI**；只留计数与最近在线时间。运行时无关的核心 + 两个薄适配：Cloudflare（每工作区一个 Durable Object，WebSocket hibernation）与 Node（单进程，内存态）。
- **官方托管**：挂进 `apps/cloud-worker`（路径 `/relay/<ws>/*` 与 `/relay/<ws>/widget.js`）；按工作区计对话数，**每月 200 个**（数据化 `packages/metering/src/limits.json`），到 80% 提醒、到顶后新访客看到留言表单；已订阅客服增值服务的不受此限。
- **用户自建**：`deploy/chat-relay/`——① `Dockerfile` + `docker-compose.yml`（一条命令起，自带 Caddy 自动 HTTPS，可选）；② Cloudflare Worker 模板（`wrangler.toml` + README 里的「Deploy to Cloudflare」按钮说明），部署到用户**自己的** Cloudflare 账号；首次启动生成配对密钥并只打印一次（之后只存哈希）。无对话上限。协议带版本号，本机与转发器握手时校验兼容。
- 本机侧 `apps/server/src/chat-relay-client.ts`：外连、断线指数退避重连、心跳；连上后把访客消息喂给现有 `ChatChannelAdapter`，回复原路回去。

### B. 关机与离线
本机不在线（或免费额度到顶）→ 转发器对访客回「离线」→ 挂件自动切**留言表单**（邮箱 + 问题，可选订单号）→ 留言暂存转发器（加密、最多 7 天、条数上限），本机上线后拉走并清除，进「消息」页（`MessageSource = 'chat'`，只加）按邮件续聊。

### C. 收费在线档「客服增值服务」
订阅机制复用 WP118（能力 `support.service.monthly`，30 积分 / 月，term / cycle 幂等，余额不足宽限，不删数据，运营后台可赠送）。开通后：云端每工作区一个 `SupportTenantDO` 持有知识快照、边界 / 政策、会话与消息，关机时由云端 AI 应答（走 `/v1/ai/*` 计费，块 = `ai`）、需要人拍板的照样出卡（推 IM / 手机），本机上线后双向同步。**本轮做到：订阅 + 云端会话存储与同步 + 云端 AI 应答的最小闭环（只读知识快照、严格按边界，拿不准就转留言 / 转人工）**；更深的（云端改单、云端长程任务）在 docs 里留口。

### D. 工作台
- 客服岗位下「网站在线客服」职责默认启用；新页「聊天窗」：外观（品牌色取 DESIGN.md 若有、欢迎语、头像、位置、语言）、允许的域名、**转发方式三选一（官方免费 / 自建 / 客服增值服务）**、一段可复制的嵌入代码、实时预览、「测试连接」、本月对话数与上限。自建时填转发器地址 + 配对密钥（原生表单，进本机加密库）。
- 「进行中的对话」列表 + 对话界面（AI 在答 / 等你 / 你已接管；「我来接手」= 现有 takeover；「教一句」= 现有 teach）；对话收进「消息」页的一个来源筛选。
- 岗位页连接清单减字（docs/73 #4）：只列必需，可选折叠成一行。

### E. 文档
`docs/74-在线聊天三种部署-v1.md`（三条路对照表、协议、限额、离线留言、隐私：转发器看得到过路内容但不落盘）；`deploy/chat-relay/README.md` 给非运维的逐步说明；`docs/64` / `docs/67` / `docs/63` 同步；`docs/73` 改状态。

## 交付（每项一个提交，每项有测试；全用替身，不联网）
1 `packages/chat-relay` 核心 + 协议 + 两个适配 + 契约一致性测试；2 官方托管挂载 + 200 上限；3 自建部署包（`docker compose config` 校验、`wrangler deploy --dry-run` 过）；4 本机客户端 + 离线留言进消息；5 订阅 + `SupportTenantDO` + 云端应答最小闭环 + 同步；6 工作台三块界面 + i18n + 截图 `docs/assets/workstation/live-chat-*.png`；7 模拟场景（官方转发一问一答、关机留言续聊、额度到顶、自建转发、订阅后云端应答、接管）；8 docs。
