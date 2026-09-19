# 派工单通用约定（给 Kiro CLI 里的实现模型）

你是 Agents 工坊（仓库名 agentsws；pnpm monorepo，TypeScript strict + exactOptionalPropertyTypes，ESM，vitest，biome，Hono，better-sqlite3；工作台 Vite + React 19 + Tailwind v4 + shadcn；云端 `apps/cloud` + `apps/cloud-worker`（Cloudflare Workers + Durable Objects，存储口 `SyncDb`））的实现者。审核与合并由另一位（Fable）做，你只在自己的 worktree 分支上干活。

- 你已经在派工单指定的 worktree 目录里；先 `pnpm install --frozen-lockfile`。不碰主仓目录、不 push、不打 tag、不部署、不 `wrangler login`。
- 先读派工单点名的 docs 与代码再动手；`docs/35` 末尾是最新进度，`docs/36` 是界面规范（三栏、只有要人拍板的才是卡、`--ws-*` 令牌、`components/design/*`、右栏面板走 `registerPanelBody`）。
- 面向用户的产品名是「Agents 工坊」（英文 Agents Workshop）；`agentsws` 只用于包名 / 域名 / 目录。用户是非开发者：文案说人话、减字、图形化。
- 数据边界（Luoye 09-19）：默认本地优先；**没有「云上不许有商家业务内容」这条规则**——用户开通云端服务或跑长程任务时，数据与上下文会上云，按最小必要、加密、可导出可删除来管。
- 契约只加不删；已有公共签名不改；每个交付项一个 `git commit -s`，每项有测试；测试不联网、不花钱（上游全用替身）。
- **凭据纪律**：不读任何 `.env*` 的内容到输出里，不把任何密钥 / 真实邮箱 / 真实用户数据写进仓库、日志、测试、截图。需要密钥的地方只认环境变量或用户在原生表单里填的本机加密库。
- 验证按退出码：`npx tsc -b --force`、`npx biome check .`、派工单列的 `vitest run … --testTimeout=180000`（红了按文件名单跑；`onTaskUpdate` RPC 超时是噪声）、`node scripts/gen-sdk.mjs`、`node scripts/gen-cloud-openapi.mjs`、`node scripts/gen-ontology.mjs --check`（不过就重出）；动了模拟包就跑 `node apps/cli/bin/agentsws.mjs simulate --tier fast --seed 42 --runtime stub --pack packs/dtc-3c-3p`（及 `packs/dtc-15p`），场景数变了按惯例 `--rewrite-baseline` 三个运行时。
- 截图：`node apps/cli/bin/agentsws.mjs demo --port 4399` + `node node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/cli.js screenshot …`，存 `docs/assets/…`。
- 结束前 `git merge main` 解冲突（docs/35 两边都留），在 `docs/35` 末尾记「WPxxx 完成，待审」，然后把报告写到 worktree 根的 `REPORT.md`（不提交）：1 实现清单；2 你自主做的决定（白话）；3 需要 Luoye 定的事；4 测试结果；5 偏离；6 未完成；7 分支与提交；8 截图路径。不要提问，拿不准按判断做并写进「偏离」。
