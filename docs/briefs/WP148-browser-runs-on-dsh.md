# WP148 带浏览器的运行改走 dsh 运行时（服务端也真能用浏览器、看截图）+ 安装包第三方许可证说明

worktree `../agentsws-wt/wp148-browser-dsh` · 分支 `wp/148-browser-dsh`（从 main 新起）。先读 `_common.md`、WP144 报告（「服务端只有带电脑操控的运行改走 dsh 运行时」那条偏离与它的实现）、
WP147 报告「需要 Luoye 定」第 1、3 条、docs/55 §3 / §10、`apps/server/src/runtime.ts`（WP144 的分流写法）、`apps/server/src/browser-settings.ts`（`forRun()`）。

## 问题（WP147 报告 + Fable 复核）
服务端的运行平时走 direct / stub 运行时，**那条路上没有浏览器工具**（WP86 起），浏览器提供方只在 dsh 运行时里挂。所以设置页配好了浏览器
（独立 Chrome / 我正在用的浏览器），服务端的运行其实用不上，WP147 打通的截图进模型也只在电脑操控那一跳生效。Luoye 09-24 要的是「截图给 AI 看、用起来方便」，浏览器这条腿必须真能用。

## 要做
1. **分流**：照 WP144 的写法，`RunRequest.browser` 在场（职责 `browser_scope` 非空 + 设置页选了一种浏览器 + `forRun()` 给了）的运行改走 dsh 运行时；其余运行照旧，一个字节不变。
   电脑操控与浏览器同时在场时同一棵树挂两样（顺序照 harness：mount → 门禁 → 浏览器 → 电脑操控）。
2. **端到端测试**（不联网、不开真浏览器）：服务端一次带浏览器的运行真的走到 dsh、提供方挂上、`browser_navigate` 过门禁（白名单内放、外拒）、`browser_take_screenshot` 的图片到了替身模型；没开浏览器的运行仍走原路（事件序列与改前逐字相同）。
   Playwright 提供方可以用 WP82 那种「attach 一个没人监听的端口」拿到工具表；BrowserSkill 用现有替身。
3. **性能**：dsh 运行时起一棵树比 direct 慢多少，测一下写进报告；太慢的话说明原因与可选办法，不要自己去改运行时架构。
4. **安装包第三方许可证**：桌面安装包（`apps/desktop` 的打包配置）带上第三方许可证清单文件——至少覆盖 WP147 带进来的 `sharp` / libvips（LGPL-3.0，动态库形态）、Chromium / Electron、以及现有的其它原生依赖；
   有现成的生成方式（比如按 `pnpm licenses list` 产出）就用，放进安装包的「关于 / 许可证」能看到的位置。只做说明，不改依赖。
5. docs/55、docs/80 补一句「服务端带浏览器的运行走 dsh 运行时」。

## 纪律
不打开真浏览器操作网页、不启动 cua-driver、不截真屏；不跑任何批量清理命令；测试不联网。截图用 demo 时端口 4438。

## 验证（审核方全量用）
`vitest run apps/server packages/dsh-adapter apps/desktop packages/runtime-direct` + fast 模拟两个包三个运行时（应零漂移）+ 桌面打包 `pnpm -F @agentsws/desktop package --dir` 看许可证文件在不在。
