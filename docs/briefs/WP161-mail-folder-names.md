# WP161 邮箱子文件夹名与老产品对齐：KefuAgents / KOLAgents（认已有文件夹不分大小写），预留 BtoBAgents

worktree `../agentsws-wt/wp161-mail-folders` · 分支 `wp/161-mail-folders`（从 main 新起）。先读 `_common.md`、`docs/63-消息与邮箱全量接入-v1.md`（§「分拣后 MOVE」与 `archive_folder`）、
`apps/server/src/messages.ts`（`DEFAULT_FOLDERS`、`move`、`folderPathFor`）、`apps/server/src/channels.ts`（`archive_folder`）、`packages/channels/src/email/{imap,messages,triage}*.ts`（`mailboxCreate`、`folderPathFor`、`triageMessage`）。

## 问题（Fable 09-27 核实）
Luoye 的老产品：KOLAgents 建的是 **`KOLAgents`**（`~/Documents/KOLAgents/src/influencer/mailbox/kolagents-folder.ts:40`），KefuAgent 是 **`KefuAgents`**（`~/Documents/KefuAgent/src/lib/support/service.ts:222`）。
agentsws 写成了全小写 `kolagents` / `kefuagents`。很多 IMAP 服务器文件夹名区分大小写：用过老产品的人接进来，邮箱里会出现两个名字相近的文件夹，信分在两处。

## Luoye 09-27 定
AI 分拣判定并自动处理的信要挪进对应子文件夹：客服 → `KefuAgents`、红人 → `KOLAgents`、**B2B → `BtoBAgents`**（B2B 岗位还在设计，本单只预留）。支持一个工作区接多个邮箱账号（已支持，本单每个账号各自处理）。

## 要做
1. 规范名改成 `KefuAgents` / `KOLAgents`；加一个常量 `BTOBAGENTS_FOLDER = 'BtoBAgents'` 与路由 `b2b` 的预留（契约只加：`MessageRoute` / `folder_kind` 加 `b2b` 可选值；**分拣器现在不产出 b2b**，等 B2B 岗位的 WP 接上；UI 上没有 B2B 岗位时不显示这个文件夹）。
2. **认已有文件夹不分大小写**：每个邮箱账号先列服务器上的文件夹；有 `KefuAgents` / `kefuagents` / 任何大小写变体就**沿用已有的那个真名**，都没有才按规范名新建。多个变体同时存在时优先规范名，其余照常扫描（信不挪、不删、不改名）。每个账号单独判断、单独缓存。
3. `DEFAULT_FOLDERS`、`archive_folder` 默认值、扫描清单、界面「消息」文件夹显示名跟着改（显示名走 i18n：客服在处理 / 红人合作 / B2B 往来）。旧配置里显式写了别的名字的照旧。
4. docs/63 相应段落改写，注明与老产品同名的原因。
5. 测试（替身 IMAP，不联网）：只有小写旧文件夹 → 沿用小写、不新建；只有规范名 → 用规范名；都没有 → 新建规范名；两个邮箱账号各自一套；MOVE 失败只 log、信仍可见（63 §5 原规矩）。

## 纪律
不连真邮箱；不跑批量清理命令；不读 .env*。Luoye 的本机服务在 4317，别碰。WP158 / WP159 / WP160 在并行，改共享文件只动你那几处。

## 验证（审核方全量用）
`vitest run packages/channels apps/server apps/workstation` + fast 模拟两个包三个运行时。
