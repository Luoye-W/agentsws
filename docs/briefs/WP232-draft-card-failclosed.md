# WP232 真模型实测：起草回复出不了卡（fail-closed）+ 每次都冒一张无关的「订阅费退款口径」卡 + 过程话用了英文

worktree `../agentsws-wt/wp232-draftcard` · 分支 `wp/232-draftcard`（从 main 新起，已含 WP230 / WP226）。先读 `_common.md`、WP230 / WP226 报告、审批 / 提案那套（grep `fail-closed`、`未获批准`、`draft_reply`）、规则脑 / 政策问答出卡（grep `policy_change`、`subscription_refund`）、`replyLanguageSection`。

## 现象（Fable 10-05 本机 dev-real，真模型 deepseek-chat，红人营销 → kol.youtube）
任务：「一位 YouTube 红人用英文回信 …… 帮我起草一封回复，先别发，给我看稿。」
1. **好的**：WP230 修好了（没有再吐 `[calling …]`）；回给红人的草稿是英文（回复语言规则生效）。
2. **坏 ①**：模型调 `draft_reply`（正文是完整英文草稿），工具回 `draft_reply 未获批准（fail-closed）`；模型最后对用户说「出卡没成功：这次提案走了审批闸，答案位没人应答，系统按 fail-closed 拒了」。起草回复本应**出一张待批卡**（人在卡上批了才发），不该在回合里同步等人应答、没人应答就拒。查清这条「同步审批 / 答案位」从哪来（dsh 权限请求？审批闸的同步模式？），修成：`draft_reply` 这类「出卡给人批」的动作直接建卡、回合正常结束，卡里是草稿；绝不因为「没人在线」就丢草稿。三条运行时一致；补端到端测试（真路由、无人在线也能出卡）。
3. **坏 ②**：每跑一次就 `approval.created` 一张 `policy_change`「订阅费的退款口径是什么？」（dedupe_key `ws_…:policy_change:policy.subscription_refund`，revision 1 → 2 → 3，09-30 起每次都冒），而且被当成这次 run 的 proposal 输出挂上。和红人回信毫不相关。查清是谁在出这张卡（政策缺口探测？规则脑？），为什么固定是这个主题，为什么挂到别的 run 上；修好并加测试（不相关的缺口不出卡、同一缺口不反复 bump、不挂到无关 run）。
4. **坏 ③**：中间过程话（给用户看的 `text.delta`，如「I'll pull the playbook…」「Let me find who this creator is…」）用了英文——对内应按界面语言（中文）。只有发给外部的稿子跟来信语言。调 `replyLanguageSection` 的措辞 / 位置（或在发外部稿的工具参数里单独约束语言），用评测或替身测试钉住；真模型复测交 Fable。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰（Fable 的 dev 数据目录只读可查事件：`~/Library/Application Support/agentsws-dev/events.db`，只读、不改）；不连 Luoye 的 Windows。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh（有漂移逐条说明）+ `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP232.md`（根因三条分别写，要 Luoye 定的事单列）。合并后 Fable 真模型复测同一任务。
