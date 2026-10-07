# WP257 进帖自动判类打标签、Discord 频道显示真名、Telegram 群只读拉帖（决策 152 / 155 / 156）

worktree `../agentsws-wt/wp257-tags` · 分支 `wp/257-tags`（从 main 新起，含 WP256）。先读 `_common.md`、WP256 报告（`social-ingest.ts`、`ingest_state`、Discord 只读口、「群里的帖子」空态）、WP255 报告（回复按钮）、社媒库线程判类（社群职责原有的判类 / 客服转接逻辑）、`packages/social-core/src/channels/telegram.ts`。

## 要做（Luoye 10-07 同意）
1. **（152）自动判类打标签、不出卡**：自动进来的帖子（Reddit 自家版新帖、Discord、以后的 Telegram）入库后判一类并打标签：客户问题 / 售后 / 产品反馈 / 闲聊 / 广告垃圾 / 其他（沿用社群职责已有的类目，没有就按这几类）。先按规则判（关键词 + 渠道 + 是否 @品牌），可选「模型复核」默认关；**不出卡、不转客服**。「群里的帖子」按标签筛选；首页 / 数据看板记一个按类计数，方便跑一两周看量。
2. **（155）Discord 频道显示真名**：登记频道时读一次频道名（只读接口），显示「#general」；读不到退回「#频道 id 末四位」。已登记的老频道下一轮拉取时顺手补名。
3. **（156）Telegram 群只读拉帖**：已连接的 Telegram 机器人对品牌登记的群低频拉新消息（与 Discord 同一套：去重、断点续读、限速退避、缺权限照实提示——如机器人的 privacy mode 开着读不到群消息，要写明怎么关）；只读，不回复。登记入口与「群里的帖子」空态照 Discord 做。
4. 测试：假 Telegram API 覆盖入库 / 去重 / 续读 / privacy mode 提示；判类规则用例；Discord 频道名读取与回退。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；不访问真实 discord.com / telegram.org；不登录任何网站。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP257.md`（要 Luoye 定的事单列）。
