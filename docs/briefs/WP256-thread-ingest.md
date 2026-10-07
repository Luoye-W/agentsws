# WP256 「群里的帖子」自动进帖：Reddit 自家版新帖入库 + Discord 频道消息拉取（决策 147）

worktree `../agentsws-wt/wp256-ingest` · 分支 `wp/256-ingest`（从 main 新起，含 WP249 / WP254 / WP255）。先读 `_common.md`、WP249 报告（自家版待处理：官方号浏览器 / OAuth 读 modqueue / unmoderated、限速）、WP254 报告（社媒库线程、`social-executor`）、WP255 报告（「群里的帖子」快捷视图、`POST /v1/social/own-sub/thread`、空态照实写）、`packages/social-core/src/channels/discord.ts`（Discord 适配器）、社媒定时任务（每 5 分钟补扫那条）。

## 背景（Luoye 10-07 同意 147）
「群里的帖子」现在只有经接口送进来的线程，真用户打开多半是空的。

## 要做
1. **Reddit 自家版新帖入库**：WP249 读自家版队列时（unmoderated / 新帖）顺手把帖子记成社媒库线程（同一条只记一次，按 fullname 去重），进「群里的帖子」；不判类、不出卡；只对登记为自家版的 subreddit。读的频率不增加（复用 WP249 的读，不另起轮询；没打开视图时由已有的低频定时读一次即可，限速照旧）。
2. **Discord 自动拉取**：已连接的 Discord 机器人，对品牌登记的频道按低频（默认 15 分钟，可调）拉新消息存成线程（按消息 id 去重，记上次读到的位置）；只读，不回复、不加反应。连接没开读消息权限时照实提示缺哪个权限。
3. 「群里的帖子」空态文案按渠道照实说「这个群还没有新帖」/「还没连上，去连接页」。
4. 测试：假 Reddit 页面 / 假 Discord API 覆盖入库、去重、断点续读、限速、没权限提示。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；不访问真实 reddit.com / discord.com；不登录任何网站。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP256.md`（要 Luoye 定的事单列）。
