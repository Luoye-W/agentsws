# WP298 页面出错不再一片空白：错误边界 + 把前端报错记进本机日志（Luoye 10-13 Windows 真机）

worktree `../agentsws-wt/wp298-errboundary` · 分支 `wp/298-errboundary`（从 main 新起）。先读 `_common.md`、`apps/workstation/src/App.tsx`（路由）、`apps/workstation/src/components/app-shell.tsx`、桌面壳 `apps/desktop`（日志写在 `%APPDATA%/@agentsws/desktop/logs/desktop.log`）、服务端日志接口（若无则新增）。

## 现象
Windows 上 v0.2.0-beta.2：点「消息渠道」（截图上同时选中的是「连接」）主区一片空白。Fable 经 SSH 隧道用同一台服务、同一份数据在 Chrome 里打开同一页**正常**——所以多半是 Electron 渲染进程里某处抛错、React 整棵树卸掉。工作台里**没有任何错误边界**（grep ErrorBoundary / errorElement 为 0），桌面日志也没记渲染进程的报错，所以真机上看不到原因。

## 要做
1. **错误边界**：路由层（每个页面一层）+ 应用外壳一层。出错时主区显示一句人话「这一页出错了」+「重新加载」「回首页」两个按钮 + 一行可展开的技术信息（错误名 + 第一行，不含任何用户数据），左栏与顶栏照常可用。懒加载（右栏面板）的加载失败同样兜住，并处理 `vite:preloadError`（升级后旧页面加载新版分块失败 → 自动整页重载一次）。
2. **前端报错记日志**：错误边界捕获、`window.onerror`、`unhandledrejection` → 发给本机服务一个新接口（如 `POST /v1/client-errors`，限流、截断长度、去掉 URL 查询串与可能的个人数据）→ 写进服务日志；桌面壳里额外把渲染进程 `console-message`（level=error）与 `render-process-gone` 记进 `desktop.log`。
3. **查原因**：在本机用 Electron 打包或 `pnpm --filter @agentsws/desktop dev`（如可行）分别打开「消息渠道」「连接」两页，看 Electron 里是否能复现；能复现就顺手修掉根因，不能复现就在报告里写清排查过程（我们下一个装到 Windows 的版本带着日志就能看到真错误）。
4. 测试：工作台用例（某页抛错 → 显示出错页、其它导航可用；`vite:preloadError` → 重载一次不死循环）；服务端接口限流与截断；装包前冒烟照过。

## 纪律
不读 .env*；不碰 key / token；不跑批量清理；不碰本机 4317；不连远程机器；不合 main、不打 tag、不发版（决策 381）。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + gen 检查 + 装包前冒烟；报告 `docs/briefs/reports/WP298.md`（决策号从 393 起）。
