# WP138 向导建出来的职责有范围；空范围不再挡住红人工作台与聊天入口

worktree `../agentsws-wt/wp138-scope` · 分支 `wp/138-scope`（从 main 新起）。先读 `_common.md`、`_beta-fix-common.md`、`docs/78` §1 #1。

## 问题
新用户走向导勾「红人营销」/「客服」，第 ④ 步不连 Shopify → 新职责范围为空 → 岗位页「面板」只剩「这个岗位还没分配店铺 / 品牌 / 产品线」，
候选池 / 活动 / 合作线程 / 演练、「聊天窗」「试聊」入口全被吞掉；接口按 `range=assigned` 判，空范围读 `customer.*` / `creator.*` 被 403。
根因：`apps/server/src/onboarding.ts` `apply()`（约 702 行）没连店就挂空；`apps/workstation/src/pages/position.tsx` `ViewTab`（约 139 行）空范围直接 return。

## Luoye / Fable 已定
- **没连店时，向导新建的职责挂到「品牌」范围**（当前工作区 = 品牌；红人与在线客服本来不按店划）。连了店的照旧挂店（也可同时挂品牌，按现有范围模型哪个自然用哪个，写进报告）。

## 要做
1. `onboarding.ts apply()`：没连店 → 品牌范围。已经走过向导、范围为空的老数据：服务启动时**一次性补挂**（幂等迁移，只补「向导建的、范围为空的」那些；手动清空过范围的不动——如果分不出来，就只在店主本人名下补，并写进报告）。
2. `ViewTab`：`NoRangeNotice` 只挡依赖店铺数据的那几块（销售 / 订单 / 库存类），**不挡** `KolPanel`、`ChatWindowEntry`、`ChatSandboxEntry`。
3. `NoRangeNotice` 在店主本人看时给一键「给我自己挂上这个品牌」（调现有分配接口，不新造）。
4. 接口侧：确认品牌范围下 `creator.*` / `customer.*` 的读写按 `range=assigned` 能过（加测试：品牌范围的红人职责能读候选池、客服职责能建试聊会话）。
5. 模拟包若有「向导」相关场景，跑 fast 档确认不劣化。

## 验收
- 走查第 12、41 步「通」（`--only A` 或对应段；证据图复制到 `docs/assets/wp138/`）。
- 新测试：向导不连店 → 职责有品牌范围；空范围时 KolPanel / 聊天入口仍渲染；补挂迁移幂等。

## 验证（审核方全量用）
`vitest run apps/server apps/workstation packages/api` + fast 模拟 dtc-3c-3p / dtc-15p（stub）。
