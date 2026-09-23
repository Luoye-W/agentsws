# WP133 dsh 0.1.7 两条小收尾（WP132 报告 §9 推荐的两件 S 量级）

worktree `../agentsws-wt/wp133-dsh-follow` · 分支 `wp/133-dsh-follow`（从 main 新起）。先读 `docs/briefs/reports/WP132.md` §9 第 2 与第 15 条、`packages/dsh-adapter/UPGRADE.md` 第四节、`docs/42`。

1. **profile 锁定改成可校验**：`profiles/agentsws/cordis.patch.yml` 里那六行 `disabled: true` 现在靠服务 id 字符串匹配——上游哪天改个 id，这一行就静默失效、什么都不禁。把锁定挪进独立的 patch 文件，用 0.1.7 新加的 `--dump-config-schema` 在测试里校验每个 id 都真的存在于当前 dsh 的配置 schema 里；`profile-lockdown.test.ts` 改成「id 不存在即失败」。
2. **`session.eventAt()` → `session.read()`**：前者已弃用三个版本（官方 Agent Note 2026-09-09），是下次升级第一个会断的。换成异步分页的 `read()`，`packages/dsh-adapter` 内部所有调用点 + 测试；指纹 `capture.mjs` 重跑一次证明零漂移。
验证：`scripts/verify-changed.sh`（含它新加的「依赖变更时全量类型检查」）+ `vitest run packages/dsh-adapter` + 3 人包 `--runtime dsh` fast 档。**不动版本号**。
