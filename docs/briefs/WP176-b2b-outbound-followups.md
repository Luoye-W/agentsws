# WP176 开发信后续：「不感兴趣」只停这一轮、公司地址进档案、跟进也由模型写、老邮箱免预热、Run 里的开发信工具、DKIM 检查不卡在 Gmail

worktree `../agentsws-wt/wp176-outbound-2` · 分支 `wp/176-outbound-2`（从 main 新起）。先读 `_common.md`、`docs/84-B2B岗位设计-v1.md`（§2、§11）、`docs/briefs/reports/WP173.md`（「需要定」一节）、`packages/b2b-core`、`apps/server/src/{b2b-outbound,b2b-service,b2b-mail}.ts`、`packages/core/src/{sequence,suppression}.ts`。

## Luoye / Fable 09-28 定
1. **「不感兴趣」只停这一轮，过段时间还能再联系**（Luoye）：不进永久抑制名单；这个联系人进「冷却」——默认 **90 天**内不进任何新一轮（职责阈值 `b2b_declined_cooldown_days`，可改），冷却期满可以再被选进新一轮；冷却中的人在名单里标出来、写明到哪天。**退订（unsubscribe）与硬退信仍永久进抑制名单**，不变。同一个人第二次回「不感兴趣」时冷却翻倍（180 天），并在卡上提醒。
2. **公司实体地址进公司档案**（Fable）：`WorkspaceProfile` 加可选地址字段（只加不改），开发信页脚、报价单、单证都从档案取；「主动开发」设置里原来那格迁过去（已有值自动搬，搬完只读显示并链到公司档案）。
3. **跟进与收尾也由模型写**（Fable）：和首封一样按 `cold-email` 技能写、承诺词守卫、写不成退回模板；每批上限照首封（20 封）。
4. **老邮箱免预热**（Fable）：发信邮箱加一个用户可勾的「这只邮箱已经正常发信很久」，勾了直接按每天 50 封；卡上一句提醒（新域名别勾）。
5. **Run 里的开发信工具**（Fable）：给 `b2b.outbound` 加只读 / 出卡的工具——列序列与漏斗、开一轮（出选择卡或首封批量卡，不直接发）、把一封回信分类；工具名进 `TOOL_WORDS_ZH`；执行器再判职责。快捷提示「起草开发信」进 Run 后能走通。
6. **DKIM 检查不卡在 Gmail**（Fable）：Gmail 自己发给自己的信不进收件箱，体检会一直「等测试信」。本单先做本机侧兜底：等测试信超过 10 分钟没收到，就按常见选择器（`google`、`selector1`、`selector2`、`k1`、`s1`、`default` 等）查 DKIM 的 DNS 记录，查到公钥记录就算「DNS 已配置（未经实信验证）」，允许发并在卡上写明；查不到仍不发。云端检查地址（把测试信发到云端读信头）留给网关那边，接口先留好。

## 纪律
契约只加不改；不连真邮箱 / 不真发信 / DNS 用替身；不跑批量清理命令；不读 .env*；**Luoye 的本机服务在 4317 别碰也别重启**；Luoye 的机器负载可能很高，测试 `--maxWorkers=2`，起服务钩子超时的文件串行重跑确认。

## 验证（审核方全量用）
`scripts/verify-changed.sh` + fast 模拟三个包三个运行时（`b2b-3c-3p` 加场景：不感兴趣进冷却、冷却期满可再选、退订仍永久）+ `gen-sdk` / `gen-ontology --check` / `gen-cloud-contract --check` + `scripts/open-repo-boundary.test.mjs`（用 vitest 跑）。
