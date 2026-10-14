# WP327 Windows 更新空窗缩到秒级：版本目录 + 联接切换（决策 630 / 730）+ 服务进程打包瘦身

worktree `../agentsws-wt/wp327-fastupdate` · 分支 `wp/327-fastupdate`。先读 `_common.md`、`docs/briefs/reports/WP319.md`、`docs/briefs/reports/WP325.md`（第 2 节就是 730 的方案）、`apps/desktop`（electron-builder、NSIS、after-pack、update-splash、自动更新）、`.github/workflows/desktop-windows.yml` 与 `apps/desktop/scripts/win-*.mjs`。

## 目标（Luoye 定）
「旧版关掉 → 新版打开」的空窗尽量短（目标 5–10 秒），不要求整个更新 10 秒内；安装包与安装目录尽量小。

## 要做
1. 照 WP325 报告第 2 节：首次安装用 NSIS 装进 `app-<版本>`，快捷方式 / 开机启动 / 卸载登记指向目录联接 `current`；旧版开着时后台下载整包、校验、低优先级解压到 `app-<新版>` 并冒烟；点「重启并更新」只做 旧版退出 → 切 `current` → 起新版；新版 60 秒内不正常就切回；保留上一版目录。现在的平铺目录用一版会迁移的安装器转过去（分两版发）。单实例锁、任务栏固定、卸载在切换后照常要核实。
2. 服务进程打包瘦身（Luoye 10-14 问「安装包为什么这么大」）：把服务进程与随包依赖用 esbuild 等打成少数几个 bundle，去掉运行时用不到的（含随包 npm 若可去），安装目录从约 1.8 万个文件降到几百个；dsh / cordis 登记 `./src/*` 导出那类要核实能否打包，不行就单独保留。写清前后安装包大小、安装目录文件数与大小。
3. Windows CI：更新端到端量出「点重启 → 新版起来」秒数、回滚演练；在**你的分支**上跑 `desktop-windows.yml`（本单允许 push 这个分支，不碰 main、不打 tag）。
4. macOS 不在本单范围（只出 arm64，见 WP326），但别把 Mac 打包弄坏：本机跑一次 `pnpm -F @agentsws/desktop` 的 mac 打包或现有测试。

## 纪律
不读 .env*；不碰 key / token；Windows 测试机只读（见 memory），不改系统设置、不装卸软件；不碰本机 4317；不跑批量清理；不用 pkill 按名字杀进程。不合 main、不打 tag、不发版（决策 381）。测试用 `--maxWorkers=2 --testTimeout=120000`。

## 验证
`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包 × stub/direct/dsh + gen 检查 + 装包前冒烟 + 分支 Windows CI 结果；报告 `docs/briefs/reports/WP327.md`（决策号 745–754）。
