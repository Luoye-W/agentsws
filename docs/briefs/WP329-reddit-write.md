# WP329 Reddit 写：AI 起草 → 审批卡 → 插件填进页面 → 人点发送 → 记录（docs/102；决策 663 / 667 / 669 / 708 等）

worktree `../agentsws-wt/wp329-redditwrite` · 分支 `wp/329-redditwrite`。先读 `_common.md`、`docs/102`（**以文末「Luoye 10-14 定」为准**）、`docs/briefs/reports/WP313.md`、WP249 Reddit 官方号通道（发帖 / 回帖 / `reply_thread` / `submitApprovedPost`）、WP322 FAQ 知识卡与检索、WP323 发出记录与记录去处、`packages/social-core/src/voice.ts`（VoiceCard / checkOutbound）、`docs/96`。

## 已定（照做）
- **Reddit 发帖与回复永远人批**（663）：把代码里 `reply_thread` 能升级成自动发的口子改掉。
- 写走插件：审批后插件在用户已登录的 Reddit 页面里**把草稿填进评论 / 回复 / 发帖框**，**由人点发送**（第一版）；发出后插件读回确认、拿到链接。不做程序登录，不伪装。
- 起草要**查知识库**（WP322 导入的 FAQ 卡）+ 品牌语气（VoiceCard）+ 帖子上下文（708）；不替用户预设推广规矩（664 被否）。
- 支持：回复收件箱里的回复 / @、回自家版块帖子、楼中楼（回复别人的回复）、在别人版块评论、发新帖；修掉「去别人版块发的帖批了也发不出去」（`submitApprovedPost` 没人调用）。
- 每条发出的都进 WP323 本地发出记录；对方的后续回复挂回原行；配了「记录去处」就按映射写（INMO 记到我们自己的飞书表）。
- 审批人只有 Luoye（669）。

## 要做
1. 起草服务（Reddit 专用提示：版块规则文本作为上下文、FAQ 命中、语气、原帖 / 原评论）；出审批卡（docs/96「对外发」家族），卡上能改字。
2. 插件写动作：定位到目标帖 / 评论、展开回复框、填入草稿、等人点发送、读回拿链接；超时 / 被拦就停并照实报。
3. 接通 `submitApprovedPost`、楼中楼回复；关掉自动发。
4. 写发出记录（WP323 的写入点）。
5. 测试：替身 Reddit 页面（本地假页面）、替身插件；不打开真 Reddit。

## 纪律
同 WP328。WP328（读）并行：它产出「待处理」条目，你接它的接口（报告里对齐）。

## 验证
`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包 × stub/direct/dsh + gen 检查 + 插件构建 + 真 Chromium 本地假页面端到端 + 装包前冒烟；报告 `docs/briefs/reports/WP329.md`（决策号 760–764）。
