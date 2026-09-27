# WP167 收信只走一个入口：消息同步分拣后，只有判成客服的信才进客服那一路开事项；邮箱四个开关上界面

worktree `../agentsws-wt/wp167-mail-intake` · 分支 `wp/167-mail-intake`（从 main 新起）。先读 `_common.md`、`docs/briefs/reports/WP163.md`（「需要定」第 1、2 条）、`docs/63-消息与邮箱全量接入-v1.md`（§C、§D）、
`packages/channels/src/email/{adapter,support-mailbox,imap}.ts`、`packages/channels/src/messages/sync.ts`、`apps/server/src/{channels,messages,mailbox-actions}.ts`、连接页邮箱卡（`apps/workstation` 里 email 连接那张）。

## 问题（WP163 实现方报告，Fable 核实）
渠道那一路（`EmailChannelAdapter`，WP55）仍给 INBOX **每封新信**开事项、起 Run、过一遍客服判断层：订阅、通知、红人来信都会在工作台变成一条事项、花一次模型钱；判成客服的信还会被消息同步再递一次判断层。WP163 只管住了「挪信」，没管住「开事项」。

## Fable 定
**收信只走一个入口：消息同步。** 它先分拣（客服 / 红人 / B2B 预留 / 其他），**只有判成客服的信**才交给客服那一路开事项、起 Run；红人的交红人那一路（照现在的规矩），其他信只进「消息」页、不开事项、不起 Run、不花模型钱。挪信照 WP163：只由消息同步负责。

## 要做
1. 消息同步分拣后把客服信**递交**给客服那一路（复用渠道适配器的处理管线：Amazon 子渠道判定、游标、毒消息隔离、线程归并），渠道适配器不再自己轮询 INBOX；只装渠道、没装消息同步的老调用方保留老行为（有测试）。同一封信只进一次客服管线（按 Message-ID / uid 去重，有测试）。
2. 分拣判不准的（低置信度）：不开事项，放「消息」页的「待确认」一栏，人点「这是客服」再交给客服那一路（这一下算人工分拣，写事件）。
3. **四个开关上界面**：连接页那只邮箱的卡上加「影子模式 / 挪进 KefuAgents / 标已读」三个开关（「接管」就是这只邮箱开没开客服，已有的就复用）。照 docs/36 §7 少字规矩：卡上只有开关与一句话，解释进问号；影子模式打开时卡上醒目标「只看不动」。改开关写事件、立刻生效。
4. 模拟：dtc-3c-3p 的消息场景里加一两封订阅 / 通知信，断言它们不开事项、不起 Run；指标不许劣化（新增场景写进报告）。
5. docs/63 §D 改写成「收信一个入口」。

## 纪律
不连真邮箱（替身 IMAP）；契约只加不改；不跑批量清理命令；不读 .env*；**Luoye 的本机服务在 4317，别碰也别重启**。WP165 / WP166 在并行，改共享文件只动你那几处。

## 验证（审核方全量用）
`vitest run packages/channels packages/support-core apps/server apps/workstation` + fast 模拟两个包三个运行时 + `gen-sdk` / `gen-ontology --check`；截图：连接页邮箱卡三个开关（含影子模式打开的样子）、「消息」页待确认一栏。
