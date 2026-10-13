# WP301 建站岗位改用 Shopify 官方 Horizon 做底，工坊不再带我们的商业主题（决策 399 = A）

worktree `../agentsws-wt/wp301-horizon` · 分支 `wp/301-horizon`（从 main 新起）。先读 `_common.md`、`docs/59-建站岗位-v1.md`、`docs/briefs/reports/WP253.md` / `WP260.md` / `WP296.md` / `WP297.md`（现在的起底主题、主题工具、升级卡、随包兜底）、`apps/server/src/site-theme.ts`、`packages/stand-ins/src/runtime/theme.ts`、`apps/desktop/scripts/fetch-theme-base.mjs`、`electron-builder.yml`、两个 workflow 的「取起底包」步骤、`upstreams.yml` 的 `agentsws-theme` 一节，以及 Rollout 参照线的过程记录 `~/Documents/rollout-shopify/.claude/worktrees/*/notes/建站过程记录.md`（只读，看 Claude 直接建站时用了哪些主题能力、卡在哪）。

## Luoye 10-13 定（399 = A）
我们自己的 Shopify 主题（agentsws-theme）**改成闭源**，只用于付费商业项目；仓库已 / 将改为私有。Agents 工坊（开源、免费下载）**不再使用、不再分发这套主题**，建站岗位改用 **Shopify 官方的 Horizon 主题**做底。

## 方向（先核实再做）
- 现在新开的 Shopify 店默认就是 Horizon（Rollout 店线上主题就是 Horizon）。优先路线：**不在安装包里带任何主题代码**——起底时用 Admin API 在店里**复制一份店铺现有的 Horizon**（或从 Shopify 官方主题商店安装 Horizon）作为未发布主题，工作目录用 Shopify CLI `theme pull` 拉下来；读取主题自带的 section / block schema 生成我们给模型用的目录（替代 `CATALOG.index.json`）；改动只写 templates / section groups / config/settings_data.json / locales 这类商店层文件，不改主题核心代码；推送成未发布主题给人预览。
- 请先核实 Horizon 的许可与获取方式（Shopify/horizon 仓库的许可证；能否经 API / CLI 安装或复制；Horizon 的 block 体系与 `@theme` 用法），写进报告，路线不成立就提替代方案再动手。

## 要做（第一期）
1. **停止分发我们的主题**：删掉 `theme-base-pin.json` 的使用、`fetch-theme-base.mjs` 与 electron-builder / 两个 workflow 里取包 / 打包步骤、服务端兜底包逻辑、`upstreams.yml` 的 `agentsws-theme` 条目（改记 Horizon 作为上游）；开源仓文档里把 agentsws-theme 说成「建站用的开源主题」的地方改掉。**这一条必须先做完、保证下次发版不再去 GitHub 取已私有的主题仓**。
2. **Horizon 起底**：按上面方向实现起底工具（替代 `theme_init_from_base`），目录生成器，主题工作规矩（`THEME_WORK_RULES`）改成 Horizon 的写法；预览推送照旧。
3. **已有 v0.9.x / v0.10 工作目录**（Windows 上 Rollout 有一份）：不删、不自动迁；运行时照实说「这份是旧的自带主题，工坊已改用 Horizon」，建站岗位后续任务在 Horizon 上做（新起一份）；WP296 的升级卡不再出。
4. 测试 + 模拟（建站相关场景、装包前冒烟建站那一行）；截图（新品牌起底、Horizon 目录、改首页推预览）。

## 纪律
不读 .env*；不碰 key / token；不跑批量清理；不碰本机 4317；不连远程机器；不碰任何真实店铺（用替身 / 录制的 Horizon schema 测）；不合 main、不打 tag、不发版（决策 381）。合并前若 main 有新提交，先合 main、`npx tsc -b`。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + gen 检查 + `open-repo-boundary` + 装包前冒烟；报告 `docs/briefs/reports/WP301.md`（Horizon 核实结论、第二期要做的、要 Luoye 定的事每条附建议，决策号从 400 起）。
