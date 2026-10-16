# WP361 设置弹窗三处收尾（Luoye 10-16 定 925 / 926 / 927）

worktree `../agentsws-wt/wp361-settings2` · 分支 `wp/361-settings2`（从合了 WP356 的 main 拉）。先读 `_common.md`、`docs/briefs/reports/WP356.md`、`apps/workstation/src/components/settings-panel/sections.tsx`、`components/account-block.tsx`、桌面壳托盘与开机自启（`apps/desktop/src`）。

1. **925**：「进行中」看板从设置弹窗挪到账号菜单「工作内容」组（与会议 / 知识库 / 技能并列，路由与 ⌘K 照旧）；「工具箱」留在弹窗。
2. **926**：账号菜单拿掉「语言」（只在设置弹窗 → 个人 → 通用里改）；深浅色与场景切换留在菜单。
3. **927**：开机自启做成弹窗「这台电脑 → 桌面端」里的开关：桌面壳加一条桥（读 / 写登录项，Windows 与 Mac 各自的做法，沿用托盘那一处的实现），网页端 / 非桌面端不出这一项；托盘菜单那一处保留且两边同步。

测试：菜单项位置、语言只在弹窗、开机自启开关读写与托盘同步（桌面壳单测 + 工作台）。verify-changed + 模拟三包 + gen 检查 + 装包前冒烟。纪律同 _common；不合 main。报告 `docs/briefs/reports/WP361.md`（决策号 951–952）。
