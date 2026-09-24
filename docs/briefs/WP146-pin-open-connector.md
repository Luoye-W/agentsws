# WP146 连接器运行时镜像钉版本（不再用 latest）+ 进上游哨兵

worktree `../agentsws-wt/wp146-oc-pin` · 分支 `wp/146-oc-pin`（从 main 新起）。先读 `_common.md`、docs/42（尤其第 443 行附近说的「镜像要看 digest」）、`upstreams.yml` 的 `open-connector` 条、
`packages/connect-adapter/README.md` 与 `test/record-fixtures.test.ts`、`scripts/dev-real.sh`、`docker-compose.yml`、`.github/workflows/upstream-watch.yml` 与 `scripts/check-upstreams.mjs`。

## 问题（W39 上游评估找到，09-21 那份报告因权限没进仓库，结论见 issue #2 的关闭说明）
`docker-compose.yml` 与 `scripts/dev-real.sh` 用 `ghcr.io/oomol-lab/open-connector:latest`，fixture 测试缺省也是 latest。实测 latest 已 = v1.6.3（digest `sha256:f25207e6…c006`），
仓库里没有任何一处记录我们在哪一版上测过；任何一次 `docker compose pull` 都可能悄悄换版本，而且没有测试会红。SDK `@oomol-lab/connector` 锁 1.2.0（npm 上最新也是 1.2.0，不用动）。

## 要做
1. **选版本**：本机有 Docker，可以拉镜像。用 v1.6.3 起一个本机 runtime，跑 `packages/connect-adapter` 的一致性套件（真适配器那一遍）与录制回放；
   全绿就钉 v1.6.3。不绿就二分往回找到最近一个全绿的正式版（`v1.x.y` 标签，不用 commit 短哈希标签），不绿的差异写进报告。
   **不用任何真 provider 凭据、不连真 OAuth**；只用本机 runtime 能验的那部分。
2. **钉法**：`image: ghcr.io/oomol-lab/open-connector:vX.Y.Z@sha256:<digest>`（tag + digest 一起写，digest 以 `docker buildx imagetools inspect` 或 registry manifest 实测为准，多架构取 index digest）。
   三处一起改：`docker-compose.yml`、`scripts/dev-real.sh`、`record-fixtures.test.ts` 的缺省 `OC_IMAGE`；再 `git grep` 一遍别处有没有 latest。
3. **进哨兵**：`upstreams.yml` 的 `open-connector` 条记锁定的 tag 与 digest；`check-upstreams.mjs --check` 要校验「compose 里写的 = upstreams.yml 里锁的」；
   upstream-watch 的周报里对镜像比「锁的 tag / digest vs 最新正式版标签」（拉不到就写查不到，不许静默）。docs/42 对应一步写清楚镜像怎么升（改哪三处 + 跑哪套测试）。
4. **文档**：`packages/connect-adapter/README.md` 写「在哪一版上验过」；docs/35 记一条。

## 验收
- `node scripts/check-upstreams.mjs --check` 过，且故意改坏 compose 里的 digest 时它报红（测试钉住）。
- 报告里贴一致性套件在所选版本上的结果。

## 验证（审核方全量用）
`vitest run packages/connect-adapter` + `node scripts/upstreams.test.mjs`（若有）+ `node scripts/check-upstreams.mjs --check`。
