# WP163 客服收信只把「判成客服的信」挪进 KefuAgents（照老产品 KefuAgent）

worktree `../agentsws-wt/wp163-support-archive` · 分支 `wp/163-support-archive`（从 main 新起）。先读 `_common.md`、`docs/briefs/reports/WP161.md`（「需要 Luoye 定」第 1 条）、`docs/63-消息与邮箱全量接入-v1.md`（§C 文件夹名、分拣后 MOVE）、
`packages/channels/src/email/adapter.ts`（`archiveOne` / `archiveFolderOn`）、`apps/server/src/channels.ts`（`archive_folder` 默认 `ARCHIVE_FOLDER = SUPPORT_FOLDER`）、`apps/server/src/messages.ts`（消息同步的分拣与 MOVE）。

## 问题（Fable 09-27 核实）
WP55 的客服收信那一路（`EmailChannelAdapter`）把**处理过的每一封**收件箱来信都挪进归档文件夹，不看分拣结果、不看客服岗位开没开。WP161 把默认归档文件夹改成 `KefuAgents` 之后，订阅、通知、红人来信这类非客服信也会进 `KefuAgents`。
老产品不是这样：`~/Documents/KefuAgent/src/lib/support/service.ts` 的 `moveCustomerServiceMessageToAiFolder`（约 2029 行起）**只挪判成客服的信**，并且：影子模式（`shadowMode`）只记不动邮箱；`aiSupportFolderEnabled` 关了不挪；标已读（`aiSupportMarkRead`）与挪信（`aiSupportMoveEmails`）是两个开关；每个动作写一条邮箱动作日志（成功 / 跳过 / 失败 + 原因）。

## 要做（照移植优先：老产品是 Luoye 自己的代码，这段逻辑照搬语义；这个文件是业务代码，不是 MkSaaS 模板，但只搬逻辑、不搬它的 drizzle / ImapFlow 写法）
1. 客服收信那一路只把**分拣为客服**（`support` 路由 / 建了客服线程）的信挪进 `KefuAgents`；其余信原地不动、不标已读。
2. 同一只邮箱如果消息同步（messages.ts）也在跑，**挪信只由一处负责**，不许两处都挪、也不许互相挪来挪去。查清两条路现在谁先谁后，定一个归属写进 docs/63，并加测试钉住。
3. 对齐老产品的开关：影子模式（只记不动）、挪信开关、标已读开关（agentsws 里已有的同义设置就复用，没有的只加可选字段、默认值照老产品）。
4. 每次挪 / 跳过 / 失败写一条事件（原因码，不含信件正文与地址以外的个人信息），界面「消息」能看到最近一次失败原因。
5. docs/63 相应段落改写；报告里写明与老产品逐条对照的结果。

## 纪律
不连真邮箱（替身 IMAP）；不跑批量清理命令；不读 .env*。**Luoye 的本机服务在 4317，别碰也别重启**（那边可能连着真邮箱，本单合并之前不许让新代码跑到真邮箱上）。WP159 / WP162 在并行，改共享文件只动你那几处。

## 验证（审核方全量用）
`vitest run packages/channels packages/support-core apps/server apps/workstation` + fast 模拟两个包三个运行时。
