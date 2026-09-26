# WP152 DeepSeek 两种连接合成一张卡：用户自己选「官方 API 接口」或「官方账户登录」

worktree `../agentsws-wt/wp152-ds-card` · 分支 `wp/152-ds-card`（从 main 新起）。先读 `_common.md`、docs/36（界面规范）、docs/70（初始化向导：先接 AI）、
`docs/briefs/reports/WP134.md`（账号登录卡）、`WP127` 报告（三步验证）；代码：`apps/workstation/src/components/models/models-panel.tsx`、
`components/models/deepseek-account-login.tsx`、`components/onboarding/ai-step.tsx`、`pages/settings.tsx`、`lib/i18n.ts`；服务端模型模板 `apps/server/src/models.ts`（只动展示名 / 模板分组，**不改 provider id 与存储**）。

## Luoye 09-26 定（真账号冒烟时提的）
1. **DeepSeek 官方 API 和 DeepSeek 账号登录放到一张卡**，用户自己选用哪种方式连接。
2. **已连接的显示也改**：两条分别叫「**官方 API 接口连接**」与「**官方账户登录**」（卡片标题都是「DeepSeek 官方」）。

## 要做
1. **「加一个」里**：DeepSeek 只剩一张卡「DeepSeek 官方」，卡里一个二选一（照 OpenAI / Anthropic 那两张卡现成的「方案」切换写法）：
   - 「官方账户登录」：不用建 key，浏览器里登录一次 DeepSeek 账号，按账号余额扣（原账号卡的内容与按钮，含余额、赠送、去充值、登出、失效提示——WP150 / WP151 的行为一个不丢）；
   - 「官方 API 接口连接」：去开放平台建 key 填进来（原 DeepSeek 官方 key 卡的步骤与表单）。
   默认选哪个：**官方账户登录**排第一且默认选中（不用建 key，对非开发者最省事）；已经配过 key 的用户打开时默认显示他已有的那种。
2. **「已配的」列表里**：两条分别显示「DeepSeek 官方 · 官方 API 接口连接」与「DeepSeek 官方 · 官方账户登录」（型号、地址 / 境内、测试结果照旧）；两条可以同时存在（用户可能两种都配），「哪件事用哪个模型」的下拉里名字同步改成这两个叫法。
3. **向导第 ① 步**：原来三张大卡（官方积分 / 自带 key / DeepSeek 账号）里，DeepSeek 相关的也合成一张，内部同样二选一；其他卡不动。
4. 只改展示与分组：provider id（`deepseek`、`deepseek-account`）、存储、接口、计费、事件**一律不变**；已有用户升级后配置原样可用（加一条测试：老数据里两条都在时，新卡片正确显示两条已配）。
5. 文案白话；截图：设置页「加一个」的合并卡两种选中态、「已配的」两条、向导第 ① 步，到 `docs/assets/wp152/`。

## 纪律
不登录真账号、不联网；不跑批量清理命令；不读 .env*。Luoye 正在主仓 4317 端口的本机服务上做真账号冒烟，别碰主仓目录与 4317。截图 demo 端口 4441。

## 验证（审核方全量用）
`vitest run apps/workstation apps/server`；走查脚本 `node scripts/walkthrough-beta.mjs --port 4441 --only A`（向导那段）不退化。
