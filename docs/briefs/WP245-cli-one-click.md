# WP245 平台 CLI 一键安装 / 一键登录（用户看不到终端）

worktree `../agentsws-wt/wp245-cli` · 分支 `wp/245-cli`（从 main 新起）。先读 `_common.md`、`apps/workstation/src/components/connections/platform-cli-card.tsx`、平台工具包定义（`/v1/platform-kit/cli/check` 与 `/cli/login` 的服务端实现、`spec.install` / `login_command` / `min_node_major` / `telemetry_off_env`）、`apps/server/src/shopify-theme.ts`（`PASSTHROUGH_ENV`、`cli_missing`）、`apps/server/src/win-cli.ts`、`apps/desktop` 里捆绑 node 的位置（Windows：`resources/node/node.exe`）。

## 背景（Luoye 10-07，Windows 真机）
连接页的 Shopify CLI 卡现在让用户「在终端里跑 `shopify auth login`」再点「我登好了」；没装时让用户复制 `npm install -g @shopify/cli@latest`。我们的用户大多没有 IT 知识，**不能要求用户开终端、装 Node、敲命令**。Luoye 原话：能不能像 Claude 一样把终端集成进来，自动装、自动跑。
定的方向（Fable）：**不嵌通用终端**，而是工作台在后台替用户跑**工具包里登记过的那几条命令**（安装 / 登录 / 版本），界面只给按钮、进度、结果；命令与原始输出收在「详情」里。

## 要做
1. **一键安装，不依赖系统 Node**：用安装包自带的 node（及其 npm；没有就想办法带上或用 node 直接跑 npm 的 cli.js）把 CLI 装进**应用自己的数据目录**（如 `<data>/tools/shopify-cli`，`--prefix`），不写全局、不要管理员、不改 PATH。之后探测 / 调用优先用这份私有安装，系统里已有的全局安装也认。Mac / Windows 都要。带进度（下载中 / 安装中 / 装好了 / 失败一句人话 + 重试），超时与网络错误说人话（复用 WP242 的 cause.code）。
2. **一键登录**：按钮「登录 Shopify」→ 服务端起 `shopify auth login`（处理它的交互提示：按任意键打开浏览器之类），解析出登录网址后**由工作台打开浏览器**（桌面壳 `shell.openExternal` / 工作台 `window.open`），进程结束后自动复查登录状态、卡片变绿；去掉「我登好了」按钮（保留一个不显眼的「重新检查」）。登录期间显示「浏览器里登录完回来就行」+ 取消。密码只在 Shopify 网页上输入，我们不读不存。
3. **只放行登记过的命令**：新增的「替用户跑命令」能力只接受工具包 spec 里的 install / login / version 三类，参数固定，不接受任意字符串；AI 运行那条路不能调它。遥测关闭变量照旧带上。
4. 卡片文案按「界面少字」：主状态一行 + 一个主按钮；命令、日志、版本号进「详情」折叠。
5. 测试：假 npm / 假 shopify（脚本）覆盖 装好 / 网络失败 / 登录成功 / 用户取消 / 超时；Windows 路径（`.cmd` 壳、中文用户名路径）走 `win-cli.ts` 的单测。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连 Luoye 的 Windows（真机复测由 Fable 做）；不真的去 npm 装东西进系统全局（测试用假包或临时目录）。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；卡片各状态出截图；报告 `docs/briefs/reports/WP245.md`（要 Luoye 定的事单列）。
