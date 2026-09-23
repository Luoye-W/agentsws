# WP132 dsh 升级：0.1.6-alpha.2 → 0.1.7-rc.1

worktree `../agentsws-wt/wp132-dsh` · 分支 `wp/132-dsh`（从 main 新起）。

## 背景
Luoye 09-23：「DeepSeek harness 0.1.7.2 更新了，升级到最新版」。npm 实查（09-23）：**没有 `0.1.7.2` 这个号**；`@deepseek-ai/dsh` 的 dist-tags 是 `latest = 0.1.5-rc.3`、`next = 0.1.7-rc.1`（09-23 发）、`alpha = 0.1.7-alpha.2`（09-22）。他说的应是 **0.1.7 系列最新 = `0.1.7-rc.1`**，按它升；报告里写清 npm 上实际有哪些号。我们现在钉在 `0.1.6-alpha.2`（WP93）。四个包一起升：`@deepseek-ai/dsh`、`dsh-agent`、`dsh-agent-loop`、`dsh-agent-presets`。

## 做法：严格照 `docs/42` 的 checklist，一步不跳
① 基线（升级前先跑并存档：`packages/dsh-adapter` 全部用例数、两个模拟包 dsh 运行时 fast 档结果与指标、`--rewrite-baseline` 前的基线快照、seam 清单）→ ② 观察上游（读 0.1.6-alpha.2 → 0.1.7-rc.1 之间的 CHANGELOG / release notes / 提交摘要，列出改了什么、废弃了什么、新增了什么；**docs/53 与 docs/35 09-16 那条「能用 dsh 官方方案的都用官方」——上游这版若把我们自己做的东西官方化了（浏览器技能、会话日志上报、preset、cordis.patch、三栏 / 沙箱终端…），列出来并给「换官方」的建议与工作量**，本单不动手换，只列）→ ③ 改版本号看依赖树变化（`pnpm install`，diff lockfile，新增 / 移除的传递依赖逐个看许可证与体积）→ ④ 修 seam（先编译；逐个 seam 对着新 `.d.ts` diff；上游 bundle 的 `cordis.patch.yml` 那一面；④bis 默认值扫描）→ ⑤ 重判上次（WP70 / WP93）放弃的选项 → ⑥ 升级后重跑 ①，逐条比：用例数、模拟指标（token / cost 漂移 > 5% 要解释）、seam 数 → ⑦ 全仓验证与收尾。七条红线照 docs/42 §2。

## 验证
`scripts/verify-changed.sh` + `vitest run packages/dsh-adapter packages/runtime-direct packages/simulation apps/server`（dsh-adapter 全量）+ 两个模拟包 **dsh 运行时** fast 档门禁（`--runtime dsh`；指标漂移按惯例处理并写明涨跌）+ `pnpm -F @agentsws/desktop package --dir` 起得来（dsh 子进程运行时随桌面壳走）。`docs/42` 末尾按格式记这一次；`upstreams.yml` 的 dsh 条目版本同步；`docs/35` 记「WP132 完成，待审」。

## 报告额外要一节
「0.1.7 里官方化了我们哪些自研」：逐条 = 我们的实现 / 官方对应物 / 换不换的建议 / 工作量 S-M-L。这一节直接决定下一批派工。
