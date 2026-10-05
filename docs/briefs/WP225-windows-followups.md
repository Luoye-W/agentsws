# WP225 Windows 跟进（真机发现 + WP218 决定 ③④ + 内容更新只自动小版本）

worktree `../agentsws-wt/wp225-win` · 分支 `wp/225-win`（从 main 新起）。先读 `_common.md`、WP218 / WP219 报告、`docs/90`、`apps/desktop/src/{main,server-process,updater*}.ts`、`apps/desktop/scripts/{dist,win-install-smoke}.mjs`、`.github/workflows/desktop-windows.yml`、DECISIONS.md（WP218 五问、#23）。

## 背景（10-05）
Luoye 定 WP218 五问全按建议；Fable 已在 Luoye 的 Windows 真机（Win 11）上装了 CI 包 `0.0.0-ci.2` 并跑起来，发现下面几处。

## 要做
1. **应用内更新在打包后直接坏了**：真机日志 `WARN [desktop/update] 主源查更新失败 error=TypeError: Cannot set properties of undefined (setting 'autoDownload')`——`autoUpdater` 在打包产物里是 undefined（多半是 electron-updater 的 ESM / CJS 互操作或打包没带上）。修好并加一条**对打包产物**的检查（不是只测源码）。
2. **CI 冒烟 exit 127**：`win-install-smoke.mjs` 在「监听都在 127.0.0.1」之后、退出那步以 127 结束且没有报错信息；同时「安装目录里在跑的进程：0 个」明显不对（应用正开着）——进程匹配（路径大小写 / 8.3 短名 / Win32_Process 取不到 ExecutablePath）有问题，导致后面「退出干净」那条检查形同虚设。查清修好，让 `desktop-windows.yml` 全绿。
3. **决定 ③**：「重启并更新」前的「有任务在跑」加上**岗位 AI 正在干活**的统一信号（服务端出一个只读状态，桌面壳问它）。
4. **决定 ④**：Windows 上 AI「跑命令」工具从 `bash -c` 换成 PowerShell（优先 pwsh，没有就 Windows PowerShell 5.1），不要求用户装 Git Bash；mac / Linux 不变。
5. WP218 报告里的两处小问题：shopify 命令行在 Windows 上起不来（`.cmd` 要经 shell 或 `cmd /c`）、中文路径读注册表乱码。
6. **打包少带了锁表**：`computer-use.lock.json`（以及以后的同类锁表）没进安装包，按需下载按钮在打包后用不了；打包自检加上「锁表齐」。
7. **内容更新只自动小版本**（Luoye #23）：选了「自动」时，只自动装同一主版本内的更新（按内容条目的 semver），大版本仍出卡；写测试。
8. CI 里加「两个版本之间点更新」的端到端（WP218 遗留）：先装 N，再用本地起的更新源喂 N+1，验证下载 → 重启并更新 → 新版本起来、数据还在。做不完写清卡在哪。
9. 文档更正：Windows 数据目录实际是 `%APPDATA%\@agentsws\desktop`（不是 `%APPDATA%\agentsws`），WP218 报告与相关文档改正；要不要改成更好认的目录名写进报告（改的话要做老目录迁移），别擅自改。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不推 tag、不发版、不上传 R2；推分支跑 `desktop-windows.yml` 需要时告诉 Fable，由 Fable 推。真机验证由 Fable 远程做，你不要连 Luoye 的 Windows。

## 验证
`scripts/verify-changed.sh` + fast 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；本机 mac 打包一次确认 1、6 在产物里生效；报告 `docs/briefs/reports/WP225.md`（要 Luoye 定的事单列）。
