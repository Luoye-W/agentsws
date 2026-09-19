# WP116 公共红人库上线（Workers 形态）+ 搬 KOLAgents 存量数据

worktree：`../agentsws-wt/wp116-kol-public`，分支 `wp/116-kol-public`。

## 为什么
内测朋友要测红人营销，公共红人库必须在官方云（Cloudflare）上可用。WP114 留尾：Workers 形态没有 `KolPublicDO`，因为现有 `packages/kol-public` 的服务要在**同一个同步上下文**里同时碰「全局红人表」与「某组织的钱包」，而两者在不同的 Durable Object 里。docs/64 §10.2 已写好改法。

## 先读
`docs/48` §5、`docs/49`、`docs/64` §10.2、`docs/65`；`packages/kol-public/src/*`、`apps/cloud/src/kol-public.ts`、`apps/cloud-worker/src/*`（入口路由、`WalletDO`、`LedgerDO`、outbox、`test/helpers.ts` 假 DO 运行时）、`packages/cloud-entry/src/ai.ts`（预扣 → 调上游 → 结算 / 释放 的范式）、`apps/server/src/kol-public-client.ts`。
只读参考（不读 `.env*`）：`/Users/yeluo/Documents/KOLAgents/src/db/public-library.schema.ts` 与 `src/lib` 里公共库相关代码。

## 定论
1. **两段式**：入口 Worker 验令牌后，`/v1/data/kol/*` 走：① 向该 org 的 `WalletDO` **预扣**（能力 `data.kol.lookup` / `data.kol.audit` / `social.fetch` / 邮箱 reveal，按 `pricing.json`）→ ② 调单例 `KolPublicDO` 取数（命中缓存 / 需要打 YouTube API 或 Apify 时由它打，上游密钥只从 Worker secret 读：`AGENTSWS_YOUTUBE_API_KEY`、`APIFY_TOKEN`）→ ③ 按实际结果向 `WalletDO` **结算或释放**，计量事件带 provider / 我方成本（WP115 的列）并抄 `LedgerDO`。浏览免费、reveal 收费、贡献返免费额度这些现有语义不变。`packages/kol-public` 的业务逻辑拆成「纯取数」与「记账」两半，Compose 形态行为不变、测试不许红。
2. `KolPublicDO` 用 `SyncDb` + 独立迁移表名；邮箱字段照旧用 `AGENTSWS_KOL_EMAIL_KEY` 加密落库（没配这个 secret 就不存邮箱、health 标黄）。
3. **存量数据搬家**：KOLAgents 的公共库在它自己的 Postgres 里，现量：`public_creator` 723、`public_creator_metric` 602、`public_contact` 129、`public_content` 42、`public_content_metric` 42、`public_person` 3。做：
   - `scripts/export-kolagents-public.mjs`：只读连接，连接串**只从环境变量 `KOLAGENTS_DATABASE_URL` 读**（Luoye 会用 `node --env-file=<KOLAgents 的 env 文件> …` 跑，脚本不打印连接串），把上述表导成 NDJSON 到 `./.data/kolagents-public/`（该目录进 `.gitignore`；含真实邮箱，**绝不进仓库**）。字段映射到我们 `packages/kol-public` 的模型（platform / external_id / handle / 名称 / 粉丝等指标快照 / 类目 / 国家语言 / 联系方式及其来源与置信度 / 内容样本），对不上的字段放 `extra`。
   - `POST /v1/admin/kol/import`（admin 会话或 admin token；NDJSON 分块、幂等键 = platform + external_id、可重跑、返回 inserted / updated / skipped；写审计）两种形态都挂。
   - `scripts/import-kol-public.mjs <base_url>`：把 NDJSON 分块推上去，admin token 只从环境变量读。
   - 测试用合成 NDJSON（example.com），覆盖重跑幂等、邮箱加密、坏行跳过并计数。
4. 运营后台（`apps/cloud-admin`）加一页「红人库」：总量、按平台、近 7 / 30 天新增、reveal 次数与积分、上游调用次数与成本、搜索、单条「从库中移除」（opt-out，写审计）。
5. health 里 `kol_public` 在 Workers 形态如实变 true；`docs/64` §10.2 改成「已做」，补 runbook：要敲哪几个 secret、怎么跑导出 / 导入两步。

## 验证
通用项 + `vitest run packages/kol-public apps/cloud apps/cloud-worker apps/cloud-admin packages/metering apps/server`；`pnpm -F @agentsws/cloud-worker exec wrangler deploy --dry-run` 过。
