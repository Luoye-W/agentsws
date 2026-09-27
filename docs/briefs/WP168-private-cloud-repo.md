# WP168 建私有仓 `Luoye-W/agentsws-cloud`：带历史搬云端代码，三层各自部署（docs/83 §8 第 3 步）

**这一单不在 agentsws 的 worktree 里做主体**：私有仓本地放在 `~/Documents/agentsws-cloud`（新建，你自己建的目录）。开源仓只读，**本单不删开源仓里的任何云端代码**（删除是第 4 步，另一单）。
私有仓已由 Fable 建好（空仓、PRIVATE）：https://github.com/Luoye-W/agentsws-cloud 。先读 `_common.md`、**`docs/83-云端拆分与能力网关-v1.md`**（整篇）、`docs/briefs/reports/{WP164,WP165}.md`、`docs/64`、`apps/cloud-worker/wrangler.toml`。

## 要做
1. **带历史搬**：从开源仓 main 的一个**临时克隆**（放 scratchpad 或 `/tmp` 下你自己建的目录，别在主仓上跑 filter）用 `git filter-repo`（本机已装）只保留这些路径的历史：`apps/cloud`、`apps/cloud-worker`、`apps/cloud-admin`、`packages/{cloud-entry,metering,hosted,kol-cloud,kol-public,standby}`、`deploy/` 里云的部分（`Dockerfile.cloud`、`Dockerfile.hosted`、`docker-compose.yml` 云形态相关、`Caddyfile`、`backup.sh`、`smoke.sh`；`deploy/chat-relay` 留开源、不搬）、`scripts/{demo-cloud-admin,import-kol-public}.mjs`、相关文档（docs/49 / 61 / 64 / 83 与云端 WP 报告可只搬需要的，列清楚）。提交作者、日期原样保留。
2. **依赖开源仓**：私有仓要用开源仓的 `@agentsws/contracts`、`@agentsws/search-providers`、`@agentsws/stand-ins`（一致性测试要）以及它们的依赖链。**不许发布 npm 包**（那是对外发布，要 Luoye 点头）。做法：开源仓作为 git submodule（钉到具体提交）放在 `vendor/agentsws`，pnpm workspace 引入需要的那几个包；写清升级 submodule 的步骤。
3. **三层各自部署**（docs/83 §1）：把现在一个 `apps/cloud-worker` 拆成三个 Worker——① 账户与钱包（AccountsDO / WalletDO / LedgerDO、充值、运营后台）② 能力网关（`/v1/ai/*`、`/v1/data/*`、`/v1/pricing`、公共红人库）③ agentsws 产品云（红人云、托管实例、订阅、聊天转发官方实例）。②③ 通过 **Service Bindings** 调 ① 的内部接口预扣 / 结算 / 退款，自己不记余额。对外路径与 `cloud-openapi.json` **一字不变**（入口可以是一个路由 Worker 或 Cloudflare 路由规则，你选、说理由）。DO 类名与迁移标签要保证**现有线上数据不丢**：查清 `wrangler.toml` 的 `migrations`，拆分后同名 DO 必须留在原 Worker 或用 Cloudflare 的迁移方式转移——**拿不准就停下写进报告，不许猜**。
4. **CI**：私有仓 GitHub Actions 跑 install / tsc / biome / vitest（含 WP164 一致性测试、WP165 真服务 vs 替身比对）/ wrangler dry-run；开源仓契约 `--check` 在私有仓也跑一遍（对着 submodule 里的契约）。
5. **README（中文）**：三层是什么、本地怎么跑、怎么部署（部署命令写出来但**本单不部署**）、secret 清单（只列名字，值由 Luoye 自己 `wrangler secret put`）。
6. 推到私有仓 `main`（这是 Luoye 同意建的私有仓，可以 push；**只推这个仓**）。推之前确认仓库仍是 PRIVATE。

## 纪律
不读任何 `.env*`；不用环境变量里的 token（wrangler 一律 `env -u CLOUDFLARE_API_TOKEN` 且只 `--dry-run --containers-rollout=none`）；**不部署、不改线上**；不发布 npm；不改开源仓（开源仓的变更是第 4 步）；不跑批量清理命令，只删你自己建的临时目录（写清路径）。MkSaaS / Plasmo 模板代码不在这些路径里，但搬之前扫一遍，发现有就停下报告。

## 交付
报告写在私有仓 `docs/reports/WP168.md`（私有仓里），并把一份**不含任何敏感信息**的简版写到开源仓主仓 `docs/briefs/reports/WP168.md`（不提交，Fable 审后提交）。在主仓 `docs/briefs/HANDOFF.md` 把 WP168 那一行改成「待审」（不提交）。
