# WP184 官方标准环境做成「桌面端体验」：官方场景在我们自己的窗口里打开（借官方桌面端的壳），另认用户自己装的官方桌面端

worktree `../agentsws-wt/wp184-official-desktop` · 分支 `wp/184-official-desktop`（从 main 新起）。先读 `_common.md`、`docs/79-dsh场景切换-v1.md`、`apps/server/src/dsh-scenes.ts`、`packages/dsh-adapter/src/scenes.ts`、`apps/desktop/src/*`（我们的 Electron 壳：窗口、托盘、`server-process.ts`、`paths.ts`）、上游官方桌面端源码（MIT）：`gh api repos/deepseek-ai/deepseek-harness/contents/apps/desktop` 与 `apps/desktop-host`（README.zh.md、`src/`、`renderer/`）——**只读，不 clone 整仓**，需要的文件逐个取到 scratchpad。

## 背景（Luoye 09-29）
「官方有桌面端了，那个桌面端我们能集成进来作为官方标准 profile 吗？」Fable 查实：官方桌面端 = 完整 dsh Web 应用外面包一层 Electron 壳（MIT，`apps/desktop` + `apps/desktop-host`），不在 npm 上发布；GitHub Release 也没有安装包附件；它用 `$DSH_HOME/profiles/desktop`（`desktop` 名字归它独占）、自带强制更新与产品埋点。我们的「场景切换」（WP136）已经能用捆绑的 dsh 起官方 `web` 场景——那就是官方桌面端里面同一个 Web 应用，只是现在交给系统浏览器打开。

## Fable 定（照「官方功能优先」）
不把官方桌面端整个打进我们的安装包（两份 Electron、体积翻倍、它的强制更新与我们锁版本的升级流程打架、埋点默认开）。做两件：
1. **官方场景在我们自己的窗口里打开，体验接近官方桌面端**：托盘「切换场景」、工作台左下角「场景」点官方场景时，不再交给系统浏览器，而是在我们 Electron 里开一个独立窗口（窗口标题「DeepSeek Harness（官方）」一类，和工坊主窗口分开，可来回切）。能借官方桌面端壳的就借（MIT，文件头注出处）：应用请求 / WebSocket 转发与凭据只附给归属窗口的做法、原生目录选择（替代浏览模式）、麦克风授权（只允许这个窗口）、DevTools 快捷键规矩、关窗隐藏 + 退出前查询运行中任务再确认。**不借**：官方的自动 / 强制更新（版本跟我们捆绑的 dsh 走 docs/42）、产品埋点（官方场景里的 dsh 上报按官方默认——那是官方环境，我们不改它的开关；但我们壳这一层不加任何埋点）。系统浏览器打开仍保留为一个选项。
2. **认用户自己装的官方桌面端**：检测本机有没有装官方 DeepSeek Harness 桌面端（macOS `/Applications` 与 `dsh://` 协议、Windows 注册表 / 常见安装路径），有就在场景列表多一行「官方桌面端（你自己装的）」→ 点了直接启动它（`dsh://open` 或打开应用）。说明一句：它用它自己的数据和登录（`~/.dsh`），和工坊里的官方场景是两份。
3. docs/79 更新：场景表加这两种打开方式；教程 `docs/help` 里「切换场景」那篇跟上（中英）。

## 纪律
不下载 / 不安装官方桌面端；不改用户 `~/.dsh`；不跑批量清理命令；不读 .env*；**Luoye 的本机服务在 4317 别碰也别重启**；测试 `--maxWorkers=2`；桌面打包要下载捆绑 Node 就停在那一步并写明；截图用自己起的 demo 端口。

## 验证（审核方全量用）
`scripts/verify-changed.sh` + `vitest run packages/dsh-adapter apps/server apps/desktop apps/workstation` + fast 模拟三个包（stub 即可，确认零漂移）+ `node scripts/check-upstreams.mjs --check`（`upstreams.yml` 登记借用的官方桌面端文件：`kind: ported`、上游路径与提交）。
