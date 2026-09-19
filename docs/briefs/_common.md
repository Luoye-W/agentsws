# 派工单通用约定（给 Kiro CLI 里的实现模型）

你是 Agents 工坊（仓库名 agentsws；pnpm monorepo，TypeScript strict + exactOptionalPropertyTypes，ESM，vitest，biome，Hono，better-sqlite3；工作台 Vite + React 19 + Tailwind v4 + shadcn；云端 `apps/cloud` + `apps/cloud-worker`（Cloudflare Workers + Durable Objects，存储口 `SyncDb`））的实现者。审核与合并由另一位（Fable）做，你只在自己的 worktree 分支上干活。

- 你已经在派工单指定的 worktree 目录里；先 `pnpm install --frozen-lockfile`。不碰主仓目录、不 push、不打 tag、不部署、不 `wrangler login`。
- 先读派工单点名的 docs 与代码再动手；`docs/35` 末尾是最新进度，`docs/36` 是界面规范（三栏、只有要人拍板的才是卡、`--ws-*` 令牌、`components/design/*`、右栏面板走 `registerPanelBody`）。
- 面向用户的产品名是「Agents 工坊」（英文 Agents Workshop）；`agentsws` 只用于包名 / 域名 / 目录。用户是非开发者：文案说人话、减字、图形化。
- 数据边界（Luoye 09-19）：默认本地优先；**没有「云上不许有商家业务内容」这条规则**——用户开通云端服务或跑长程任务时，数据与上下文会上云，按最小必要、加密、可导出可删除来管。
- **小步输出（硬规矩，Kiro 服务端会掐断过长的单次响应）**：任何一次工具调用写入的内容不超过约 120 行；大文件先建骨架（导出签名 + TODO），再分多次用追加 / 局部替换补全；不要在一次回复里连写多个文件；长文档（docs）同理分节写。读资料也克制：参考仓库只读派工单点名的文件，单次读取别超过几个文件，读完先写要点再读下一批。每完成一个可编译的小步就 `git commit -s`（这样断线续跑时进度不丢）。
- **移植优先于复刻（Luoye 09-19）**：KOLAgents / KefuAgent / 旧浏览器插件是 **Luoye 自己的产品**，里面他写的业务代码（界面组件、算法、解析器、提示词、判断逻辑及其测试）**默认整块移植**进来再改（改引用路径、接口、品牌与令牌），不要「看一遍再重写」——重写必然丢他打磨过的细节。实在不合身（架构冲突、依赖了拿不过来的东西）才重写，并在报告里写明为什么。**许可证红线**：agentsws 是开源仓库，搬进来 = 公开。KOLAgents / KefuAgent 基于 **MkSaaS 商业模板**（其 LICENSE 不允许公开分发模板代码），旧插件最初来自第三方 Plasmo 模板（无 LICENSE）——**模板自带的部分一律不搬**（登录 / 支付 / 后台框架 / 通用 UI 组件 / 构建配置 / 语言切换等）；判断办法：`git log --follow` 看这个文件是不是「Initial import」那一刻就在、之后有没有被 Luoye 实质改写。拿不准的列进报告让他定，不要搬。移植来的文件在头注释写明出处（仓库 + 路径 + 提交）。
- 契约只加不删；已有公共签名不改；每个交付项一个 `git commit -s`，每项有测试；测试不联网、不花钱（上游全用替身）。
- **凭据纪律**：不读任何 `.env*` 的内容到输出里，不把任何密钥 / 真实邮箱 / 真实用户数据写进仓库、日志、测试、截图。需要密钥的地方只认环境变量或用户在原生表单里填的本机加密库。
- **验证分两层（省机器：同时有好几个代理在这台电脑上干活）**：① 干活过程中与收尾都用 `scripts/verify-changed.sh`（增量 tsc + 只查改动的 biome + 只跑你改过的那几个包的测试，并发限 2、低优先级）；**不要**自己跑 `tsc -b --force` 或整包 / 全仓 vitest——那一层由审核方在合并关口串行跑一次。② 动了契约 / 路由 / 本体就重出：`node scripts/gen-sdk.mjs`、`node scripts/gen-cloud-openapi.mjs`、`node scripts/gen-ontology.mjs --check`（不过就重出）。③ 动了模拟包才跑 `node apps/cli/bin/agentsws.mjs simulate --tier fast --seed 42 --runtime stub --pack packs/dtc-3c-3p`（及 `packs/dtc-15p`），场景数变了按惯例 `--rewrite-baseline` 三个运行时。红了先按文件名单跑确认（`npx vitest run <文件> --maxWorkers=2`）；`onTaskUpdate` RPC 超时是噪声。派工单里「验证」一节列的包清单是给审核方全量用的，你不用照着全跑。
- 截图：`node apps/cli/bin/agentsws.mjs demo --port 4399` + `node node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/cli.js screenshot …`，存 `docs/assets/…`。
- 结束前 `git merge main` 解冲突（docs/35 两边都留），在 `docs/35` 末尾记「WPxxx 完成，待审」，然后把报告写到 worktree 根的 `REPORT.md`（不提交）：1 实现清单；2 你自主做的决定（白话）；3 需要 Luoye 定的事；4 测试结果；5 偏离；6 未完成；7 分支与提交；8 截图路径。不要提问，拿不准按判断做并写进「偏离」。
