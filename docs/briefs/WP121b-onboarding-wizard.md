# WP121b 初始化向导重排（WP121 的后半）

worktree：`../agentsws-wt/wp121b-wizard`，分支 `wp/121b-wizard`（从 main 新起）。

WP121 前半已合入 main：注册赠送 10 积分、`packages/brand-intake`、`/v1/brand-intake/*`（`apps/server` 已装配）、`BrandProfileCard`、`intake.*` i18n、`docs/70`。**没做的是向导本体**。照 `docs/briefs/WP121-onboarding-ai-first.md` 的「定论」与 `docs/70`，把 `docs/35` 里 WP121 报告的「未完成」七条做完：

1. `apps/workstation/src/pages/onboarding.tsx` 重排为四步：**① 接上 AI → ② 你的生意 → ③ 选岗位 → ④ 连接与开工**（完成屏不变：一队上岗了 + 一变一队后接呼吸）；`onboarding.test.tsx`（841 行，按旧四步钉死）整份重写，覆盖不能比现在少。
2. ① 两张大卡：官方接口（邮箱 → 登录信 → 回环回来 → 自动关联、切到「用 Agents 工坊的」、显示到账 10 积分）/ 自有模型（现有表单 + `POST /v1/models/providers/:id/test` 的结果 gate「下一步」，错误四句人话见 docs/70 §2.2）；「先逛逛演示数据」旁路；不能跳过。
3. 向导期间不出「还没接模型」黄条（`no-model-banner`）；走了旁路完成后才出。
4. ② 接 `/v1/brand-intake/*`：`lib/api.ts` 五个函数、后台跑 + 轮询、呼吸标记表示在干活、挂 `BrandProfileCard`、可先去 ③ 再回来、开跑前显示积分预估与封顶、「还没有网站」旁路、「重新分析」不覆盖手改。原「公司设置 / 个人设置」并进这一步（结果里顺带确认公司名与称呼）。
5. ③ 按分析结果预勾岗位（docs/70 §5 对照表），都可改。
6. `seedKnowledge` 接 `packages/knowledge`（首批知识条目标来源「自动分析，待核」）。
7. 用官方接口跑分析时，界面上用一句人话说明「网页内容会经过 Agents 工坊的云来分析」。
8. 模拟场景四条（WP121 交付 5）+ 截图 `docs/assets/workstation/onboarding-{ai,intake,profile}.png`（demo 端口 4407）。

减字、图形化（Luoye 上一轮对向导的四条意见仍然有效：文字尽量少，进度条图形化）。并行提醒：WP117 / WP125 也在改工作台别的页面与 `lib/i18n.ts`、`lib/api.ts`——这两个大文件只做追加，别重排。验证用 `scripts/verify-changed.sh`；动了模拟包跑两个包的门禁并重定基线。
