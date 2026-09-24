# WP147 截图给 AI 看：电脑操控与浏览器的截图都送进模型

worktree `../agentsws-wt/wp147-screenshots` · 分支 `wp/147-screenshots`（从 main 新起）。先读 `_common.md`、docs/80（电脑操控）、docs/55 §3 / §10（浏览器两条腿）、
WP127 报告（模型必须能看图、三步验证）、WP143 报告（DeepSeek Files API 复用）；代码：`packages/dsh-adapter/src/llm.ts`（`blockText` 现在把非文字块全丢）、
`computer-use.ts` 的 `redactComputerUseValue` 与 `SCREENSHOT_OMITTED`、`gate.ts` 约 698 行、`harness.ts`；官方 README：`dsh-mcp-client`（MCP 结果适配器的图片准入）、
`dsh-experimental-computer-use-cua-driver-mcp` 与 `…-browser-use-playwright-mcp` 的「模型体验 / 截图」一节、附件存储相关包（上游 `deepseek-ai/deepseek-harness` tag `dsh-v0.1.7-rc.1`）。

## Luoye 09-24 定
**截图改成给 AI 看**（WP144 默认不进模型，Luoye：不给看用起来很不方便）。

## 现状（Fable 核实）
- 电脑操控：`redactComputerUseValue` 在 `tools/post-execute` 把图片块换成一句说明。
- **浏览器也一样看不到图**：`llm.ts` 的 `blockText` 只取 `text` 块，工具结果里的 image 块在送进我们网关前就丢了；官方 MCP 适配器还要求「挂附件存储 + 模型路由声明支持图片输入」才放图，我们的最小树两样都没有。

## 要做
1. **打通图片这条路**：按官方做法让 MCP 工具结果里的图片进到模型请求——挂官方附件存储（本次运行作用域；不落我们的库、不进事件日志、不上云），模型路由按我们网关的能力声明图片输入（WP127 起模型必须能看图，三步验证没过的来源不声明）；`llm.ts` 把 image 块转成我们 `ChatMessage` 的图片内容（契约只加不删；形状对齐 WP127 看图验证用的那一种）。WP143 的 Files API 复用对 DeepSeek Messages 路自然生效。
2. **电脑操控**：去掉截图脱敏（`screenshot_out_file` 往任意路径写文件那条硬拒**保留**）；提示词里「截图不会传给你」那句改成能看截图、优先结合无障碍树文字。
3. **浏览器两条腿都受益**：官方 Playwright 提供方的 `browser_take_screenshot`、BrowserSkill 的截图动作，同样进模型。门禁读写分类不变。
4. **预算与体积**：沿用官方 spill-policy / 图片 token 预算（0.1.7 的 `maxInlineTokens`）；截图过大按官方规则缩放；一轮里旧截图超预算时按官方做法换占位。写清一次运行最多带几张。
5. **隐私告知（白话）**：电脑操控授权卡、设置页电脑操控说明、浏览器设置说明各加一句「截图会发给你选的 AI 模型用来看界面，不会存进 Agents 工坊的记录」。docs/80 隐私一节改写。
6. **测试**：替身模型收到的请求里确有图片（电脑操控截图 + Playwright 截图各一条）；事件日志 / 数据目录里没有图片字节；没声明看图的路由不放图并给出官方诊断；三步验证没过的模型来源不声明图片输入；WP144 原有门禁测试不退化。fast 模拟三个运行时零漂移（没开浏览器 / 电脑操控时行为一字不变）。

## 纪律
不在这台电脑上启动 cua-driver 或操作桌面、不截真屏；不跑任何批量清理命令；测试不联网。

## 验证（审核方全量用）
`vitest run packages/dsh-adapter packages/model-gateway apps/server apps/workstation apps/desktop packages/contracts` + fast 模拟两个包三个运行时。
