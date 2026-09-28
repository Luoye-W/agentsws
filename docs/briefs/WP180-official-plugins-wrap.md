# WP180 官方插件与配置写回包一层后打开；每次运行带上当前时间与公司时区

worktree `../agentsws-wt/wp180-plugins` · 分支 `wp/180-plugins`（从 main 新起）。先读 `_common.md`、`docs/42`（红线 7 已改为「官方功能优先」）、**`docs/briefs/reports/WP179.md`（B 类逐行表）**、`packages/dsh-adapter/README.md`「逐行重判」、`profiles/agentsws/cordis.patch.yml`、上游 `dsh-plugin-manager` / `tool-plugin-manager` / 配置写回相关包与 `time-context`（`node_modules/.pnpm/…0.2.0-rc.1…`）。

## 为什么（Luoye 09-29 新规矩 + WP179 B 类结论）
官方功能尽量都接进来；WP179 判为 B 类的两项「包一层就能开」，按规矩排上：

## 要做
1. **官方插件管理（包一层后打开）**：`plugin-manager` / `tool-plugin-manager` 两行撤锁，但：
   - **装、升级、卸载插件一律出卡**等人批（新 ApprovalKind，只加不改），卡上写插件名、版本、来源、许可证、它会注册哪些工具 / 会不会出网；
   - **只许从审过的清单装**：清单一份放仓库（`profiles/agentsws/plugin-allowlist.yml`，先放官方的可选插件包——含 0.2.0 里「自动化任务改由可选插件包提供」那一包——逐个核许可证），清单外的直接拒；
   - 装完**不许写回 profile patch**（锁定表里的行一行都改不动）；
   - 界面：设置里一个「官方插件」页，照少字规矩，列已装 / 可装、装卸按钮（点了出卡）。
2. **配置写回（包一层后打开）**：运行中保存配置可以写回，但**只许写不在锁定表（B / C 类）里的行**；想碰锁定行直接拒并写事件。加测试：一次保存企图把 C 类上报打开 → 被拒。
3. **时间上下文**：每次运行的上下文里写一次「现在时间 + 公司时区」（公司档案里有时区就用，没有用本机时区），三个运行时同一份；能直接用官方 `time-context` 就用官方的（它的默认更新频率照官方，写明），用不上再在 persona 段里加一行并说明原因。提示词字节变化照 WP148 金样口径说明，模拟基线如需重写逐条说明。
4. `packages/dsh-adapter/README.md` 逐行表、`docs/42` 相应条目更新；`profile-lockdown` 测试：这两类改成「已开且包的那一层生效」。

## 纪律
契约只加不改；不连真服务、不装真插件（替身 / 本地假插件）；不跑批量清理命令；不读 .env*；**Luoye 的本机服务在 4317 别碰也别重启**；测试 `--maxWorkers=2`，起服务钩子超时的文件串行重跑确认。

## 验证（审核方全量用）
`scripts/verify-changed.sh` + `vitest run packages/dsh-adapter packages/runtime-direct packages/simulation apps/server apps/workstation` + fast 模拟三个包三个运行时 + `gen-sdk` / `gen-ontology --check` / `gen-cloud-contract --check` + `node scripts/check-upstreams.mjs --check`。
