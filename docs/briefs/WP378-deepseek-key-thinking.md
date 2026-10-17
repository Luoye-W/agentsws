# WP378 用户自带 DeepSeek key（Chat 口）也出思考档小钮（决策 1055，Luoye 10-17）

worktree `../agentsws-wt/wp378-ds-key` · 分支 `wp/378-ds-key`（从 main 拉，main 须已含 WP373；收尾前合最新 main）。先读 `_common.md`、开源 `docs/briefs/reports/WP377.md`（1054、1055 与 Fable 实测：DeepSeek Chat 口 `thinking.type` + `reasoning_effort`，v4 Pro / Flash 都收 max / high / low / disabled，reasoning_tokens 含在 completion_tokens 里）、`WP373.md`、`packages/model-gateway` 里 DeepSeek API key 那条。

## 要做
用户在设置里填自己的 DeepSeek API key、走 Chat 口的那条来源，出 WP373 的思考档小钮，映射与工坊积分一致：v4 Pro 快 = 关掉思考 / 标准 = high / 深度 = max；Flash 快 = low / 标准 = high / 深度 = max；「显示什么就发什么」（1032）。账号路由（走 Messages 口）若已有档位，确认两条来源口径一致。

## 测试
本机假服务（不调真实付费接口）核请求体；三个运行时 stub / direct / dsh；`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包。测试用 `--maxWorkers=2 --testTimeout=120000`。

## 纪律
不读 .env*；不碰 key / token；不调真实付费接口；不连远程机器；不碰本机 4317；不批量清理；不用 pkill。不合 main、不打 tag、不发版（决策 381）。报告 `docs/briefs/reports/WP378.md`（决策号 1056–1060），白话写。
