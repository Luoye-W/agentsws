# WP174 组织里的「上级」：每个岗位可设上级，审批路由 `scope_manager` 真的落到上级，没有才落老板

worktree `../agentsws-wt/wp174-supervisor` · 分支 `wp/174-supervisor`（从 main 新起）。先读 `_common.md`、`docs/84-B2B岗位设计-v1.md` §11.1 第 3 条（Luoye 09-28：报价超授权**转上级批**，没有上级再转老板）、`docs/briefs/reports/WP172.md`（「需要定」第 1 条：服务进程里没有上级概念，`scope_manager` 实际落到老板）、`apps/server/src/offboard.ts:371` 一带的注释、`packages/contracts/src/{approval,roles,identity}.ts`、审批路由的实现（`scope_manager` 在 `apps/server/src/{pr-service,site,social-service,seo-service,b2b-service}.ts` 与 `packages/api/src/routes/approvals.ts` 的用法）、设置页的组织 / 岗位部分。

## 要做
1. **上级怎么表达**：每个**岗位**可以设一个上级（指向工作区里的一个人；以后要按部门再扩，先按岗位）。契约只加不改（岗位加可选 `supervisor_person_id` 或等价字段）；设置页岗位卡上一个「上级」下拉（照少字规矩，说明进问号）；改上级写事件。
2. **路由**：所有 `scope_manager` 的审批——报价超授权、公关、建站、社媒、SEO 等现有用到的地方——统一走一个解析函数：发起这张卡的职责所在岗位的上级 → 没设或是本人 → 老板（`owner`）。解析结果写进卡的 `recipients.via`（`scope_manager` / `owner`），卡上一句「转给了谁、为什么」。升级链（超时升级）照旧，最后仍到老板。
3. **离职 / 停用**：上级离职或被停用时，这个岗位的上级自动清空（落回老板）并提醒老板重设；已发出未批的卡改派给老板并写原因。
4. 模拟：`b2b-3c-3p` 里「报价超授权转上级」场景在真服务进程下也按上级走（WP172 报告说现在只有模拟世界里对）；dtc 两个包零漂移。

## 纪律
契约只加不改；不连真服务；不跑批量清理命令；不读 .env*；**Luoye 的本机服务在 4317 别碰也别重启**。WP173 并行，改共享文件只动你那几处。

## 验证（审核方全量用）
`scripts/verify-changed.sh` + fast 模拟三个包三个运行时 + `gen-sdk` / `gen-ontology --check`；截图：岗位卡上的「上级」、一张转给上级的报价卡。
