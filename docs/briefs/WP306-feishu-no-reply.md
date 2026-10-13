# WP306 飞书机器人：绑定成功后问话没有任何回复（Luoye 10-13 Windows 真机）

worktree `../agentsws-wt/wp306-feishu` · 分支 `wp/306-feishu`（从 main 新起）。先读 `_common.md`、`docs/help/im-feishu.md`、`docs/briefs/WP211-feishu-dingtalk.md` 与报告、`apps/server/src/im-channels.ts`（`answerTeam` / `askFor` / `onError`）、飞书长连接适配器（grep `feishu` / `lark` 于 `apps/server/src` 与 `packages/`）、`server.ts` 里 im-channels 的装配（`askAgent` → `secretary.ask`、`assignmentOf`）。

## 现象（v0.2.0-beta.3，INMO 品牌 `ws_0llwvcm2` 是启动品牌，Luoye 本人 `per_04z0v421`）
1. 飞书开放平台：企业自建应用、机器人能力、三项权限、事件订阅「长连接」+ `im.message.receive_v1`、已发布。工坊消息渠道里飞书卡右上角绿勾。
2. 在飞书私聊机器人发「绑定 xxxxxx」→ 回「绑好了」，事件库有 `connection.changed {channel: feishu, im_event: im.person_bound}`。
3. 接着私聊发「Reddit 运营今天有没有什么需要我处理的」→ **机器人没有任何回复**；事件库里**之后什么都没有**：没有 `im.answered`、没有 im 报错（`onError` 写的 `connection.changed`）、也没有任何 `run.*`。
4. 该人在启动品牌有三条分配（`common.owner`、`pr.reddit`、`social.reddit`），在 Rollout `ws_19cxxs7l` 也有多条。`assignmentOf` 取的是启动品牌里第一条没撤的——大概率是 `common.owner`。

## 要做
1. **查根因**（用假飞书长连接 / 录制的事件体在本机复现）：消息到没到 `answerTeam`？是被适配器过滤（消息类型、chat_type、去重、@ 判定、发布后要重连才收到新订阅等）、`askFor` 早退（没分配、分配取错）、`askAgent` 挂住（等模型 / 等运行没回调）、还是异常被吞？把结论写进报告。
2. **永不静默**：收到一句能认出是谁的话，先在 1–2 秒内回「收到，我查一下」（或飞书「正在输入」状态，如果 API 支持），再给答案；`askAgent` 超时（如 90 秒）回一句人话 + 去工作台的链接；任何异常都回一句人话并记事件（只记原因不记正文）；没有岗位也回一句「你在这个品牌还没有岗位，去工作台设置」，不再一声不吭。
3. **问谁**：不要默认落到 `common.owner`；按问题里点名的岗位 / 职责（「Reddit 运营」）找这个人在**任一品牌**里对应的分配，点不出就用这个人在启动品牌（或他最近用的品牌）里的主要岗位；多品牌同名岗位时回一句让他选或按最近使用。
4. **加诊断事件**：`im.received`（渠道、person、字数）、`im.ask_failed`（原因码），方便以后远程查。
5. 测试：服务端真进程 + 假飞书事件：绑定后问话必有回复；`askAgent` 挂住时超时回话；异常回话；点名岗位路由到对应分配；没岗位回话。

## 纪律
不读 .env*；不碰 key / token；不跑批量清理；不碰本机 4317；不连远程机器；不连真飞书。合并前若 main 有新提交，先合 main、`npx tsc -b`。不合 main、不打 tag、不发版（决策 381）。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + gen 检查 + 装包前冒烟；报告 `docs/briefs/reports/WP306.md`（根因、修法、要 Luoye 定的事，决策号从 446 起）。
