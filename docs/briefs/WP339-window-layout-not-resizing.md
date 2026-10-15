# WP339 Windows 上界面不随窗口宽高调整（Luoye 10-15 截图）

worktree `../agentsws-wt/wp339-layout` · 分支 `wp/339-layout`。先读 `_common.md`、`apps/desktop/src/main.ts`（BrowserWindow 创建、大小 / 位置记忆、zoomFactor、DPI、硬件加速）、`apps/workstation/src/components/app-shell.tsx` 与全局样式（根元素高宽、`100vh` / `100dvh`、固定尺寸）、WP264 之后对外壳布局的改动。

## 现象（Luoye 的 Windows 真机，beta.5，品牌 INMO，「Reddit 运营 › 自家版运营」页）
两张截图，窗口宽 2000 像素级：整个界面（左栏、主区、右侧竖排图标）只占窗口左上约 88%，右边和下边是一条空白带；换一个窗口大小后，界面按同样比例整体缩小，**没有随窗口宽高重新排版**（左栏底部、右侧图标栏都停在离窗口边缘一截的地方）。像是渲染内容停在旧尺寸 / 被整体缩放。

## 要做
1. 找根因（附证据）：区分是渲染进程布局（CSS 根高宽、某个固定尺寸容器、ResizeObserver 逻辑）还是桌面壳（窗口 resize / maximize 后内容不重绘、zoomFactor、Windows 显示缩放 125% / 150% 下的 DPI 处理、GPU 合成问题、恢复上次窗口尺寸的逻辑）。在本机 Electron 开发构建里用不同窗口尺寸、最大化 / 还原、改缩放来复现；Windows 测试机只读查 `%APPDATA%\@agentsws\desktop\logs\desktop.log` 与窗口状态文件。
2. 修好：任何窗口大小、最大化 / 还原、多显示器 / 不同缩放下，界面都铺满窗口并重新排版；窄窗口时按现有响应式规则收起侧栏（若没有就补最基本的）。
3. 加回归测试：Playwright 驱动 Electron（或工作台在浏览器里）改视口尺寸后断言根容器 = 视口；Windows CI 若能截图就加一段。

## 纪律
不读 .env*；不碰 key / token；Windows 测试机只读（不改系统设置、不装卸软件、不改应用数据、不输出凭据）；不碰本机 4317；不跑批量清理；不用 pkill。不合 main、不打 tag、不发版（决策 381）。本单允许 push 本分支跑 Windows CI。测试用 `--maxWorkers=2 --testTimeout=120000`。

## 验证
`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包 + gen 检查 + 装包前冒烟 + 复现 / 修复前后截图；报告 `docs/briefs/reports/WP339.md`（决策号 828–832）。
