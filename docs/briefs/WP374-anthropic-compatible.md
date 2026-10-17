# WP374 接 Anthropic 兼容接口（Claude 中转站等）（决策 980，Luoye 10-17 同意）

worktree `../agentsws-wt/wp374-anthropic` · 分支 `wp/374-anthropic`（从 main 拉，main 须已含 WP370；收尾前合最新 main）。先读 `_common.md`、`docs/briefs/reports/WP370.md`（第 1 节调研、980）、`packages/model-gateway`、设置「AI 账号」页里自定义接口那块（WP370 加的「也在 AI 钮里显示」）。

## 要做
1. **先找现成的**：官方 pi-ai / dsh 对 Anthropic Messages 协议的支持（WP370 调研说官方有），直接用官方的 provider，不自写协议。
2. 设置里新增接口类型「Anthropic 兼容」：填地址 + key（key 走本机原生表单 / 加密库，不经 AI，决策 814）；能拉模型清单就拉（`GET /v1/models`），拉不到手填；勾选的模型进 AI 钮，按来源分组显示。
3. 思考程度：该协议的 extended thinking 若官方 provider 支持，就接到 WP373 的思考开关上；不支持就不出。
4. 联网 / 看图等能力标签按官方声明显示。
5. 中英文案、`docs/help` 里接自己 AI 的那篇补一节。

## 测试
用本机假服务模拟 Anthropic 兼容口（不连真实中转站、不调付费接口）：拉清单、发一轮、流式、报错（key 错 / 额度没了）的人话提示；三个运行时 stub / direct / dsh；`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包。测试用 `--maxWorkers=2 --testTimeout=120000`。

## 纪律
不读 .env*；不碰 key / token；不调真实付费接口；不连远程机器；不碰本机 4317；不批量清理；不用 pkill；截图用别的端口、拍完停掉，不写 .review-ready。不合 main、不打 tag、不发版（决策 381）。WP373 同时在改输入框工具条，本单只动设置页与 model-gateway，冲突两边都留。报告 `docs/briefs/reports/WP374.md`（决策号 1030–1034），白话写。
