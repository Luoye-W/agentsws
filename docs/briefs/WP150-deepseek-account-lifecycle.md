# WP150 DeepSeek 账号登录跟上官方 rc.2：失效自动登出并提示、退出前确认并停掉账号任务

worktree `../agentsws-wt/wp150-ds-account` · 分支 `wp/150-ds-account`（从 main 新起）。先读 `_common.md`、`docs/briefs/reports/WP134.md`、`docs/briefs/reports/WP149.md`（「需要 Luoye 定」第 1 条与第 9 节）、
`packages/dsh-adapter/src/deepseek-account.ts`、`apps/server/src/deepseek-account.ts`、`packages/model-gateway/src/providers/deepseek-account.ts`、工作台 `components/models/deepseek-account-login.tsx`；
官方 `@deepseek-ai/dsh-deepseek-account-platform@0.1.7-rc.2` 的 README 与源码里「登录失效」「退出前停止账号任务」那两处（release 说明原话：「账号任务与 API Key 任务使用独立的模型入口；退出账号前会确认并停止运行中的账号任务，登录失效时提示重新登录」）。官方 MIT，照它的做法移植，文件头写出处。

## Fable 09-25 定（WP149 报告第 1 条）
两件都跟官方做——现状是缺陷：平台那边登录失效后，界面仍显示「已登录」，之后每次用账号跑都失败；退出账号后正在用账号跑的任务在下一次调模型时才失败。

## 要做
1. **登录失效**：推理口或平台口回「登录失效」（按官方判定口径：哪些状态码 / 错误码算失效）时，照官方把本机凭据清掉、状态变成「未登录」，
   模型卡上说人话「DeepSeek 账号的登录过期了，点一下重新登录」，这条模型来源在网关里摘掉（和手动登出同一条路），正在跑的那次运行给一句清楚的失败原因（不是泛泛的网关错）。
2. **退出前确认并停任务**：设置页点「登出」时，若有运行正在用这条账号来源，确认框里列出会停掉哪几件事（人话，事项名），确认后先停这些运行、再登出；没有在跑的就照现在的确认框。
3. 秘书 / 首页的「还没接模型」提示与三步验证状态跟着失效一起更新。
4. 测试（全替身、不联网）：推理 401 / 平台登录失效 → 状态未登录 + 模型来源摘掉 + 那次运行的失败原因；登出时有 / 没有在跑的账号任务两条；令牌守卫（WP134 那一套）不退化。

## 纪律
不登录真 DeepSeek 账号、不联网；不跑任何批量清理命令；不读 .env*。截图用 demo 端口 4439。

## 验证（审核方全量用）
`vitest run packages/dsh-adapter packages/model-gateway apps/server apps/workstation`；fast 模拟 dtc-3c-3p 三个运行时（应零漂移）。
