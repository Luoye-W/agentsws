# WP376 Anthropic 官方 key 改走原生 Messages 接口（决策 1031，Luoye 10-17）

worktree `../agentsws-wt/wp376-anthropic-native` · 分支 `wp/376-anthropic-native`（从 main 拉，main 须已含 WP374；收尾前合最新 main）。先读 `_common.md`、`docs/briefs/reports/WP374.md`（1031）、`packages/model-gateway`、设置「AI 账号」里「Anthropic / Claude」那张卡。

## 要做
1. 「Anthropic / Claude」官方 key 方案从 OpenAI 兼容层改走 WP374 已接好的官方 pi-ai `anthropic-messages`（不自写协议）。
2. 已有配置启动时自动迁过去（地址、key 引用、选过的模型），迁移幂等、可回退；key 仍在本机加密库，不经 AI（决策 814）。
3. 迁过去以后能调思考程度（接 WP373 的开关），能力标签照官方 Claude 目录。
4. 中英文案与帮助文档同步。

## 测试
本机假服务模拟 Anthropic 官方口（不调真实付费接口）：迁移前后同一配置可用、思考档生效、报错人话；stub / direct / dsh；`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包。测试用 `--maxWorkers=2 --testTimeout=120000`。

## 纪律
不读 .env*；不碰 key / token；不调真实付费接口；不连远程机器；不碰本机 4317；不批量清理；不用 pkill。不合 main、不打 tag、不发版（决策 381）。报告 `docs/briefs/reports/WP376.md`（决策号 1041–1045），白话写。
