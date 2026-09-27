# WP164 云端对外契约补全：一份完整的 OpenAPI，开源仓 CI 核对（docs/83 §8 第 1 步）

worktree `../agentsws-wt/wp164-cloud-contract` · 分支 `wp/164-cloud-contract`（从 main 新起）。先读 `_common.md`、**`docs/83-云端拆分与能力网关-v1.md`**（整篇，尤其 §1、§2、§8）、`scripts/gen-cloud-openapi.mjs`、`apps/cloud/openapi.json`、`packages/contracts/src/{cloud,cloud-entry,kol-cloud,kol-public,search-data,subscription,standby,byo-data-source}.ts`、`apps/cloud-worker/src/worker.ts`（路由总表）、`packages/cloud-entry/src/{routes,ai,wallet-routes,stripe}.ts`、`packages/cloud-entry/src/search/routes.ts`、`packages/chat-relay`、`packages/hosted`、`.github/workflows/`。

## 背景（Luoye 09-27 定，docs/83）
云端整体搬进私有仓 `Luoye-W/agentsws-cloud`；开源的 agentsws 只留对接契约、客户端、自带 key 适配器、聊天转发核心、替身。搬走之后，开源仓和私有仓之间**唯一的约定就是这份契约**。现在的 `gen-cloud-openapi` 只从 `apps/cloud/dist` 生成 46 条账户与后台路径，`/v1/ai`、`/v1/data/search`、`/v1/wallet`、红人、转发、托管、订阅都不在里面，只存在于 TS 类型；也不在 CI 里。

## 要做
1. **对外契约一份**：新文件（建议 `packages/contracts/cloud-openapi.json`，名字你定、写进报告）覆盖客户端与其他产品会调的**全部**云端路径：账号 / 登录 / 链接令牌、钱包与充值、`/v1/ai/*`（OpenAI 兼容口，写清我们加的头与错误形状，如 402 余额不足、422 数据驻留）、`/v1/data/search/*`、公共红人库、红人云同步、订阅、托管实例、在线值守、聊天转发（HTTP 部分 + WebSocket 握手与消息形状用 `x-` 扩展或文字说明）。**运营后台路径不进对外契约**（私有），另出一份内部的或留在原文件。
   - `/v1/pricing`（公开价目）由并行的 **WP165** 新加；你收尾合并 main 时它已合并就一并收进来，没合并就在报告里写明留给 Fable。
2. **契约从哪来**：以 `packages/contracts` 的 TS 类型为准，用脚本生成（沿用或扩展 `gen-cloud-openapi.mjs` 的做法，或从类型生成 JSON Schema 再拼路径——你选、说理由）。不许手写一份和类型两张皮的 JSON。
3. **一致性测试（契约 ↔ 真云服务）**：趁云端代码还在本仓，起真的 cloud-worker / cloud-entry（替身上游、不联网），逐条路径打一遍，响应要过契约里的 schema。这组测试放在**云端那一侧**的目录（将来随代码搬进私有仓，在私有仓继续跑）。
4. **CI**：开源仓 CI 加一步 `--check`：契约文件与 TS 类型生成结果零漂移。
5. docs/83 §2 第 1 条补一句契约文件的位置与生成命令；docs/64 / docs/49 里提到接口位置的地方指到它。

## 纪律
只加不改已有契约字段；发现类型与实际响应对不上的，**以实际行为为准改类型并在报告逐条列出**（不许悄悄改行为去迁就类型）。不部署、不连真服务；不跑批量清理命令；不读 .env*；Luoye 的本机服务在 4317 别碰。WP165 与你并行（它动 `apps/server` 的依赖、新开源包、模拟与测试替身、`/v1/pricing`），你们都可能动 `packages/contracts`——只加新文件 / 新导出，别改对方的。WP159 / WP162 / WP163 也在并行。

## 验证（审核方全量用）
新的 `--check`、一致性测试、`vitest run packages/contracts apps/cloud apps/cloud-worker packages/cloud-entry`、`gen-sdk` / `gen-cloud-openapi` / `gen-ontology --check`、wrangler `--dry-run --containers-rollout=none`。
