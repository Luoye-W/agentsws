# WP153 真账号冒烟发现的三个小问题：回答露工具名与 markdown、事项摘要跑题、店主查不到岗位与连接

worktree `../agentsws-wt/wp153-reply-fixes` · 分支 `wp/153-reply-fixes`（从 main 新起）。先读 `_common.md`、docs/35 09-26「DeepSeek 账号真账号冒烟」那条、docs/36（界面规范）；
代码：事项时间线（`apps/workstation/src/components/work/` 下 matter / timeline 相关）、摘要生成（`apps/server/src/runtime.ts` 与 `packages/stand-ins/src/runtime/support.ts` 的「查了…」、`packages/kol-core/src/playbook.ts` 的 `describeKolRun`，找出事项顶部那行「查了退货政策」从哪来）、
职责 `packages/roles/roles/common/owner.yml`、工具注册（`packages/runtime-direct`、`apps/server/src/runtime.ts` 的 executeTool 链）。

## Luoye 09-26 定：三个都修

### 1. 回答里露出内部工具名、markdown 符号原样显示
真账号的回答写着「我用 `search_policies` 查了三轮」，`**粗体**` 原样显示。
- **时间线把 markdown 安全地渲染出来**（粗体、列表、编号、行内代码最多这几样；不许原始 HTML、不许图片外链、链接只许 http(s) 并加 rel=noopener）；已有的 markdown 渲染组件能复用就复用。
- **不露工具名**：给所有职责的提示词公共段加一句「对用户说话时不提工具名、函数名、内部 id，用人话说做了什么」；再加一道兜底——已知工具名（全部注册过的工具名表）出现在给人看的回复里时，换成它的人话名（复用 WP141 的 `lib/humanize.ts` / `KOL_TOOL_ZH` 那一套思路，服务端做成一张统一的「工具名 → 人话」表）。
- 屏幕裸值守卫测试（WP141 的 `screen-words.test.tsx`）扩到时间线里的 Agent 回复。

### 2. 事项摘要跑题
问的是「有哪些岗位和连接、先处理哪三件事」，事项顶部摘要却是「查了退货政策。」——摘要是拿**这次调了哪些工具**拼的（`search_policies` → 退货政策）。
- 摘要改成说**这件事本身**：优先用 Agent 这一轮给人的回复的第一句（截断到一行，去 markdown），没有回复才退回「做了什么」；工具的人话名要准（`search_policies` 查的是「规矩 / 政策库」，不只是退货政策）。
- 三个运行时（stub / direct / dsh）口径一致；模拟包若断言了摘要措辞，按惯例改断言并写明。

### 3. 店主查不到「有哪些岗位、有哪些连接」
店主职责被问到时只能说「这个工作区没有给我能列出岗位和连接的工具」。
- 给 `common.owner` 加两个**只读**工具：列岗位（岗位名、下面的职责、谁在岗、有没有范围）、列连接（连了哪些、状态、哪条职责要它但还没连）。数据来自现有接口 / 服务（org、connections），不新造存储；权限按 owner 的 workspace 范围；**不带任何凭据、token、密钥字段**。
- 工具描述写人话；加测试：owner 能调、别的职责没有这两个工具、返回里没有敏感字段。

## 验收
- 用 stub 运行时在 demo 里复现一次「帮我看看有哪些岗位和连接，最该先处理哪三件事」：回答里有真实岗位 / 连接名、没有工具名、粗体正常显示、摘要是这件事本身。截图到 `docs/assets/wp153/`。

## 纪律
不联网、不用真账号；不跑批量清理命令；不读 .env*。Luoye 的本机服务在 127.0.0.1:4317，别碰；截图 demo 端口 4442。

## 验证（审核方全量用）
`vitest run apps/server apps/workstation packages/runtime-direct packages/stand-ins packages/kol-core packages/roles` + fast 模拟两个包三个运行时。
