# WP382 中文界面「代理」统一成「助理」（决策 1061，Luoye 10-17）

worktree `../agentsws-wt/wp382-zhuli` · 分支 `wp/382-zhuli`（从 main 拉，main 须已含 WP379；收尾前合最新 main）。先读 `_common.md`、`docs/briefs/reports/WP379.md`（1061 列了分布：工作台 `secretary.*`、`people.ask`、`im.*`，微信 / 飞书 / 钉钉三篇帮助，连接目录两条说明，官网「你的代理替你答同事」）。

## 要做
中文用户可见文字里，指「我的助理 / 替我答同事」的「代理」统一改成「助理」。**逐条判断**：「网络代理」「代理的 fake-IP 模式」「检查网络或代理」等网络义不改；键名、包名、事件名、接口字段不改。拿不准的列进报告。

## 测试
相关工作台 / i18n / 官网测试跟上；`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）。测试用 `--maxWorkers=2 --testTimeout=120000`。

## 纪律
不读 .env*；不碰 key / token；不调真实付费接口；不连远程机器；不碰本机 4317；不批量清理；不用 pkill。不合 main、不打 tag、不发版（决策 381）。报告 `docs/briefs/reports/WP382.md`（决策号 1077–1080），白话写。
