# WP181 官方插件真用起来（先「自动化任务」）；桌面包带上插件清单与锁定；秘书运行也带时间

worktree `../agentsws-wt/wp181-automation` · 分支 `wp/181-automation`（从 main 新起）。先读 `_common.md`、`docs/42`（红线 7「官方功能优先」）、**`docs/briefs/reports/WP180.md`（「需要定」1–4）**、`docs/briefs/reports/WP179.md`、`profiles/agentsws/{cordis.patch.yml,plugin-allowlist.yml}`、`packages/schedule`（我们自己的定时 / 例行任务）、服务端现有定时（每日 SEO 08:00、开发信 09:00 巡检、每周报告等）、上游「自动化任务」可选插件包（`node_modules/.pnpm/…0.2.0-rc.1…`，README 与 lib）、`apps/desktop/scripts/after-pack.mjs` 与打包配置、秘书（代答）运行的装配处。

## Fable 09-29 定（照 Luoye「官方功能优先」）
1. **官方「自动化任务」插件要在我们的运行里真用起来**：WP180 装上后只在完整 profile 那条路生效，我们的运行不读 bundle。本单把它适配进来：
   - 查清它提供什么（定时 / 提醒 / 周期任务的定义、存储、触发、执行、工具）；
   - **和我们的 `packages/schedule` 怎么并存**：原则是官方有的能力用官方的，我们只包一层（谁能建 / 改 / 删、触发后跑成我们的一次运行、对外动作照样出卡、次数与花钱上限、审计）；已有的每日 SEO / 开发信巡检等要不要迁到官方的机制上，给出判断——能迁就迁（行为逐字不变，改前录金样），迁不了写清原因；
   - 界面：右栏「定时任务」面板（WP140 藏起来的那个）照官方页面借形做出来（「每天 / 每周几点」），照少字规矩；
   - 模型侧：官方的建 / 查 / 删定时任务工具挂给哪些职责（建议：所有职责都能给自己建提醒；建会触发对外动作的周期任务要出卡），执行器再判。
2. **桌面安装包带上 `profiles/`**（`cordis.patch.yml`、`plugin-allowlist.yml`）：打包后插件页能用；装包检查测试钉住这两个文件在包里。
3. **秘书（代答）运行也加时间上下文**（WP180 那条 `time` ContextItem，一行调用）。
4. 团队协作、语音输入两个官方可选包：本单只评估「在我们运行里用起来要做什么」写进报告（工作量 S / M / L），不动手。

## 纪律
契约只加不改；不连真服务；不跑批量清理命令；不读 .env*；**Luoye 的本机服务在 4317 别碰也别重启**；测试 `--maxWorkers=2`，起服务钩子超时的文件串行重跑确认；桌面打包如要下载捆绑 Node，停在那一步并在报告写明。

## 验证（审核方全量用）
`scripts/verify-changed.sh` + `vitest run packages/dsh-adapter packages/schedule packages/runtime-direct packages/simulation apps/server apps/workstation apps/desktop` + fast 模拟三个包三个运行时（迁移的定时任务零漂移）+ `gen-sdk` / `gen-ontology --check` / `gen-cloud-contract --check` + `node scripts/check-upstreams.mjs --check`；截图：右栏定时任务面板。
