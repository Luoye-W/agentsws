# WP211 消息渠道接入飞书与钉钉

worktree `../agentsws-wt/wp211-feishu-dingtalk` · 分支 `wp/211-feishu-dingtalk`（从 main 新起）。先读 `_common.md`、`docs/42`（引第三方的评估）、官方功能优先（记忆：dsh 官方有的先用官方）、消息渠道现有实现（微信本人号、企业微信机器人：`apps/server` 与工作台消息渠道页、`packages/channels`、dsh-channels 契约）、`docs/63`、`docs/74`。

## 背景（Luoye 09-30）
「消息渠道你参考一下 Proma 的开源代码，或者其他的开源代码，把飞书和钉钉这两个中国最主流的也接进来。」

## 要做
1. **先查来源并写评估**（进报告与 `docs/63` 补一节）：
   - DeepSeek Harness 官方（本机 `~/Documents/deepseek-harness` 或 npm 上 `@deepseek-ai/*`）有没有飞书 / 钉钉渠道插件——**有就优先用官方的**，我们只包一层；
   - Proma（查实它的开源仓库与许可证）、飞书官方 `@larksuiteoapi/node-sdk`（长连接 WebSocket 事件订阅）、钉钉官方 Stream 模式 SDK（`dingtalk-stream`）等；逐个写许可证、维护状态、要不要公网回调；许可证不兼容的只学思路不拷代码。
2. **接法**（两家都优先「长连接 / Stream」模式——本机不需要公网回调地址）：
   - 飞书：企业自建应用（App ID / App Secret）+ 机器人能力；私聊与群里 @ 机器人都收；
   - 钉钉：企业内部应用机器人（Client ID / Client Secret）+ Stream 模式；私聊与群 @ 都收；
   - 行为与企业微信那条一致：团队成员在群里 @ 它 / 私聊它，按提问人身份作答；推给人的只有「摘要 + 去工作台处理」链接，**不放通过 / 驳回按钮**（决策与凭据不经聊天软件）；提问人身份映射到本机成员（首次需在工作台绑定一次）。
   - 凭据只在工作台原生表单里由用户填，直接进本机加密库，不经 AI、不进日志、填完不回显。
3. 消息渠道页加两张卡（照 WP210 的少字规矩：名字 + 问号 + 状态 + 主按钮；图标用官网 favicon——与 WP210 同一个抓取脚本，冲突两边都留）；教程两篇（中英）：飞书开放平台建应用、开机器人、开长连接、拿 App ID / Secret；钉钉同理。
4. 测试：替身事件（不连真飞书 / 钉钉）覆盖私聊、群 @、身份未绑定、断线重连、凭据错误给人话。

## 纪律
契约只加不改；不读 .env*；不用上下文里的任何密钥；测试不连真服务；不跑批量清理命令；本机 4317 服务别碰；新依赖照 docs/42 评估并登记 upstreams。

## 验证
`scripts/verify-changed.sh` + fast 模拟三包 stub（零漂移）+ `gen-sdk` / `gen-ontology --check` / `check-upstreams --check` + `open-repo-boundary`；截图：消息渠道页两张新卡、填表单态；报告 `docs/briefs/reports/WP211.md`。
