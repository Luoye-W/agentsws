# WP144 电脑操控：挂官方 dsh-computer-use + Cua Driver（MCP 那一种），默认关、按职责开、每次运行先授权，跟官方同步升级

worktree `../agentsws-wt/wp144-computer-use` · 分支 `wp/144-computer-use`（从 main 新起）。先读 `_common.md`、docs/55 §3 与 §10（浏览器两条腿的做法，本单照抄其纪律）、
docs/42（上游升级流程）、官方 README：`packages/computer-use/computer-use`、`packages/experimental/computer-use-cua-driver-mcp`、`…-cua-driver-native`、`docs/subsystems/computer-use.zh.md`
（上游仓库 `deepseek-ai/deepseek-harness` tag `dsh-v0.1.7-rc.1`；npm 同版本）。上游驱动 `trycua/cua` 的 `libs/cua-driver`（MIT）。

## Luoye 09-24 定
电脑操控「先加进来，和官方一起同步更新」。

## Fable 定的形态（理由写进 docs/80，见第 7 条）
- **用 MCP 提供方**（`@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp`，驱动是独立进程）。**不用 native**：它在我们服务进程里跑原生模块，官方原话「原生崩溃可能终止该进程」。
- **驱动 `cua-driver` 由我们钉版本 + sha256 下载**（上游 GitHub Release 自带 `checksums.txt`），装在数据目录、不进 PATH、不用它的 `install.sh` / `install.ps1`——做法照 WP92 的 `browserskill.lock.json` + `browserskill-install.ts`。
  **不打进安装包**；用户在设置里打开时才下。钉的版本以官方 dsh 0.1.7-rc.1 文档引用的那一版为准（README 链接的是 `cua-driver-rs-v0.28.0`），查不到就用最近的正式版（**不用 nightly**）。
- 驱动的**自动更新 / 遥测**：逐项查上游有没有（cua 历史上有 telemetry），有就默认关，关法与证据写进报告；关不掉的列给 Luoye。

## 要做
1. **挂法**：`harness.ts` 里与浏览器同一位置同一顺序（mount → installGate → 浏览器 → 电脑操控），`RunRequest.computer_use` 在场才 `root.plugin(ComputerUse registry)` + `agentCtx.plugin(CuaDriverMcpProvider, { command: <数据目录里的驱动>, args: ['mcp'] })`。
   两档运行时（进程内 / 子进程 `--profile`）都要能挂；profile 锁定测试（`profile-lockdown.test.ts`）照 WP134 路线 (b)：profile 层默认关，选了才叠 opt-in patch，`--dump-config-schema` 校验 id 存在。
2. **只在本机档**（`runtimeMode() === 'local'`，桌面版）；Docker / 托管 / 公司服务器一律不给。
3. **开关三层**：设置页「电脑操控」总开关（默认关，打开时一段白话说明风险）→ 职责模板 / 岗位里勾选「这条职责可以操作电脑」（默认一条都不勾）→ **每次运行第一次要动电脑时出一张授权卡**「让它在接下来 N 分钟操作这台电脑？」（N 默认 10，可改），批了这次运行才挂提供方。
   截图也算在授权里（整屏截图会进模型，是隐私）。公司端职责（executor 档）永远不给。
4. **门禁**（`tools.ts` / `gate.ts`）：`mcp__cua-driver-mcp__*` 全部按 `write_external` 判（截图、列窗口这类只读也要在授权窗口内）；未知工具名按写；授权过期立刻拒。
   输入密码：提示词里写明「遇到登录 / 密码 / 支付 / 验证码就停下出卡请人接手」（照浏览器的 `browser_handoff`），不许 Agent 代输。
5. **看得见、停得住**：运行期间桌面壳托盘图标变色 + 一行「AI 正在操作电脑 · 停止」；点停止 = 撤销授权 + dispose 这棵树（驱动断开）。工作台第三栏同样一条。
6. **权限引导**：macOS 要「辅助功能」+「屏幕录制」给**我们的应用**（桌面壳 / 驱动，按上游说明哪个持有权限就引导哪个）；Windows 按上游说明。设置页三步向导照 WP92：① 下载驱动 ② 授权系统权限（打开系统设置对应页，不替用户点）③ 自检（调驱动的 `check_permissions`，`prompt: false`），结果原样列出 + 怎么修。
7. **文档**：新写 `docs/80-电脑操控-v1.md`（形态、三层开关、门禁、隐私、与浏览器两条腿的关系、平台差异）；docs/55 加一节指过去；docs/36 右栏 / 设置页规范补一行。
8. **跟官方同步**：`upstreams.yml` 加 `dsh-computer-use`、`dsh-experimental-computer-use-cua-driver-mcp` 与 `trycua/cua`（cua-driver）；`computer-use.lock.json`（仿 browserskill.lock.json）进哨兵；
   docs/42 升级流程的「浏览器 / 电脑操控」一步写清楚：dsh 升级时这两个包同版本一起升，cua-driver 按 dsh 文档引用的版本跟。`packages/dsh-adapter/package.json` 里三个包**同 dsh 版本精确钉**。
9. **测试**：seam 测试仿 `browser-seam.test.ts`（真 provider 挂上、工具报上来——驱动用一个假的 MCP 可执行文件或指向不存在的路径时的行为要钉住，参考 WP92 的「路径指错把自己进程打死」那条坑，**装好了才挂**）；门禁：没授权全拒、授权过期拒、公司端不给；安装器：sha256 不符拒装、不出网测试（替身下载）。

## 验收
- 不联网、不真的动这台电脑（CI 与测试里不启动真驱动）。报告里写一段手工验证步骤 `scripts/dev-computer-use.md`（真装驱动、授权、让它截一张图、点一下），实现方**不要真跑操作桌面的那几步**，留给 Luoye / Fable。
- 设置页、授权卡、托盘「正在操作」三张截图到 `docs/assets/wp144/`。

## 验证（审核方全量用）
`vitest run packages/dsh-adapter apps/server apps/desktop apps/workstation packages/api` + fast 模拟 dtc-3c-3p / dtc-15p 三个运行时（没开时零漂移）+ `node scripts/check-upstreams.mjs --check`。
