# WP221 对照 agency-agents 审一遍我们的整个岗位体系（只出结论）

worktree `../agentsws-wt/wp221-agency-review` · 分支 `wp/221-agency-review`（从 main 新起）。先读 `_common.md`、`docs/54`（岗位是任务主入口）、`docs/69`（角色定位六段骨架）、`docs/04`（职责划分）、`packages/roles/positions/*.yml` 与 `packages/roles/roles/**`（10 个岗位、约 60 条职责、persona）、`packages/skills/bundled/*`、`docs/86` / `docs/89`（已用过 agency-agents 的社媒 / Reddit 部分）。

## 背景（Luoye 10-05）
「agency-agents（msitarzewski/agency-agents，⭐157k，MIT）非常值得我们整个工具参考。」

## 要做（只调研出结论，不改职责与技能代码）
1. **读透 agency-agents**（克隆到会话临时目录）：它的部门 / 角色划分、每个角色文件的结构（身份、职责、工作流、交付物、成功指标、协作关系）、多角色协作 / 交接的写法、和电商 / 出海营销相关的角色（营销、销售、客服、设计、增长、内容、社区、数据…）、质量判断（哪些是拍脑袋指标、哪些做法我们不该学）。
2. **逐项对照我们**，写进 `docs/91-对照agency-agents审岗位体系-v1.md`：
   - **覆盖**：它有、我们没有，且对「出海营销 / 跨境电商公司」有用的角色或职责（列出并说明建议放进哪个岗位 / 新开岗位）；我们有它没有的（说明我们的长处）；
   - **写法**：我们的 persona 六段与它的角色文件比，缺什么（如交付物模板、协作对象、阶段性工作流、自检清单）；给出改进建议与 1–2 条改写示例（不批量改）；
   - **协作 / 交接**：它的多角色接力 vs 我们的岗位路由 + 卡片流，有没有值得借的机制；
   - **可引进的原文**：MIT 允许，哪些段落值得作为技能或 persona 素材引进（列清单、标注改编方式与署名）。
3. 结论段：优先级排序的改进清单（每条写收益、工作量、风险）+ 要 Luoye 定的事（少而准）。

## 纪律
只调研；许可证照 docs/42；不读 .env*；不跑批量清理命令；本机 4317 服务别碰。

## 验证
`open-repo-boundary`（vitest）；报告 `docs/briefs/reports/WP221.md`。
