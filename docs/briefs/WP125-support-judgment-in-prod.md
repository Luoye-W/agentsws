# WP125 客服判断层接进生产：邮件进来 → 分拣 → 判断 → 出卡 / 回复（P0，排在在线聊天之前）

worktree：`../agentsws-wt/wp125-support-prod`，分支 `wp/125-support-prod`。

## 为什么（docs/72 头号发现，Fable 已用 grep 核实）
`packages/support-core` 的 `draftReply` / `computeSla` / `shouldEscalate` / `evaluateAutonomyGates` / `findUnansweredBoundary` / `knowledgeCandidate` 在 `apps/server` 与 `packages/api` 下**生产引用数为 0**，只活在 `packages/simulation/src/world.ts` 与单测里。真邮件进来走的是通用 Agent + 一份提示词技能，**没有门**；demo 里看到的「通」是合成世界。Luoye 定：**判断逻辑肯定要放最前面**——「消息」接了邮箱之后就要对邮件分类（WP113 已做分拣），分出来的客服信下一步必须进这套判断。

## 先读
`docs/72`（全文，尤其 §P0-1 / P0-2 / P0-3 与证据路径）、`docs/73`、`docs/63`（消息与分拣：`route = 'support'`、`kefuagents` 文件夹）、`docs/48` §4、`docs/18`、`docs/37`、`docs/36`；代码 `packages/support-core/**`、`packages/simulation/src/world.ts`（判断层今天是怎么被串起来的——照它的顺序接）、`apps/server/src/{messages.ts,channels.ts,chat.ts}`（chat.ts 是唯一已端到端接线的，照它的形状）、`packages/channels/src/messages/triage.ts`、`packages/core/src/{fencing.ts,secret-patterns.ts}`、`packages/deck`（卡片排版）。
只读参考 `/Users/yeluo/Documents/KefuAgent`（`containsInstructionVerbatimLeak`、敏感标识打码、037 知识缺口等待闭环），不读 `.env*`。

## 交付
1. **接线（只接线，不改 support-core 已有签名）**：消息分拣判为 `support` 的来信（及在线聊天话轮）→ 线程归并 → 意图分类 → 边界 / 政策判定 → `evaluateAutonomyGates`（三道自主门）决定：自动回 / 出「回复草稿待审」卡（outbound 排版）/ 出「业务边界问题」选择题卡（`findUnansweredBoundary`）/ 升级给人（`shouldEscalate` → handoff 卡）；`computeSla` 接进巡检（超时没回的来信进岗位面板与通知，不是卡）；「教一句」接 `knowledgeCandidate`。三运行时（stub / direct / dsh）结论一致。验收：上述六个函数在 `apps/server` 下生产引用 ≥ 1（可 grep）。
2. **两道纪律守卫**：① 敏感标识进 prompt 前打码（卡号过 Luhn、CVV、验证码、密码；**打码先于围栏**；原文仍留在受控原始材料区，界面上对有权限的人可见）；② 教 AI 的指导原文泄漏守卫（投递前检查回复是否逐字引用了商家那句话，命中则重写一次，再命中转人工审）。两条都进邮件线与聊天线。
3. **知识缺口等待闭环 + 卡片优先级带**：答不上来 → 落缺口并记 `waitingCount`（按线程去重，零新表）→ 对客先回一句不承诺的预期（AI 现写）→ 面板「待补知识」按等待人数排序 → 商家补完 → 给每个等待者各出一张 `pending_review` 草稿卡（路径里零直发）。卡片派生优先级带：客户在等 / 待你确认 / 需要处理 / 无人等待（**派生，不存列**）。
4. **demo 与真实分清**：界面上凡是合成世界的数据带一个不显眼但始终在的「演示数据」标记；真实工作区里绝不出现合成数据（KefuAgent 07-28 栽过这个跟头）。顺手修 docs/72 指出的两个小 bug：demo 种子没启用 `dtc.live-chat`；岗位页「N 条职责」的计数与 yml 对不上。
5. **继承 KefuAgent 的六条「永不做」**进 `docs/36`（Pre-chat 留资表单、手动客户标签、分流路由矩阵、CSAT 弹窗、快捷回复库、工单字段构建器）与判据「内容与运营归数据、授权与边界归人」；并写明 Luoye 09-19 定：**不做人工直接回复客户，只有教 AI**（邮件线同样：岗位信件不给回复框；非岗位的普通邮件仍由人自己回，见 docs/63）。
6. 模拟场景：真邮件路径上的三道门各一条、敏感标识打码、泄漏守卫命中重写、缺口等待 3 人补完后出 3 张草稿卡、SLA 超时进面板不出卡；基线按惯例重定。`docs/72` / `docs/73` 改状态。

## 验证
`scripts/verify-changed.sh` + 两个模拟包门禁（动了场景）。
