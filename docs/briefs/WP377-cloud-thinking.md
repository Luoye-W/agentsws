# WP377 工坊积分（我们云端）能不能调思考深度：先调研，能就做（决策 1026，Luoye 10-17）

私有仓为主：worktree `~/Documents/agentsws-cloud-wt/wp377-thinking` · 分支 `wp/377-thinking`；开源仓（如需）worktree `../agentsws-wt/wp377-thinking` · 分支 `wp/377-thinking`。先读两边 `_common.md`、开源 `docs/briefs/reports/WP370.md` / `WP373.md`（思考档：快 / 标准 / 深度，WP373 的独立小钮）、私有 `packages/metering`（价目里的模型清单）、云端转发上游的代码（New API 网关 / 直连）。

## Luoye 原话（10-17）
「用工坊积分，也就是用我们自己的 API 接口时，要看我们的 API 接口对接的 AI 模型，能不能通过 API 去调整思考深度。如果可以的话，工坊和积分的我们还是要去做；不然的话，就不要做。」

## 第一步：调研（先做完、写进报告第一节，再决定第二步）
逐个列出云端价目里在卖的模型（DeepSeek v4 Pro / Flash、GLM、Kimi、通义、GPT 等），对每个：上游官方 API 有没有调思考深度的参数（参数名、取值、是否只开 / 关）、我们现在的转发链路（New API 网关或直连）能不能把这个参数原样带过去、思考 token 怎么计费（是否已在 token 构成里）。查官方文档与官方 pi-ai / dsh 目录里的声明；**需要实测时停下报告，由 Fable 用钥匙串 key 跑**，不要自己调付费接口。
结论分三类：能调（多档）/ 只能开关 / 不能调。

## 第二步：只对「能调」「能开关」的模型做
1. 云端价目给这些模型声明支持的档位（契约只加不删，开源 `packages/contracts` 同步、`cloud-openapi.json` 重出）。
2. 云端转发按上游写法带上档位；不支持的模型收到档位时忽略、不报错。
3. 开源客户端：工坊积分来源的模型按云端声明出 WP373 的思考小钮（快 / 标准 / 深度），没声明不出；「显示什么就发什么」（决策 1032）。
4. 计费：思考 token 照实计入，消耗速率（WP364）口径不变。
如果第一步结论是全部不能调，第二步不做，只交报告。

## 测试
私有：转发带档位（录好的上游样本，不连外网）、不支持时忽略、计费；smoke-workerd。开源：契约、小钮按声明出现；`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）。

## 纪律
不读 .env*；不碰 key / token / secret；不部署、不 wrangler 写操作；不调付费接口；不连远程机器；不碰本机 4317；不批量清理；不用 pkill。不合 main、不打 tag、不发版（决策 381）。报告两边 `docs/briefs/reports/WP377.md`（决策号 1051–1055），白话写。
