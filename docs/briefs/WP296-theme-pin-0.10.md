# WP296 建站起底主题改钉 agentsws-theme v0.10.0（breaking）

worktree `../agentsws-wt/wp296-theme010` · 分支 `wp/296-theme010`（从 main 新起）。先读 `docs/42-上游升级流程-v1.md` 里「按 tag 钉的上游怎么升」、`upstreams.yml` 的 `agentsws-theme` 一节（`we_depend_on` / `covered_by`）、`apps/server/src/site-theme.ts`、`apps/server/src/theme-base-pin.json`、`packages/stand-ins/src/runtime/theme.ts`（THEME_WORK_RULES 等写给模型的主题规矩）、`_common.md`。主题仓本机在 `~/Documents/agentsws-theme`（只读），v0.10.0 = `236ef33`，发版说明 https://github.com/Luoye-W/agentsws-theme/releases/tag/v0.10.0 （release 说明顶部有迁移步骤）。

## 背景（主题会话 10-13 发来）
v0.10.0 是后台设置大改、**breaking**：每个 section 只开放自己的 block（产品类 block 改私有 `_product-*`，页头页尾类也私有）；共用设置 id / 名称统一；补齐大量设置、新增一批 section / block；`CATALOG.index.json` 约 58 KB 仍可一次读完；AGENTS.md 新增 block set 与共用设置规则；**已有 store 仓库升级要跑一次 `npm run migrate`**。

## 要做
1. 按 docs/42 改钉：`theme-base-pin.json`（tag / version / commit / codeload tar.gz 的 sha256 与 bytes——照现有算法从 `codeload.github.com/Luoye-W/agentsws-theme/tar.gz/<commit>` 下载实算）、`upstreams.yml`（pinned_tag / pinned_commit）。安装包里随带的兜底起底包（WP253 决策 140）若有，一并换。
2. 逐条核 `we_depend_on`（八个目录、AGENTS.md §2 改动边界与 `baseWritable`、app.css 是构建产物、LICENSE 在根）在 v0.10.0 是否仍成立；不成立就改我们这边并写进报告。
3. 查我们写给模型的主题规矩 / 工具描述 / stub 剧本里有没有写死 v0.9.x 的 block 名、section 名、设置 id（例如 product-* 公开 block、旧设置名）；改成按 v0.10.0（优先让模型读 `CATALOG.index.json` 与 AGENTS.md，不在我们这边写死名字）。
4. **已有工作目录怎么办**：用户之前用 v0.9.2 起过底的品牌（Windows 上 Rollout 就有一份），建站运行碰到旧版时：不自动升级；运行里如实说一句「这份主题是 v0.9.2，新版 v0.10.0 要迁移」，给一张卡「升级到 v0.10.0（会跑迁移）」，人点了才在本机跑主题仓的 `npm run migrate`（如工具链允许；不允许就写清手动步骤并报告）。迁移前自动留一份备份（git 提交或复制）。
5. 测试：`site-theme.test.ts` 等起底测试用新钉子过；新增「旧版工作目录 → 出升级卡、不自动改」的测试；装包前冒烟 `node scripts/preinstall-smoke.mjs` 必须过（建站岗位那几格）。

## 纪律
不读 .env*；不碰 key / token；不跑批量清理；不碰本机 4317；不连远程机器；不改主题仓 `~/Documents/agentsws-theme`（只读）；不推 tag、不发版。合并前若 main 有新提交，先合 main、`npx tsc -b` 后再重出 gen-sdk / gen-ontology。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + gen 检查 + `open-repo-boundary` + 装包前冒烟；报告 `docs/briefs/reports/WP296.md`（要 Luoye 定的事单列、每条附建议）。
