# WP379 英文界面「agent」统一改成「assistant」（Luoye 10-17 同意）

worktree `../agentsws-wt/wp379-assistant` · 分支 `wp/379-assistant`（从 main 拉）。先读 `_common.md`、WP343 报告（「我的助理」与「替我答同事」）。

## 要做
英文界面里指「助理 / 替我答同事」的 agent 字样（如 "My agent"、"Ask my agent" 等）统一改成 assistant（"My assistant"…），和中文「助理」对上。只改用户看得到的英文文案、英文帮助文档与截图说明；**包名、事件名、代码标识符、API 字段不改**。注意别误改指「AI 同事 / 岗位里的 Agent」这类别的意思的 agent（逐条判断，拿不准的列进报告）。

## 测试
相关工作台测试与 i18n 测试跟上；`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）。测试用 `--maxWorkers=2 --testTimeout=120000`。

## 纪律
不读 .env*；不碰 key / token；不调真实付费接口；不连远程机器；不碰本机 4317；不批量清理；不用 pkill。不合 main、不打 tag、不发版（决策 381）。报告 `docs/briefs/reports/WP379.md`（改了哪些、哪些没改为什么；决策号 1061–1065），白话写。
