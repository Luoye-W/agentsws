# WP218 Windows 安装包真打真跑 + 应用内一键更新（像 Claude / Codex）

worktree `../agentsws-wt/wp218-desktop` · 分支 `wp/218-desktop`（从 main 新起）。先读 `_common.md`、`apps/desktop/README.md`、`apps/desktop/electron-builder.yml`（WP111：捆绑 Node 22 与按它 ABI 编的原生模块、NSIS、不签名）、`apps/desktop/scripts/{fetch-node,after-extract,after-pack}.mjs`、`node-runtime.lock.json`、`.github/workflows/{ci,release,nightly}.yml`、`docs/62`（安装与首次打开说明）、WP184（官方场景窗口）、WP195（品牌标记）、docs/36（少字、状态图标）、docs/35 里 WP181「桌面包因无 vendor 未真打」那条。

## 背景（Luoye 10-05）
要在另一台 **Windows 电脑**上跑两个真实品牌（INMO Reddit 代运营、变形金刚 IP TWS 耳机 / 音响独立站），模拟真实用户。要一个 Windows 应用；并且要像 Claude / Codex 那样**应用内更新**：有新版时左下角出现「更新」按钮，点一下就更新，不用重新下载覆盖。

## 要做
1. **Windows 安装包真打真跑**：
   - 用 GitHub Actions `windows-latest` 打 NSIS x64（mac 上交叉打原生模块不可靠）：`fetch-node` 取 win32-x64 的 Node、原生模块（better-sqlite3 等）按捆绑 Node ABI 取 / 编、afterPack 冒烟 import；
   - **CI 里装起来真跑一遍**：静默安装 → 启动 → 等服务 health 200 → 打开工作台首页（Playwright）→ 退出；失败把日志作为 artifact；
   - 查清 Windows 特有问题并修：路径 / 盘符 / 中文用户名路径、数据目录（`%APPDATA%`）、托盘、单实例、防火墙弹窗（只听 127.0.0.1）、dsh 与官方场景在 Windows 上能否起、连接器（不需要 Docker——核实桌面版的连接器跑法在 Windows 上成立）、长路径；
   - 产物先作为 workflow artifact（不发布）。
2. **应用内一键更新**（`electron-updater`，照官方功能优先 / docs/42 评估依赖）：
   - 启动后与每隔几小时后台查新版；有新版 → 左下角（账号区上方）出现「有新版本」按钮（照少字 + 状态图标）；点了在后台下载（差分 blockmap），完成后变「重启并更新」；点了退出、安装、自动重开；用户数据 / 设置 / 本机加密库保留；
   - 下载、安装失败给人话并可重试；正在跑任务时提示「有任务在跑，确定现在重启？」（照 WP184 退出确认的做法）；
   - **更新源可配**：同时支持 GitHub Releases provider 与 generic（自有下载站 URL）两种，构建时由变量选择；**这一单不发布任何 Release、不建任何下载站、不推 tag**——发布位置等 Luoye 定；
   - 版本号与渠道（stable / beta）规则写进 README；mac 端：自动更新需签名，未签名时 mac 只提示「有新版，去下载」，不自动装（写清）。
3. **release.yml**：整理成「推 tag 才发版」并按所选 provider 上传更新元数据（`latest.yml` 等）；本单只在 dry-run / 不推送的前提下验证工作流语法与产物结构。
4. 文档：docs/62 补 Windows 首次安装（SmartScreen「更多信息 → 仍要运行」）、更新怎么用；教程一篇中英「安装与更新」。

## 纪律
不发布、不打 tag、不推远端（工作流用 `workflow_dispatch` 也不要触发——需要在 CI 上真跑时交 Fable 决定何时推分支）；不读 .env*；不用上下文里的密钥；不签名（证书以后再说）；不跑批量清理命令；本机 4317 服务别碰。

## 验证
`scripts/verify-changed.sh` + fast 模拟三包 stub（零漂移）+ `open-repo-boundary` + 桌面包本机（mac）能打出、更新逻辑单测（替身更新源：有新版 / 无新版 / 下载失败 / 安装前确认）；Windows 真跑那一段写成 CI 作业，交回时说明需要推分支才能在 CI 上跑；报告 `docs/briefs/reports/WP218.md`。
