# WP252 一台电脑多个品牌共用连接器时，连接按品牌隔开（决策 125）+ 上游名单补 npm 运行时

worktree `../agentsws-wt/wp252-conn` · 分支 `wp/252-conn`（从 main 新起，含 WP247）。先读 `_common.md`、WP66 报告（每品牌一套连接）、WP247 报告（§「核对 WP66 时发现的老问题」）、`packages/connect-adapter`（命名连接、`default`）、`apps/server/src/connections.ts`、`upstreams.yml`、`docs/42-上游升级流程-v1.md`（open-connector 那一节现在只盯 Docker 镜像）。

## 背景
WP247 报告：一台电脑一个 OpenConnector、多个品牌共用时，连接名默认都叫 `default`，而且非默认品牌会把自己没记录过的连接也当成自己的——两个品牌连同一家服务（如 INMO 和 Rollout 都连 Shopify）会互相覆盖、互相看见。Luoye 马上要给 Rollout 连正式 Shopify 店，INMO 以后也可能连。

## 要做
1. **连接名带品牌**：新建连接的命名连接 id 带上品牌（workspace）标识，保证同一 provider 在不同品牌下各是各的；运行时 token 的 `allowedConnections` 只放本品牌的。
2. **只认自己的**：非默认品牌只列 / 只用自己记录过的连接；默认（启动）品牌兼容老数据：老的 `default` 连接归默认品牌（WP251 正在把启动品牌挂到公司下面，口径以「启动品牌」为准，不依赖 org 结构）。
3. **迁移**：已有连接不动名字，只在我们这边补记归属（幂等）；同一 provider 两个品牌都已用 `default` 的极端情况，归默认品牌，另一品牌提示「请重新连接」。
4. **upstreams.yml 补 npm 运行时**：open-connector 现在有两种形态——Docker 镜像（自托管 / 开发）与 npm 包 + 锁文件（WP247 桌面按需下载，钉 1.8.0）。在 `upstreams.yml` 登记 npm 那一条（锁文件路径、版本），`scripts/check-upstreams.mjs` 能对账；docs/42 open-connector 一节补「npm 运行时升级步骤」（改钉版本 → `scripts/open-connector-lock.mjs` 重出锁文件 → 测试）。
5. 测试：两个品牌连同一 provider 互不覆盖、互不可见；老 default 连接归启动品牌；迁移幂等；token 只含本品牌连接。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不碰任何 docker 容器；不连远程机器。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary` + `node scripts/check-upstreams.mjs`；报告 `docs/briefs/reports/WP252.md`（要 Luoye 定的事单列）。
