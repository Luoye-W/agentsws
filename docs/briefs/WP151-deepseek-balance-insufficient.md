# WP151 DeepSeek 余额不足：说人话 + 给「去充值」

worktree `../agentsws-wt/wp151-ds-balance` · 分支 `wp/151-ds-balance`（从 main 新起）。先读 `_common.md`、`docs/briefs/reports/WP150.md`（402 那一条）、
`packages/model-gateway/src/providers/deepseek-account.ts`、`apps/server/src/deepseek-account.ts`、`apps/server/src/models.ts`、工作台 `components/models/deepseek-account-login.tsx`、`lib/error-text.ts`（WP139 的错误人话）；
官方 `@deepseek-ai/dsh-deepseek-account-platform@0.1.7-rc.2` / `dsh-llm-deepseek` 里「额度不足」的判定与提示（rc.2 release 说明：「额度不足时显示与当前任务匹配的提示，避免 API Key 用户误充到登录账号」）。

## Luoye 09-26 定
需要余额不足提示。

## 要做（两条模型路都要，照官方的分法：账号那条引到账号的充值页，API key 那条引到开放平台的充值页，别让 API key 用户充错到登录账号）
1. **判定**：照官方——DeepSeek 推理口 402（及官方认作余额不足的错误码）= 余额不足；它**不是**登录失效（WP150 已经不当失效处理，保持）。
2. **那次运行**：失败原因写人话「DeepSeek 账号余额不足，充值后再让它接着做」（账号路）/「DeepSeek API 余额不足，去开放平台充值后再试」（key 路），不是泛泛的网关错；事项时间线同一句。
3. **模型卡 / 顶栏**：账号卡出现一行醒目提示 +「去充值」（账号路用官方 `links.topUpUrl`；key 路用开放平台充值页）；余额刷新后提示自动消失。三步验证里第 ② 步遇到 402 也用这一句（`dsa.err.balance` 已有，统一口径）。
4. **不自动切别的来源**：余额不足不偷偷换模型，只提示（与 WP150 同理）。
5. **测试**（全替身、不联网）：账号路 402 → 运行失败原因 + 卡片提示 + 充值链接是账号的；key 路 402 → 开放平台充值链接；余额恢复后提示消失；登录状态不变（不是失效）。

## 纪律
不登录真账号、不联网；不跑批量清理命令；不读 .env*。截图 demo 端口 4440。

## 验证（审核方全量用）
`vitest run packages/model-gateway apps/server apps/workstation packages/runtime-direct packages/dsh-adapter`；fast 模拟 dtc-3c-3p 三个运行时（应零漂移）。
