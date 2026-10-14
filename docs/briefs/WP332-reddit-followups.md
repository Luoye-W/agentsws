# WP332 Reddit / 社媒发出的两处遗留（决策 762 + 公关回评论缺链接）

worktree `../agentsws-wt/wp332-redditfix` · 分支 `wp/332-redditfix`。先读 `_common.md`、`docs/briefs/reports/WP329.md`（§遗留）、`docs/briefs/reports/WP328.md`、`docs/96`。

## 要做
1. **762**：Reddit（及其他走插件「填好等人点」的社媒发出）没发出去时（插件不在线超时、被拦、没登录、等不到人点、人点了停止），在社媒岗位页出一条提醒（按 docs/96 出现规则：同一件只一条、人看过可收起），配「再填一次」——不用重新批，直接把同一份已批草稿再交给插件；失败原因照实一句话。
2. **公关外部回评论**：公关「在别人帖子下回评论」的卡要带上被回那条评论的链接 / 全名（parent），插件才能找到回复框；从来源（巡查条目 / 线程）补齐，缺了就在出卡前补读，补不到就照实说、不出能发的卡。
3. 测试：替身插件 / 本地假页面覆盖两条路径。

## 纪律
不读 .env*；不碰 key / token / 账号；不打开真实 Reddit；不连远程机器；不碰本机 4317；不跑批量清理；不用 pkill。界面少字。不合 main、不打 tag、不发版（决策 381）。测试用 `--maxWorkers=2 --testTimeout=120000`。不做成某个客户专用的东西（决策 691）。

## 验证
`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包 × stub/direct/dsh + gen 检查 + 插件构建 + 装包前冒烟；报告 `docs/briefs/reports/WP332.md`（决策号 780–784）。
