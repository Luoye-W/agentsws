# WP372 窗口布局重排：左栏两层、对话列表进右侧面板、右上横排图标、去掉顶部搜索框、两条 Reddit 职责改名（Luoye 10-17 定 C3，决策 1001–1003）

worktree `../agentsws-wt/wp372-layout` · 分支 `wp/372-layout`（从 main 拉；收尾前合最新 main）。先读 `_common.md`、`docs/96`（界面组件目录）、决策 690（缺设置在对话 / 第三栏弹卡就地完成）、847、WP342 / WP343 报告（左栏下半、账号菜单、助理页会话列表 `session-list.tsx`）、`components/app-shell.tsx`、`components/rail/*`（`right-rail.tsx`、`registry.ts`、`builtin-panels.tsx`、`rail-state.tsx`、`rail-scope.ts`）、`components/palette-context.tsx`、`packages/roles/roles/social/reddit.yml`、`pr/reddit.yml`。

## Luoye 定的（10-17）
- **1001 布局选 C3，并学 Claude 桌面版**：岗位 → 职责 → 对话三层里，左栏只放两层（岗位、职责，用细竖线把职责挂在岗位下，职责字小一号、颜色淡一点）；**对话列表放进右侧面板**。现在第三栏那一竖条图标改成**窗口右上角横排**；不常用的收进最右一个「⋮」，点开是 Claude 那种右侧面板：一块块可折叠的小卡片纵向排（参考截图：Claude 的 Environment / Context / Connectors / Outputs / Background tasks）。
- **1002 去掉主区右上角的「交给某个岗位一件事… ⌘K」搜索框**（Luoye 不知道它干嘛用；派活现在由助理做，WP343）。
- **1003 改名**：社媒「自家版运营」→ **官方版块**（en: Official Subreddit）；PR「Reddit 营销」→ **外部版块**（en: Other Subreddits）。只改显示名，职责 id（`social.reddit` / `pr.reddit`）不动；提示词里「你是谁」等自称同步改；docs/help 与教程同步。

## 要做
1. **左栏**：岗位行（图标 + 名字、500 字重）可点进岗位总览；职责挂在细竖线上（13px、次要色）可点进职责；默认展开当前岗位，其余收起（鼠标移上去出展开箭头，不显示数字——Luoye 之前定的）。
2. **右上横排图标**：把现在 `RightRail` 的竖排图标改成主区右上角一排（与窗口标题栏对齐，Mac 留出红绿灯、Windows 留出窗口按钮）。常用的直接露出，**建议**：对话（新，带「+ 新对话」）、浏览器、文件、定时任务；其余（证据、变更审阅、发出记录、记录、设定、帮助、数据面板、运行中……）进「⋮」。哪些露出写进报告让 Luoye 确认，别写死在多处——用 `registry.ts` 的一个字段（如 `pinned`）。
3. **右侧面板**：点横排图标 → 右侧面板打开到那一块；点「⋮」→ 面板显示全部小卡片（Claude 式：标题 + 一两行摘要 + 「显示更多」，每块可折叠，折叠状态按作用域记住）。面板内容仍按当前岗位 / 职责取（`rail-scope.ts` 不变）。连接卡 / 配置卡（决策 690）照旧弹进这个面板并自动打开，不能被新布局挡住。
4. **对话列表块**：当前职责的对话按「今天 / 本周 / 更早」分组，顶上「+」开新对话；在岗位总览时按职责分组列出全部对话。和助理页 `session-list.tsx` 共用组件、可搜索。
5. **去掉搜索框**：删掉主区右上那个框和它的 UI；`⌘K` 快捷键与 `palette-context` 你判断：若别处没用就一起删，若有用（如快速跳转岗位）保留快捷键不显示框，写进报告。
6. 窄窗口：右侧面板盖在主区上（不挤压），图标横排在窄宽下收进「⋮」。
7. `docs/96` 组件目录、左栏 / 第三栏描述同步；中英文案；界面少字。

## 协调
WP370 在改输入框模型钮和设置「AI 账号」页，WP364 改 AI 钮文字；本单不动输入框内部。合 main 时冲突两边都留。

## 测试
工作台组件测试：左栏两层与展开规则、横排图标与「⋮」、面板打开到对应块、连接卡自动弹出仍可见、对话列表分组与新对话、搜索框已去、改名后的显示名（含路由选择文案 `wp237-route-choice` 等测试同步）。端到端（真服务 + stub）：进岗位 → 进职责 → 在右侧面板开新对话 → 发一条。截图：Mac 宽窗 / 窄窗、浅 / 深、Windows 标题栏位置。`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包 × stub / direct / dsh。测试用 `--maxWorkers=2 --testTimeout=120000`。顺手看一下老负载项 `test/wp207-sidebar.test.tsx` 能不能一起修稳。

## 纪律
不读 .env*；不碰 key / token；不调真实付费接口；不连远程机器；不碰本机 4317；不批量清理；不用 pkill；截图用别的端口、拍完停掉，不写 .review-ready。不合 main、不打 tag、不发版（决策 381）。报告 `docs/briefs/reports/WP372.md`（决策号 1004–1008），白话写。
