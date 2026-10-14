# WP319 Windows 真机三个问题：店铺已连仍显示「没连接」、更新重启太慢像被删了、卡在「进行中」的失败任务

worktree `../agentsws-wt/wp319-winfix` · 分支 `wp/319-winfix`。先读 `_common.md`、`docs/briefs/reports/WP301.md`（Shopify / Horizon）、WP292 发版流水线、`apps/desktop` 的自动更新（electron-updater / NSIS 配置）、数据看板与「店铺管理」面板的连接判断代码。

## Luoye 10-14 在 Windows 上看到的（beta.4，品牌 Rollout）
1. **Shopify 店铺已经连上了**（店铺管理里能查商品），但首页右侧「店铺管理」面板（总销售额 / 订单数 / 转化率 / 库存告急数）和独立站岗位「数据看板 · 店铺管理」仍显示「还没连接店铺后台 · 去连接」「这个数据源还没连上」。→ 查清面板判断「连没连」读的是哪一份连接（是不是只认老的自定义应用 token / 另一个 key，而没认工坊 Shopify 应用经云端 OAuth 的那条），改成认同一份；连上了就出数。顺带看 GA4、评价应用那几行判断对不对。
2. **应用更新**：点「重启更新」后窗口消失，要等很久新版才起来；这期间点桌面图标提示「应用不存在」，像被删了。别的应用是界面上显示进度、然后 5 秒内自动重启到新版。→ 查清慢在哪（NSIS 卸旧装新、文件数太多（node_modules 没进 asar？）、压缩方式、杀毒逐个扫、是否走了带界面的安装器等），给出并实现改法：下载完在界面里显示进度、安装静默且尽量快（如 asar 打包减少文件数、合适的 NSIS 压缩 / oneClick、`quitAndInstall(true, true)` 静默并自动重启）、安装期间有可见提示（比如安装器小窗或启动页「正在更新到 x.y.z」），装完自动打开新版。目标：从点「重启更新」到新版出现尽量 ≤ 10 秒，且全程用户看得到在发生什么。
3. 独立站岗位「店铺管理」下有一条「查询店铺当前在售产品」一直挂在「进行中」，旁边显示「dsh 组合装配失败：unsupported …」。→ 查清这是 10-13 dsh 工具 schema 问题那次留下的（已修）还是新问题；失败了的运行应落成「没跑成」而不是一直「进行中」；老数据启动时自检修正。

## 真机
可用 Windows 测试机只读排查（见 memory「Windows 真机」：Tailscale 100.65.150.57、admin、钥匙 `~/.ssh/agentsws-win`；用应用自带 node 读 `%APPDATA%\@agentsws\desktop\data\events.db`）。**只读**：不改系统 / 安全设置、不装卸软件、不动业务账号、不点任何对外动作。

## 纪律
不读 .env*；不碰 key / token；不碰本机 4317；不跑批量清理；不打 tag、不发版、不合 main（决策 381）。本机负载很高（别的项目在渲染视频，别碰它），测试用 `--maxWorkers=2 --testTimeout=120000`。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + gen 检查 + 装包前冒烟；更新那块写清怎么在下一版真机验证；报告 `docs/briefs/reports/WP319.md`（决策号从 630 起）。
