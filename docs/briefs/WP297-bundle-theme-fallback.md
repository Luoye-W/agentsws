# WP297 安装包随带起底主题兜底包（决策 140 / 376）

worktree `../agentsws-wt/wp297-themepack` · 分支 `wp/297-themepack`（从 main 新起）。先读 `_common.md`、`docs/briefs/reports/WP296.md`（§要 Luoye 定第 1 条）、`docs/briefs/reports/WP253.md`（决策 140 原意）、`apps/server/src/site-theme.ts`（服务端认的那个兜底包环境变量 / 路径）、`apps/server/src/theme-base-pin.json`、桌面壳 `apps/desktop`（启动服务时设的环境变量、`scripts/after-pack.mjs` 的 extraResources 处理）、`.github/workflows/desktop-windows.yml` 与 `release.yml` 的打包步骤。

## 背景
决策 140：国内网络可能下不动 GitHub 的起底包，钉死的那一份随安装包带作兜底。WP296 审出：服务端认兜底变量，但**打包与桌面壳都没人下这份包、没人设这个变量**，等于没接上。

## 要做
1. 打包时（本机 `scripts/dist.mjs` 与 CI 两个 workflow）按 `theme-base-pin.json` 从 codeload 下好那份 tar.gz，**核 sha256 与字节数**，对不上就让打包失败；放进安装包资源目录（extraResources，Windows / mac 都要）。下载失败要有重试；CI 上可缓存。
2. 桌面壳启动服务进程时，把兜底包路径通过服务端已认的那个环境变量传进去；服务端起底时：先试网络（照旧），失败或超时再用兜底包（同样核 sha256）；用了兜底包在事项时间线里如实记一句。
3. 测试：打包脚本（假下载）核 sha 不对就失败；桌面壳传变量；服务端「网络失败 → 用兜底包」「兜底包 sha 不对 → 拒」；装包前冒烟照过。`win-install-smoke`（如有）里加一条：安装后资源目录里有这份包。
4. 报告 `docs/briefs/reports/WP297.md`。

## 纪律
不读 .env*；不碰 key / token；不跑批量清理；不碰本机 4317；不连远程机器；不推 tag、不发版、不合 main（决策 381：合并发版由主线会话负责）。合并前若 main 有新提交，先合 main、`npx tsc -b`。

## 验证
`scripts/verify-changed.sh` + 相关脚本测试 + 模拟三包 × 三运行时 + gen 检查 + 装包前冒烟。
