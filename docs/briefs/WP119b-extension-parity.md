# WP119b 浏览器插件：功能与信息量对齐 KOLAgents 插件 0.9.20

worktree：`../agentsws-wt/wp119b-ext-parity`，分支 `wp/119b-ext-parity`（从 main 新起）。

## 为什么
Luoye 看了 WP119 的面板截图：「这比 KOLAgents 插件少了好多数据」。属实——旧插件卡片部分约 3500 行界面（`CreatorCaptureCard` 705、`ContactPanel` 833、`ContentCaptureCard` 877、`ValuationSection` 254、`WorkspacePanel` 257、`BioLinkCaptureStrip` 256、`AuthenticityBlock` 151、`SyncStatusPanel` 125），新插件面板只有 650 行、三个数字一个按钮。WP119 的派工单只写了「参考重做」却没把**功能对齐**写成验收，这张单补上。WP119 的架构（本机直连、配对、排队补传、权限最小化、登录即共享公共库并如实告知）**全部保留**，只补信息量与功能。

## 先读
旧插件（只读，不读 `.env*`）：`/Users/yeluo/Documents/Browser Extension - Influencer Assistant`——`docs/PRD.md`、`docs/TECHNICAL_SPEC.md`、`src/contents/components/*.tsx`（上面八个 + `GatedSection` / `LoginNudge` / `SearchCaptureFab` / `PanelShell`）、`src/lib/{authenticity,valuation,valuationConstants,localHealth,bioLinkCache,creatorFields,bulkCapture,exportRow,workspacePayload}.ts` 及其 `__tests__`。先**装起来看一遍真实效果**不可行时，至少把每个组件渲染出的区块与字段列成一张清单。
本仓：`docs/68`、`apps/extension/**`、`apps/server/src/extension-*.ts`、`packages/api/src/routes/extension*.ts`、`packages/kol-core`（打分 / 体检 / 合并建议）、`packages/kol-public`（reveal 计费）、`docs/48` §5、`docs/36`（减字：信息要全，但靠分区与折叠，不靠堆字）。

## 交付
1. **对齐清单** `docs/68` 新增一节：旧插件每个区块 / 字段 / 动作 → 新插件状态（有 / 补 / 不做及理由）。「不做」必须有理由，默认是补。
2. **频道页面板补齐**（分区、可折叠、首屏先给结论）：红人体检（结论 + 依据）；**受众真实性**（假粉判断，算法与旧 `authenticity.ts` 同输入同输出）；**频道价值**（估值 / 合作报价参考区间，`valuation.ts` 同输入同输出，标「估算」）；指标：粉丝、均播、播放 / 粉丝、上传频率、最近 N 条视频表现（小条形图）、**粉丝趋势**（本地有历史观测就画，没有就说「再来几次就有趋势了」）；国家 / 语言 / 类目；**其他平台与外链**（从简介抓 IG / TikTok / 个人站 / Linktree，串成同一人，喂给 `kol-core` 的合并建议）。
3. **联系方式面板**：页面上找到的邮箱（用户显式点了才采）；已登录时「查看红人邮箱 · N 积分」经本机服务走云端公共库 reveal（价格取 `pricing.json`，余额不足说人话）；贡献联系方式换免费额度；本地已有联系方式的直接显示脱敏形态。
4. **视频页**：本条内容数据（播放、点赞、评论、时长、发布时间、是否带货 / 有无广告标识）、内容体检、作者速览、「存入内容库」。
5. **存入时选品牌与活动**：「收进红人库」旁可选品牌（工作区）与活动 / 候选池（从本机服务拉），记住上次选择；已在库里则显示「已在红人池 · 上次更新 X」+「更新红人数据」；「去工作台看」跳到该红人的合作线程。
6. **同步状态条**：已存入 / 已排队（应用没开）/ 已共享到公共库 / 失败原因，一行说清。
7. 搜索结果页批量采集保持现状并补：每行结果旁的小体检徽标、阈值筛选记忆。
8. 本机服务与 API 按需**只加不改**（新字段进 `extra` 或新可选字段）；送往公共库的仍是窄行（WP119 的定论不变）。
9. 测试：体检 / 真实性 / 估值三套算法与旧插件逐例对拍（把旧 `__tests__` 的用例搬成我们的夹具，数值一致）；面板各分区的渲染测试；reveal 计费与余额不足。
10. **验收证据**：同一个 YouTube 频道夹具，旧插件面板的字段清单 vs 新面板截图并排放进 `docs/68`（`docs/assets/extension/parity-*.png`）；面板首屏不超过一屏高，其余折叠。

验证：`scripts/verify-changed.sh` + `pnpm -F @agentsws/extension build`。并行提醒：WP117b 在改工作台红人界面与 `kol-core` 工具层——对 `kol-core` 只做最小追加。
