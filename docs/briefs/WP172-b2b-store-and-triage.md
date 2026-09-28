# WP172 B2B 数据落盘与邮件分拣：B2B 库、服务端读写入口、B2B 信挪进 BtoBAgents 并交给 B2B 这一路

worktree `../agentsws-wt/wp172-b2b-store` · 分支 `wp/172-b2b-store`（从 main 新起）。先读 `_common.md`、**`docs/84-B2B岗位设计-v1.md`**（§5 分拣、§11 覆盖前文）、`docs/briefs/reports/{WP161,WP163,WP167,WP171}.md`、`packages/contracts/src/b2b.ts`、`packages/b2b-core`、`packages/channels/src/messages/{sync,triage*}.ts`、`packages/channels/src/email/support-mailbox.ts`、`apps/server/src/{messages,channels,mailbox-actions}.ts`、`packages/data`（本机 SQLite 的写法）、`packages/txn`（改动卡提交流程）。

## 要做
1. **B2B 库（本机 SQLite，照 `packages/data` 的写法与迁移）**：客户、联系人（来源必填）、商机、报价与不可改的报价版本、样品、名单、展会与展会线索、出运单——WP171 契约里的九类对象落盘；按工作区隔离；每条写变更都走 `txn` 改动卡（出卡规矩按职责 YAML 与 `HARD_L1`），读不经卡。
2. **服务端读写入口**：`/v1/b2b/*`（列表 / 详情 / 新建草稿 / 提交改动卡），权限按职责 scopes；进 SDK（`gen-sdk`）。CSV 导入客户与联系人用 `b2b-core` 的表头别名，导入名单本身出卡（docs/84 §1.2）。
3. **邮件分拣产出 `b2b`**（WP161 已预留路由与 `BTOBAGENTS_FOLDER`，WP167 已是单一入口）：判成 B2B 的顺序（docs/84 §5）：线程对得上我们发出去的 B2B 信 → 发件人在 B2B 客户 / 联系人库里 → 平台通知信（阿里国际站等询盘通知）→ 模型分类（低置信进「待确认」）。判成 B2B 的信：按这只邮箱的开关挪进 `BtoBAgents`（认已有大小写变体，同 WP161），交给 B2B 这一路落成询盘或往来记录（开事项、起 Run 只在 B2B 岗位开着时；没开 B2B 岗位的工作区**不挪、不开事项**，同 WP163 的规矩）。多邮箱各自处理。
4. **退订与退信**：分拣时认出退订回复（unsubscribe / 退订 / remove me 等）与退信（bounce），直接进 `core/suppression.ts` 抑制名单，并停掉这个联系人的开发序列（序列本身下一单做，这里先写抑制与事件）。
5. **「待确认」一栏**加「这是 B2B」按钮（与 WP167 的「这是客服」同一套：人工分拣写事件）。
6. 模拟：`b2b-3c-3p` 加场景——客户询盘挪进 BtoBAgents 并落成询盘、平台询盘通知、退订回复进抑制名单、没开 B2B 岗位时不挪；dtc 两个包不许劣化。

## 纪律
契约只加不改；不连真邮箱（替身 IMAP）；不跑批量清理命令；不读 .env*；**Luoye 的本机服务在 4317 别碰也别重启**。

## 验证（审核方全量用）
`scripts/verify-changed.sh` + fast 模拟三个包三个运行时 + `gen-sdk` / `gen-ontology --check` / `gen-cloud-contract --check` + `scripts/open-repo-boundary.test.mjs`；截图：「消息」页 B2B 往来文件夹、待确认里的「这是 B2B」、B2B 业务面板落成的询盘。
