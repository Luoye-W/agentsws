# WP165 开源仓不再直接依赖云端代码：自带 key 适配器拆成开源包、价目从云上取、测试与模拟换契约替身（docs/83 §8 第 2 步）

worktree `../agentsws-wt/wp165-decouple` · 分支 `wp/165-decouple`（从 main 新起）。先读 `_common.md`、**`docs/83-云端拆分与能力网关-v1.md`**（整篇）、`docs/75`（自带数据接口）、`docs/81`。

## 背景（Luoye 09-27 定，docs/83）
云端整体搬进私有仓；搬之前先把开源这一侧对云端包的直接依赖断干净。Fable 09-27 查到的现状（开源侧 import 云端包的地方）：
- `@agentsws/metering`：`apps/server/src` 4 个文件（`models.ts`、`cloud.ts`、`server.ts`、`cloud-stand-in.ts`：`buildPricing / creditsFor / PRICING_FILE / TOPUP_TIERS_FILE`）、`apps/server/test` 4 个、`packages/simulation/src` 1 个。
- `@agentsws/cloud-entry`：`apps/server/src` 2 个（`search-data.ts` 等：`normalizeSerpQuery / judgeAnswer / searchProviderOf / SearchDataError`——**自带 key 档在本机直接用这些适配器**）、test 2 个。
- `@agentsws/hosted`：`apps/server/src/hosted-mode.ts`（容器环境变量契约）+ 1 个测试。
- `@agentsws/kol-public`：`apps/server/test` 4 个、`packages/simulation/src/world.ts`（合成世界里真跑 `KolPublicService` + 真钱包）。
- `@agentsws/kol-cloud`：`apps/server/test` 1 个。
- `@agentsws/chat-relay`：**留开源**（docs/83 §2 第 4 条），不用动。
你开工时自己再扫一遍，以扫到的为准。

## 要做
1. **自带 key 适配器开源包**：新包（建议 `packages/search-providers`）装 SERP / AI 问答的适配器、规范化、判定、错误类型；`cloud-entry` 改为依赖它；`apps/server` 只依赖它。`kol-public/sources/{apify,youtube}` 如果本机自带 key 那一档要用，同样处理（查清再定，写进报告）。
2. **价目从云上取**：云端加公开只读 `GET /v1/pricing`（价目 + 充值档位，和现在本机显示用的是同一份数据，无需登录，可缓存）；契约类型加在 `packages/contracts`。`apps/server` 改成从云上取、本机落一份缓存离线显示（取不到用上一份；从没取到过就显示「价目暂时拿不到」，不编数）；demo / `cloud-stand-in` 用一份固定样例。`apps/server` 不再 import `@agentsws/metering`。
3. **托管实例的容器环境变量契约**搬进 `packages/contracts`（常量 + 类型），`hosted` 与 `apps/server` 都从这里取。
4. **测试与模拟**：
   - `packages/simulation` 里真跑的 `KolPublicService` + 钱包换成**按契约写的内存替身**（放开源侧，例如 `packages/stand-ins`），模拟指标**零漂移**（有漂移逐条说明原因、不许劣化）。
   - `apps/server/test` 里真起云服务的那些测试：本机一侧改用契约替身；原来测的「真云服务行为」那部分挪到云端那一侧的测试目录（将来随代码进私有仓），覆盖不许变少——报告里列一张「原测试 → 现在在哪」的对照表。
5. **守卫**：加一个测试或 lint：开源侧（`apps/{server,workstation,desktop,cli}`、除云端包以外的 `packages/*`）不许 import 这些云端包：`metering`、`cloud-entry`、`hosted`、`kol-cloud`、`kol-public`、`standby`（`chat-relay` 除外）。
6. docs/83 §2 对应几条补上实际落点。

## 纪律
不改已有契约字段（只加）；不部署、不连真服务；不跑批量清理命令；不读 .env*；Luoye 的本机服务在 4317 别碰。**WP164 与你并行**（它做完整 OpenAPI 契约与 CI 核对），你们都可能动 `packages/contracts`——只加新文件 / 新导出，别改对方的；`/v1/pricing` 归你。WP159 / WP162 / WP163 也在并行。

## 验证（审核方全量用）
`scripts/verify-changed.sh` 全绿、新守卫测试、fast 模拟两个包三个运行时（零漂移）、`gen-sdk` / `gen-cloud-openapi` / `gen-ontology --check`、wrangler `--dry-run --containers-rollout=none`、`pnpm -F @agentsws/desktop` 打包能过（apps/server 依赖变了）。
