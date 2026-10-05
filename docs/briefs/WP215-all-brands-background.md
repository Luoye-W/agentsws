# WP215 每个品牌的后台活同时跑（不管眼前切在哪个品牌）

worktree `../agentsws-wt/wp215-brands-bg` · 分支 `wp/215-brands-bg`（从 main 新起）。先读 `_common.md`、`docs/52`（品牌 = 工作区；§4 WP66「这一版没做的」——**本单就是收这条缺口**）、`apps/server/src/server.ts` 里调度装配（`createScheduleAssembly({ workspace_id: workspace.id … })`、`registerDailyPlan` / `registerReview` / 巡检 / 自动化 / 值守 / learning 夜扫 / catalog / secretary / meetings / orgDuplicates）、`apps/server/src/brand-modules.ts` 与 `brand-ports.ts`（WP66 每品牌一套的连接 / 模型）、`packages/schedule`、邮箱收信与 IM 渠道的启动（`imChannels.resume()`、mailbox sync）、`packages/roles` 的 `common.owner` 与巡检类职责（PR 监控、社媒 Reddit 等）。

## 背景（Luoye 10-05）
接了两个真实业务要用工具实测：① 给 INMO 代运营 Reddit（Reddit 官方论坛与全站监控是常驻自动化）；② 给一家获变形金刚 IP 授权的公司做独立站卖 TWS 耳机与音响（建站 + 推广）。担心「切换品牌后，另一个品牌的后台自动化就停了」。
Fable 查实：切换品牌只换视图、不停进程；但**调度器与它的消费者（定时巡检、每日计划 / 复盘、自动化任务、值守、learning 夜扫、catalog / secretary / meetings 的主动任务）只按 bootstrap 品牌装配**，第二个品牌的后台活基本不跑（docs/52 §4 已注明「仍按 bootstrap 品牌跑」）。

## 要做
1. **每个品牌一套后台**：进程启动时为组织下**每个品牌工作区**装配并启动它自己的：调度消费者（巡检 / 每日计划 / 复盘 / 战报 / 自动化任务 / 自建定时任务）、邮箱收信、IM 渠道、learning 夜扫与周合并、catalog / secretary / meetings 的主动任务；新建品牌时即时加入、删 / 停用品牌时停掉（删品牌整条路仍不在本单）。共用一个调度循环也行，但每条任务执行时的上下文（工作区、连接、模型、凭据、岗位、卡片队列）必须是**它自己品牌的**，绝不串品牌；全部走 WP66 的品牌模块。
2. **与「眼前品牌」完全解耦**：前端切换品牌只换视图；后台按品牌常驻。审计与事件照写各自 `workspace_id`。
3. **可见性**：品牌切换器里每个品牌一行显示后台状态（图标 + 数字，照 docs/36 第四档：在跑的定时任务数、最近一次巡检时间 tooltip、出错时红点）；组织页「品牌一览」同样一列。
4. **资源与安全**：每个品牌的模型调用、积分扣费、额度归属按各自品牌 / 岗位；并发上限按全进程统一控制（避免两个品牌同时巡检把本机拖慢），写进设置；出站闸、急停（kill switch）按品牌各自生效，也保留全局急停。
5. **测试与模拟**：
   - 服务端：两个品牌各建定时任务，视图停在 A 时 B 的任务准点触发，结果只进 B 的卡片流 / 事件；B 的邮箱收信照常；B 品牌急停只停 B。
   - 模拟：`dtc-15p` 的 `org/two-brands-cannot-see-each-other` 旁边加一条「B 品牌后台在 A 品牌视图下照常巡检」场景（三运行时都过；其余零漂移）。
6. docs/52 §4 把「这一版没做的」那段更新为已做；写清剩余限制：**进程跟着本机走，电脑关机 / 睡眠 / 断网时全部品牌都停**——托管（云端常驻）按品牌订阅另议。

## 纪律
契约只加不改；不读 .env*；不跑批量清理命令；本机 4317 服务别碰（用自己起的实例与 demo `--two-brands`）；验证日志写 worktree 里唯一文件名。

## 验证
`scripts/verify-changed.sh` + fast 模拟三包 × 三运行时 + `gen-sdk` / `gen-ontology --check` / `gen-cloud-contract --check` + `open-repo-boundary`；截图：品牌切换器里两个品牌的后台状态；报告 `docs/briefs/reports/WP215.md`。
