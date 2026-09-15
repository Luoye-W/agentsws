# 48 · 客服与红人两个岗位：从 KefuAgents / KOLAgents 移植 v2（方案稿）

| | |
|---|---|
| 状态 | **v2 方案稿，等 Luoye 拍板 L1–L8**；v1 的 K1–K8 已按 09-14 的新方向重写（K2 / K3 / K4 的本地部分保留，K5 / K6 整体推翻） |
| 新方向（09-14 Luoye 定） | **KefuAgents 与 KOLAgents 两个 SaaS 不再长期维护（不是立刻断）。以 agentsws 为核心，把两个 SaaS 的"线上部分"重建为 agentsws 的增值部分。** 于是不再有"本地 ↔ 旧 SaaS 同步 / 交接"，只有"agentsws 本地 ↔ agentsws 托管"这一种关系 |
| 职责拆法（09-14 Luoye 定） | 客服不按售前 / 售后拆，拆成**网站客服、网站在线客服（实时聊天）、Amazon 客服**三条 |
| 实现进度 | **L1 / L2 由 WP54 实现**（三条职责 + 岗位模板 + 垂直包参数化 + 公司档案「你卖的是」），落点逐条见 §3 末的表；§7 L7 第一条里「岗位列表加客服三条」与「公司档案加你卖的是」两处界面已落地。L3 的其余条目、L4–L8 未动 |
| 输入 | 两份只读调研（KefuAgent 主仓 + Shopify 应用 + Flutter；KOLAgents 主仓，插件仓在未挂载外置盘，§1 是浓缩）、41 §2 数据三档（托管档）、36 / WP36（桌面壳"连接公司服务器"远程模式已落地）、20（导出 / 导入 / Join）、11 §4、33、04 / 27、19、46 |

## 0. 一句话

**两个 SaaS 的能力分成两堆搬：能在用户机器上跑的进 agentsws 本体（免费开源），只能在云上跑的重建成 agentsws 托管档的增值服务（收费）。** 客服岗位已经搬了一半，补安全边界；红人岗位从零建。知识库不需要"同步"——付费用户的工作区搬到云上跑，桌面端连着同一个库改，关机也在线；免费用户本地跑，关机就停。两个旧 SaaS 保持运行到迁移工具就绪，用户一键把数据搬进 agentsws。

## 1. 两个 SaaS 各自有什么（调研浓缩）

（v1 §1 原文保留，判断不变。）

### 1.1 KefuAgents（客服）

| 能力块 | 现状 | 在 agentsws 里 |
|---|---|---|
| 邮箱 IMAP / SMTP 收发、去重、线程归并 | 完整；每文件夹 UID 游标、毒消息隔离、扫描租约、归档文件夹 | `packages/channels` 已有基础版；缺归档文件夹、游标持久化、租约 |
| Amazon 买家消息 | 寄生在客服邮箱上，正则识别 22 个 marketplace 域，认证失败降级人工；出站硬闸（外链 / 联系方式 / 营销语）；24h SLA 三档 | **没有** |
| 网站在线聊天 widget | 公开端点 + Origin 白名单 + 限流 + SSE + 求助超时转邮件 | **没有，且天然要云端** |
| 处理流水线 | 分流 → 风险 / 缺料 → 抽订单号 → 查订单 → 检索知识 → 取已答边界 → 起草 → 视觉附件 → 出站守卫 → 十道自主发送门 → 人审 → outbox → 对账 → 归档 | 分类 / 边界 / 起草 / 升级 / SLA 在 `support-core`；订单事实经连接器（WP53 在接）；十道门、outbox 对账、视觉附件**没有** |
| 垂直包（实物 / 虚拟） | 两个包各 13 组差异，逐字节冻结有 parity guard | `support-core` 只装了实物那一套的一部分 |
| 售前 / 售后 | 不是模式，是每条知识的适用范围 `stage_scope` | 知识层没有 stage 字段 |
| 知识库 | 文章 + 候选 + 媒体 + 缺口 + 业务边界 + 复核；六条建法；长上下文优先无向量库；溯源四件套 + 事实指纹 + 源页复核 + stale 降权；承诺类永不自动发布 | 19 有出处 / 有效期 / 三层权限 / 缺口 / 冲突 / markdown 往返；**缺**事实指纹、源页复核、stage、长上下文档 |
| 自主发送门 G01–G10 | 固定顺序、fail-closed、只记录不发送、规则集只可加行 | 14 + 15 + halt 覆盖一半；G04（L3 黑名单）、G06（草稿来源）、G10（承诺扫描）**没有** |
| 影子质检 + 回流 | 对比 AI 草稿与人工回复出四项分数，不可采纳的萃取成候选 | **没有** |
| 卡片流 / 移动端 / IM 卡片 | 11 种卡型五动作；Flutter 四端；飞书 / 钉钉 / 企微 | deck 已对齐；IM 投递在后置 |
| Agent Gateway | REST + MCP + 签名 webhook | 我们的 `/v1` + SDK；**迁移工具用它读旧数据** |
| 计费 | 积分 1 = $0.01，成本 ×3，套餐 + 充值 | 重建时按 12 的混合计费 |

### 1.2 KOLAgents（红人营销）

| 能力块 | 现状 | 能不能本地做 |
|---|---|---|
| 品牌 / 产品初始化 | 完整 | 能 |
| 找红人四扇门 | YouTube 官方 API（全站日配额）+ Apify 降级 + 共享库 | 算法能本地；**数据供给**只能云端 |
| 浏览器插件采集（YouTube / TikTok / IG） | 只读用户正在看的页面、用户主动触发；租户侧 / 公共库侧两组端点；配对流程；日配额预扣 | 插件不动，改指向 agentsws 云 |
| 红人库 | 双层：共享事实 + 私有归属；同一人只有共享邮箱自动合并；已拒绝持久化 | 私有层本地；公共层云端 |
| 打分 | 启发式 + LLM 混合，刷粉护栏 | 能 |
| 建联 | 每封现生成、禁承诺正则兜底；人审才发；日配额 + 抖动；序列；CAN-SPAM；抑制名单 | 能 |
| 回复识别、陌生来信 | 封闭 6 类；双条件自动转化 | 能 |
| 合作管理 | campaign 向导、条款、交付物十态、UTM、GA4 / Shopify 归因、k-匿名基准 | 基准只能云端，其余能 |
| 监控 | 竞品 / 关键词 / 战略红人 | 算法本地，数据供给云端 |
| MCP | 18 工具 | 迁移工具用 |

### 1.3 四条硬边界

1. **天然只能在云端**：24 小时在线、公网 webhook 与 OAuth 回调、聊天 widget 脚本分发、公共红人库与插件汇聚、k-匿名基准、YouTube 配额池、跨账号风控。
2. **能本地做但要常驻进程**：IMAP 轮询、SLA 扫描、定时跟进——桌面壳在就行，关机就停。
3. **安全边界是多层硬编码**：AI 不许承诺钱和样品，两个 SaaS 各有四道独立防线，不做成开关。
4. **合规姿态是 schema 的一部分**：来源 URL、同意范围、采集模式是一等字段。

## 2. 新方向下的总结构（L0）

```
                agentsws 开源本体（免费，本地跑）
                ├─ 客服岗位：网站客服 / 网站在线客服 / Amazon 客服
                ├─ 红人营销岗位：六条职责 + kol-core
                └─ 知识库、账本、审批、范围、登记表（已有）
                              │ 同一套代码、同一个工作区
                agentsws 托管档（收费，41 §2.3）
                ├─ 在线值守：把你的工作区服务进程放到云上 7×24 跑
                ├─ 在线聊天 widget 托管（脚本分发、公网端点、SSE）
                ├─ 公共红人库服务（插件汇聚、去标识化基准、配额池、邮箱抓取）
                ├─ 公网回调（Shopify / Amazon / IM / 支付）、手机推送
                └─ 模型与转写按量、钱包（12）
```

- **不再有第三方 SaaS 之间的同步与交接**：付费 = 同一个工作区换个地方跑，桌面壳切"远程模式"（WP36 已做）连上去；本地改知识就是改云上那个库。
- 旧 SaaS 只剩一件事：**把用户的数据搬进 agentsws**，然后退役。

## 3. 岗位怎么定（L1–L2）

### L1 "客服"岗位模板 = 三条职责，默认全勾，可去勾

| 职责 | 一句话 | 连接器 | 写动作与额度 | 来自 04 的哪几条 |
|---|---|---|---|---|
| **网站客服** `dtc.support` | 客服邮箱（和网站表单）里的一切：售前问答、订单物流、退换货、退款、改地址、投诉 | 客服邮箱；Shopify 商品 / 库存 / 订单 / 物流只读；物流追踪 | 折扣码（≤ 10%）、退款（≤ $50 且未超窗）、补发（≤ 1 件）、改地址（未发货）——**额度按动作分，不按售前 / 售后分** | 合并 `dtc.presales` + `dtc.aftersales`；售前 / 售后变成意图与知识 stage |
| **网站在线客服** `dtc.live-chat` | 网站聊天窗里的实时对话：秒回 FAQ、缺料追问、求助转人工、超时转邮件跟进 | 聊天 widget（**托管档提供**）；同一套知识与订单只读 | 同上但默认更保守：聊天里只答不承诺，涉钱一律转邮件 / 卡片 | 新建；KefuAgent 的 `chat-service` 那条并行流水线 |
| **Amazon 客服** `amz.support` | 买家消息（寄生在客服邮箱）：24h SLA、站内信问答、售后 | 客服邮箱（Amazon relay）；后续 SP-API Messaging | 出站硬闸（无外链 / 无联系方式 / 无营销语）；退款走 SP-API 时再给额度 | 就是 `amz.buyer-messages` 改名 |

- 共用的只有 `customer-care` 说话纪律（04 §2 那条"不合并"的规矩保留在**额度与模板**层面）。
- **建议补两条候选**（不进第一版，先登记在 04 §9 待定）：`social.dm-support` 社媒私信客服（Instagram / Facebook / TikTok Shop 私信，KefuAgent 也没做）；`support.qa` 客服质检（影子质检、抽检、采纳率看板——给主管看的，可以先并进复盘不单立）。

### L2 实物 / 虚拟是工作区档案字段；售前 / 售后是知识适用范围（不变）

- 46 公司档案加"你卖的是：实物商品 / 虚拟产品与服务"；`support-core` 按垂直包参数化，代码里禁止 `if (vertical === 'digital')`，parity guard 照搬。
- 知识条目加 `stage: both | presales | postsales`；网站客服按意图判定当前 stage 过滤；邮件是混合渠道不硬过滤。
  **WP56 实现**：`FactCard.stage`（缺省 `both`）落在 `contracts/knowledge.ts` 与 `knowledge/schema.ts`（只加列）；检索入参 `stage` 做过滤下推——只排除**只属于另一头**的条目，`both` 与没标 stage 的两头都进；不传 `stage` 就不过滤，这就是邮件那条"混合渠道不硬过滤"。

### 实现落点（WP54）

| 条 | 落在哪 | 具体是什么 |
|---|---|---|
| L1 三条职责 | `packages/roles/roles/dtc/support.yml`、`dtc/live-chat.yml`、`amz/support.yml` | `dtc.presales` + `dtc.aftersales` → `dtc.support`（数据域 / 连接器 / 写动作与额度全部并集，**额度按动作分**，major 2.0.0）；新建 `dtc.live-chat`（同一套知识与订单只读，写动作一条没有，连接器 `chat_widget` 先登记）；`amz.buyer-messages` → `amz.support`（只改名不改语义） |
| L1 旧 id 兼容 | `packages/roles/src/load.ts` 的 `ROLE_ID_ALIASES` + `assignments.migrateRoleIds()` | 别名表只可加行；已有分配在服务进程启动时迁一次并记 `assignment.role_migrated`（只改 `role_id` / `role_version`，范围与采纳率一个字不动，已撤销的不动，幂等） |
| L1 岗位模板 | `packages/roles/positions/customer-care.yml` + `apps/server/src/org.ts` 的 `SEED_POSITIONS` | 「客服」= 三条默认全勾 + `common.member` 可选；解析不到的职责在种岗位那一步筛掉。截图 `docs/assets/workstation/roles-support-position.png` |
| L2 垂直包 | `packages/support-core/src/verticals/`（`goods/` + `digital/`） | 人设 / 聊天硬性边界 / 邮件起草规则 / 意图三套枚举 / L3 永不自动发送 / 缺料追问 / 知识探测 / 业务边界 registry 从 KefuAgent **逐字节**抄内容，不抄框架；`getVerticalPack()` 是唯一解析入口，非法值与缺省一律回落实物 |
| L2 代码里不许判垂直 | `packages/support-core/test/vertical-no-literal.test.ts` | 扫 `src/**` 源码禁止 `vertical === 'digital'` 这类字面比较，并反过来验扫描器自己认得出违规；另有一条 parity guard 钉两个包的字段面递归相同 + digital 三条红线 |
| L2 公司档案 | `WorkspaceProfile.vertical` → 向导第 ① 步与设置页同一个 `ProfileForm` | 默认实物；不给 = 沿用上一次；非法值 400；选项的中文名与那一句人话**从服务端来**（真源是垂直包），界面不自己写一份文案。截图 `docs/assets/workstation/roles-support-vertical.png` |
| L2 传到运行时 | `RunRequest.vertical`（`apps/server/src/runtime.ts` 晚绑定填）→ stub / 规则脑 / 共享 `boundaryGate` / dsh 四条路 | 用户在设置页改完下一次运行就生效，不用重启；模拟回路那一侧从 `workspace.yml` 的 `vertical` 读 |
| L2 模拟 | `packs/dtc-3c-3p/scenarios/digital-vertical/account-issue.yml`（场景 DSL 新增 `dataset.vertical`） | 虚拟产品工作区来信问登录：分类走 digital 意图表、不查订单、**追问注册邮箱而不是订单号**。3 人 pack 15/15 → 16/16，stub / direct / dsh-subprocess 三档全过；15 人 pack 13/13 |

**顺带修掉的两个真问题**（都是被这次改动照出来的）：

1. 客服拆成三条之后，一句"退款、投诉、包裹"对网站客服与 Amazon 客服打一样的分，秘书按 id 字典序判给了 `amz.support`，而工作区里没人持有它——出来是一张没人能认领的卡。`scoreRoles` 的并列处理改成**先看有没有人在做**。
2. dsh 那条运行时在 `reading.ts` 里自己抄了一份 goods 的回信模板，于是工作区改成虚拟产品之后只有它还在向一个没有订单的客户要订单号。改为委托 `renderReplyBody`（实物那一档逐字节相同）。

**这一版没做的**：L3 的其余条目（stage 过滤、聊天 widget、影子质检…）与 L4–L8 一条没动；`dtc.live-chat` 的连接器 `chat_widget` 只是**登记**，托管档还没有，所以这条职责现在勾上也连不上东西。

## 4. 客服岗位：还要搬什么（L3，不变）

全部进 agentsws 本体（`support-core` 纯函数 + `packages/channels` + `packages/knowledge`），先安全边界后功能：

| # | 搬什么 | 落到哪 |
|---|---|---|
| 1 | 垂直包（两套人设 / 规则 / 意图 / L3 黑名单 / 边界 registry） | `support-core/verticals/*` |
| 2 | Amazon 渠道识别、出站硬闸、SLA 三档 | `support-core` + `packages/schedule` |
| 3 | 自主发送门 G04 / G06 / G10 | 15 的 guardrail 前置：`l3_denylist` / `draft_origin` / `commitment_scan`，fail-closed，规则集哈希只可加行 |
| 4 | outbox 状态机 + 对账（`sent_unknown` 绝不自动重试） | `packages/channels` 出站 + housekeeping |
| 5 | 邮箱加固：UID 游标持久化、毒消息隔离、扫描租约、`agentsws` 归档文件夹 | `packages/channels` |
| 6 | 知识溯源链：事实指纹、源页复核、stale 降权、承诺类永不自动发布 | 19 FactCard 加字段；健康看板加复核卡。**WP56 实现**：`knowledge/fact-fingerprint.ts`（五类受管辖数值，词表冻结的纯函数，零模型）、`provenance.ts`（溯源等级读取时派生 + 分层排序 + 承诺类永不自动激活）、`recheck.ts`（源 hash 变 → 比指纹 → 标 `stale` + 开三选一复核卡）；存储只加列 + 复核队列一张新表（`knowledge/schema.ts`）；`GET /v1/knowledge/rechecks`、`POST /v1/knowledge/rechecks/:id/resolve`；模拟题 `knowledge/source-changed-recheck` |
| 7 | 长上下文检索档（全库 ≤ 预算整库注入） | `packages/knowledge/retrieval.ts`。**WP56 实现**：`mode: 'context'`（缺省预算 16000 字符，全库按更新时间倒序整库注入、**不检索**），超预算退回 `lexical`，`hybrid` 留接口不实现；两档都叠一层溯源分层装箱；`stage` 过滤下推（只排除只属于另一头的条目） |
| 2 | Amazon 渠道识别、出站硬闸、SLA 三档 | `support-core` + `packages/schedule`。**WP55 实现**：`support-core/amazon/{detect,outbound-guard,sla}.ts`（常量表与正则逐字节抄 KefuAgent，识别规则是安全边界的一部分）；`channels` 线程台账加 `channel` / `channel_meta` 两列 + **注入式**判定钩子（规则住 `support-core`，`channels` 是更低一层，反过来依赖会把依赖链倒过来）；`defaultRoute` 判成 amazon 的落 `amz.support`；`apps/server` 在 `deliver` 里跑硬闸、把钓鱼 / 退信 / 索赔类落事项但不起 Run、登记 `support.amazon_sla` 每 5 分钟 sweep。SLA 的唯一时钟锚是 `last_buyer_message_at`，只有买家消息族写它 |
| 3 | 自主发送门 G04 / G06 / G10 | 15 的 guardrail 前置：`l3_denylist` / `draft_origin` / `commitment_scan`，fail-closed，规则集哈希只可加行。**WP55 实现**：`support-core/gates/{gates,l3-denylist}.ts`（九类六语词表 + 子句级否定守卫 + 句内共现的让步兜底）；`txn/precheck.ts` 三个字段 **只记录不改状态**、`autonomous` 用 `undefined` 表示「没问过」；`txn/approvals.ts` 建卡时落一条 `guardrail.gate_decided`（只有门名、结论、规则 id 与规则集哈希，被扫的文本一个字不进日志）。四条纪律与规则集哈希见 15 §3.4 |
| 4 | outbox 状态机 + 对账（`sent_unknown` 绝不自动重试） | `packages/channels` 出站 + housekeeping。**WP55 实现**：`channels/outbox.ts` 七态 + 合法迁移表（写在数据里，不写在四散的 `if` 里）+ 失败三态分类器 + 退避表；`sqlite-queue.ts` 迁移 v2，`(workspace_id, idempotency_key)` 唯一索引就是「同一审批项只发一次」的落地处；`channels.reconcile_deliveries` 每分钟拿 Message-ID 去已发 / 归档文件夹找证据，退避六轮耗尽出一张人工卡。状态机与对账流程见 18 §3.3 |
| 5 | 邮箱加固：UID 游标持久化、毒消息隔离、扫描租约、`agentsws` 归档文件夹 | `packages/channels`。**WP55 实现**：`channels/email/cursors.ts` + 迁移 v3（每文件夹一个游标，`uid_validity` 变了旧水位全部作废）；毒消息**跳过但不推水位**、连续三次才永久越过并出卡；扫描租约是条件 UPDATE + 条件 INSERT 包在事务里（不是先查后写），到期自动释放；归档失败一律只 log。外加死信重投 `POST /v1/channels/dead-letters/:id/requeue`（owner，**人**按，不自动不批量不定时）。游标 / 租约 / 重投的规范见 18 §2.4–§2.6 |
| 6 | 知识溯源链：事实指纹、源页复核、stale 降权、承诺类永不自动发布 | 19 FactCard 加字段；健康看板加复核卡 |
| 7 | 长上下文检索档（全库 ≤ 预算整库注入） | `packages/knowledge/retrieval.ts` |
| 8 | 影子质检 + 回流 | 24 学习回路 |
| 9 | 知识包导入、历史邮件学、缺口补、边界问答卡 | 知识包 = 我们的 markdown 格式（§6 迁移工具共用）。**WP56 实现**：`knowledge/pack.ts`（`kefu-knowledge-pack/v1` ↔ `FactCard` 双向转换）+ `zip.ts`（内存 zip，解包拒绝绝对路径与路径穿越）；`POST /v1/knowledge/import`、`GET /v1/knowledge/export`；`packages/learning/src/history.ts`（先聚类再出题，成本跟簇数走）；缺口两种补法（贴链接 / 粘文字）与边界清单 `GET /v1/knowledge/boundaries` 都在知识页 |
| 10 | 视觉附件 | 模型网关视觉位，后置 |
| 11 | **在线聊天**：聊天流水线（词表分类 → 计划 → 轻模型答 → 求助 / 转人工 / 超时转邮件） | **WP57 实现（本地部分），落点见 §4.1**；流水线进 `support-core` / `channels`（本地能跑）；**widget 与公网端点**在托管档 |

不搬：官网爬取（留给托管档做"知识引导"服务，或后置）、计费代码。

### 4.1 实现落点（#11 本地部分，WP57）

| 条 | 落在哪 | 具体是什么 |
|---|---|---|
| 纯函数层 | `packages/support-core/src/chat/` | 零 IO、零模型（同 `support-core` 纪律）。轮次聚合（2s 静默 / 20s 爆发）、词表分类（八种意图，`ChatIntent` 名字不改——WP54 的垂直包按这些名字引用规则）、回复计划（五种动作）、教 AI、求助超时 |
| 五种动作 | `chat/plan.ts` | 判定顺序即优先级：`handoff`（人已接管 / 会话不接受自动回复）→ `assist`（点名要真人）→ `human_review`（**涉钱** / 高风险 / 包里的必审意图）→ `collect_info`（缺关键资料且这一类缺了走不下去）→ `answer`。第三条是 §3 L1 那句"聊天里只答不承诺，涉钱一律转卡片 / 邮件"的机器可读形态：`money_touch` 为真时 `can_auto_reply` **恒**为 false，任何垂直包都覆盖不了它（包只决定措辞，决定不了要不要过人） |
| 渠道与会话表 | `packages/channels/src/chat/` | 会话 / 消息 / SQLite 存储 / 入站限流 / SSE 事件流。与邮件**共用**同一条入站管线、同一个受控原始材料区、同一张队列、同一张去重表。写进 18 §2.4 |
| 实时车道 | `apps/server/src/chat.ts` | 接线：一条会话 = 一件事项（thread ref 与邮件同一套钉法）、每一轮的判定进事件日志、出卡走 14 的审批项与 31 §3.3 的收件人门禁、批了的卡由出站推进会话、急停 outbound 时说得出为什么。求助超时巡检挂 `support.chat_assist_timeout` |
| 求助超时 | `support-core/src/chat/assist-timeout.ts` | T+3 提醒（一次）、T+10 转邮件跟进。两个钟点从 `assist_requested_at` 一列算出来。没接邮件渠道时会话照样转态但**不假装发了邮件** |
| 本地 API | `packages/api/src/routes/chat.ts` | 八条 `/v1/chat/*`，**全部只对已登录用户开放**；会让 AI 对外说话的那几条过出站急停，读的那几条不受影响（停机时还要看得见发生过什么）。SSE 那条是唯一不返回统一信封的，鉴权与别的一样且**凭据不进 URL**（20 §3 / 21 §5）。端出去的会话不带 `visitor_id`（21 §4 的加密主体键，没有界面需要它） |
| 聊天沙盒页 | `apps/workstation/src/pages/chat-sandbox.tsx` | widget 要等托管档；在那之前商家怎么知道他的在线客服会怎么答——**自己坐到访客那一边试一遍**。左边扮演访客，右边看判成哪种、为什么、碰没碰钱、花没花模型、出没出卡，外加人工接管与「教 AI」。`dtc.live-chat` 岗位面板顶部给入口。截图 `docs/assets/workstation/chat-sandbox.png` |
| 模拟 | `packs/dtc-3c-3p/scenarios/chat/*.yml` | 两条回归题钉两句硬话：`faq-answer-and-money-handoff`（问运费 → 答；问退款 → 出卡，不承诺）、`assist-timeout-to-email`（要人工 → 没人接 → T+3 提醒 → T+10 转邮件 → 之后 AI 停口）。3 人 pack 15/15 → **17/17**，stub / direct / dsh-subprocess 三档全过；DSL 加 `chat.visitor_message` / `chat.human_takeover` 两个事件与 `chat_actions`（按**顺序**比）/ `chat_assist` 两条断言 |

**不在本 WP（托管档 B 期，不是"还没做"）**：网站聊天窗 widget 脚本、不要凭据的
公开访客端点、Origin 白名单、公网限流。一条不需要凭据就能写进工作区的路由，
放在本地单机档里没有任何人受益，却让每一台跑着 agentsws 的机器多一个对外写入口。
API 测试里有一条断言钉着这个边界。

**真跑 `agentsws demo` 才发现的两处**（都只在合成时钟下暴露，已修）：入站自编的
`external_id` 只带时刻，时钟不走时第二句会撞唯一键静默消失；`advanceTurn` 等 2 秒
静默窗口，时钟不走就永远判不完——沙盒页那条 `advance` 路由现在传 `force`，
**只**跳静默窗口，分类 / 涉钱 / 围栏 / 出卡一个不少。
**#2–#5 的验收（WP55，2026-09-14）**：3 人 pack 两条新场景 `amazon/buyer-message-guardrail`
（relay 来信 → 判成 `amazon` → 草稿带站外链接被硬闸拦下 → 打回重写 → 重写那一版过闸 → 人审）
与 `security/commitment-scan-blocks-autosend`（来信不沾黑名单词、草稿是 AI 写的，只有承诺扫描
说话 → 不自主 → 人点头之前一分钱不施行），17/17；15 人 pack 13/13 不劣化；两个 pack 各在
`stub` / `direct` / `dsh-subprocess` 三个运行时下跑过，四档跑出来的草稿正文逐字节相同、
门决策与规则集哈希也相同。

## 5. 红人岗位：从零建（L4；**09-15 按 Luoye 定的"按渠道划分职责"重写**）

### 5.1 职责按渠道，不按功能

Luoye 09-15 定：红人营销**按渠道划分职责**，五个渠道：YouTube / Facebook / Instagram / TikTok / X。v1 按功能拆的六条（`kol.discovery` / `outreach` / `campaign` / `content-review` / `affiliate` / `attribution`）**不再作为职责**，改为每条渠道职责内部的动作与面板分块。

| 职责 | 渠道 | 一条职责里的整条链 | 渠道特有的部分 |
|---|---|---|---|
| `kol.youtube` | YouTube | 找人（官方 Data API 搜索 + 公共库）→ 打分 → 建联（邮箱 / 频道"关于"页邮箱抓取）→ 合作与交付物 → 内容审核（视频 / 描述区链接）→ 归因（UTM / 联盟码） | 配额池（10k 单位 / 天）、Apify 降级、频道基准（k-匿名） |
| `kol.facebook` | Facebook | 同上（主页 / 群组博主） | Graph API 权限、主页私信建联 |
| `kol.instagram` | Instagram | 同上 | IG DM 建联、Reels / 帖子审核、Basic Display 限制 |
| `kol.tiktok` | TikTok | 同上（09-15 确认算一条） | Research API 申请制、TikTok Shop 联盟带货归因 |
| `kol.x` | X | 同上（09-15 新加） | API 付费档、帖子 / 长文审核 |

每条渠道职责的骨架相同：`scopes`（`creator` / `platform_account` / `creator_contact` / `collaboration` / `deliverable` / `tracked_link` 六个对象域，范围挂品牌内的店铺 / 产品线）、写动作（`stage_outreach` 开发信 L2 → L3 且禁承诺、`stage_collaboration` 建合作 L1、`stage_deliverable_review` 审核结论 L2、`stage_affiliate_code` 发联盟码 L2 上限、`stage_tracked_link` UTM L3）、额度（`max_outreach_per_day` 默认 30、`max_affiliate_discount_pct` 默认 20、`max_collab_budget` 默认 500 人审线）、面板（找人 / 建联 / 合作 / 审核 / 归因五个分块）。渠道之间零共享数据：同一个红人在两个渠道是两条 `platform_account`，`creator` 用"同一人合并"能力挂到一起。

岗位模板"红人营销"= 五条渠道职责，**默认只勾 YouTube 与 Instagram**（KOLAgents 的用户数据：这两条占 80% 用量），其余可勾。

> **WP67 实现落点（§5.1）**
>
> | 件 | 在哪 | 关键判断 |
> |---|---|---|
> | 五条职责 | `packages/roles/roles/kol/{youtube,facebook,instagram,tiktok,x}.yml` | 骨架逐字相同，不同的只有渠道连接器、grounding 意图词、文件头那段"这条渠道特有的部分"。连接器 **`required: false`**——写 true 的话，一个 TikTok Research API 还没申请下来的用户会被挡在这条职责之外，而他本来完全用得起来（导入 + 公共库） |
> | 岗位模板 | `packages/roles/positions/kol-marketing.yml` + `apps/server/src/org.ts` 的 `SEED_POSITIONS` | 默认只勾两条。勾上一条比去掉一条容易——去掉之前他得先弄明白那条是干什么的 |
> | 路由判据 | 五个 yml 的 `grounding` | 54 §2 的岗位路由靠**职责名 / 描述短语 / 意图词 / 动作 id / 数据域**判"这件事走哪条"，而五条渠道职责的动作 id 与数据域**一模一样**——意图词是唯一分得开它们的东西。测试里逐对验证"任意两条之间不互为子集" |
> | 契约 | `packages/contracts/src/kol.ts` | 六个对象 + `KOL_CHANNELS`；`ObjectType` / `DataDomain` 各加五个，五条新 ChangeKind |
> | guardrail | `packages/core/src/guardrail.ts` | `kol_collaboration` 进 `HARD_L1`（yml 可以被工作区策略放宽，硬顶不行）；**禁承诺是 block 不是转人审**——一封写着"我们付你 800 美元"的信不该存在"人点一下就发出去"的路径。词表 `KOL_OUTREACH_FORBIDDEN` 分钱 / 白送 / 保证三类，只可加行 |
> | 数据面 | `apps/server/src/kol.ts`（六张表，按品牌分目录）、`records.ts`（`creator` / `collaboration` 只读，**联系方式一格都不给**）、`catalog.ts` 五张"待增加"卡、`action-side-effects.yml` 五个渠道的读写动作 | 联系方式只存加密库 key 名——`saveContact` 的入参类型里就没有明文那一格 |
> | 面板与卡 | `packages/deck`（`kol` / `kol_channel` 两个数据源、五块积木、五张卡的芯片） | `kol` 进 `ALWAYS_CONNECTED`（我们自己的库，没有"去连接"这回事）；`kol_channel` 永远"还没连"，那句话里写明"不靠它也能用" |
> | 模拟 | `packs/dtc-3c-3p/scenarios/kol/*.yml`（三条）→ 30/30 | 禁承诺那条题钉的是 `simulation.kol_outreach_blocked` **真发生过**——出不来就说明起草那一跳自己扫一遍就绕过去了，而闸根本没被调用 |
>
> 截图 `docs/assets/workstation/kol-position.png`（红人营销岗位页：找人清单 + 建联漏斗 + 合作进行中 + 待审交付物 + 归因）。

### 5.2 本地（开源本体）：`@agentsws/kol-core` = 跨渠道共用的**能力**，不是职责

同 `support-core` 纪律。十个模块同 v1，但按"能力"归类而不是按职责：阶段机（合作与交付物）、打分、开发信起草与禁承诺、回复分类与陌生来信、日配额 / 序列 / 合规、同一人合并、campaign 向导（一个 campaign 跨渠道挑人，但每个渠道的动作仍走各自职责的额度）、UTM 与归因、Excel 导入、URL 解析（认五个渠道的链接）。新对象类型进契约与登记表：`creator` / `platform_account`（带 `channel`）/ `creator_contact` / `collaboration` / `deliverable` / `tracked_link`。渠道适配器 `packages/kol-core/src/channels/{youtube,facebook,instagram,tiktok,x}.ts`：各自的搜索、资料读取、基准、私信 / 邮箱建联口；凭据（平台 token）由用户在原生表单自己填进本机加密库，或按 49 M2 开关"用 agentsws 的"走云上配额池。

> **WP67 实现落点（§5.2）**：`packages/kol-core`，十个模块 + 五个渠道适配器接口 +
> 公共库客户端接口，94 个单测。纪律同 `support-core`：纯逻辑 + 注入 IO，
> 没有 `Date.now()`、没有 fetch、没有模型调用、碰不到一个凭据。
>
> | 模块 | 一句话 | 这个模块最要紧的那条判断 |
> |---|---|---|
> | `stages` | 合作与交付物阶段机 | **全仓唯一**一份合法迁移表；非法跳转抛人话（"还没建联就说交付完了"），不是 `invalid transition`——这句话最后会出现在卡面上。`closed` 是终态：再合作一次要新建一条，否则一条记录挂着两次合作的预算，归因永远算不清 |
> | `scoring` | 五项打分，每一项带一句带数的"为什么" | 刷粉护栏出 `blocked`，**与低分分得开**：60 分是"不太合适"，`blocked` 是"这个数不可信"。排序时刷粉的排在后面而不是剔掉——悄悄拿掉会让人以为我们没搜到他 |
> | `outreach` | 起草、禁承诺自查、序列、日配额 | 词表 `import` 的就是 core 里那一个数组；自查是为了早点给模型反馈，**不代替** guardrail 那道闸。挑今天发给谁时名单 / 重复 / 配额一起看——分三处调总有一处会漏（WP55 立的规矩） |
> | `replies` | 封闭六类 | 分不出来就是 `unknown`；"这次不做"与"以后都别找我"分成 `declined` 与 `opt_out` 两格，只有后者进抑制名单 |
> | `merge` | 同一人合并 | **只出建议卡，永远不自动合**；判断只看联系方式的**归一键**，明文一次都不进这个模块。`applyMerge` 把被合掉那条的 id 留在 `merged_from` 里，所以合错了拆得回来 |
> | `campaign` | 向导骨架 | 只出挑人清单，**不出动作**——每条渠道的动作仍走各自职责的额度（05 §4「不做跨 Assignment 并集」在红人这边最容易破的地方） |
> | `attribution` | UTM / 联盟码 / 订单归因 | 折扣码优先于 UTM（码是顾客主动输的，`landing_site` 会被跳转改掉）；两条都对不上就进 `unmatched`，**绝不按时间窗口猜**——归错比归不上糟 |
> | `import` | Excel / CSV | 三条渠道的官方 API 是申请制或付费的，没批下来之前用户手上那张表**就是**他的红人库。渠道以链接为准，去重只按 渠道 + handle |
> | `urls` | 五渠道链接解析 | 认不出来回 `undefined`，不猜一个渠道——猜错了这条记录会以另一个渠道的名义进库，而"渠道之间零共享数据"正是靠 `channel` 这一格成立的 |
> | `channels/*` | 适配器接口 | YouTube / Instagram 走注入的 transport（真 HTTP 在 `apps/server`），其余三条回 `not_implemented` + 一句人话——与"没连"分得开：那个用户修得好，这个他修不好。IG 没有"按关键词搜人"这个接口，就明说，不返回空当搜不到 |
> | `public-library` | 云端公共库客户端 | 接口按 WP61 的路由形状立好，默认实现回 `not_linked` + "没连也能用"。它不是占位符，它是本地档（免费）的**正确行为** |

### 5.3 云端（托管档增值：**公共红人库服务**，WP61）

把 KOLAgents 的 `public_*` 那一层**原样重建成 agentsws 云上的一个服务**（不是远程连旧 SaaS），挂在 49 M3 服务入口的 `/v1/data/*` 下、按 49 M4 积分计价（`data.kol.lookup` / `data.kol.audit` / `social.fetch` 已在价目表）：
- 插件采集汇聚（两组端点、配对流程、日配额预扣、贡献奖励风控）；插件改指向 agentsws 云，配对用 WP58 的工作区服务令牌（新 scope `data`）；
- 公共库读（免费体检报告、共享库浏览、付费 reveal 邮箱）、写（观察、联系方式回填、争议）；库按 `channel` 分区；
- k-匿名基准聚合、YouTube 配额池 + Apify 降级、邮箱抓取；TikTok / X 的采集只做插件汇聚（官方 API 申请制 / 付费）；
- 本地的五条渠道职责通过 49 M2 的开关连它，用 agentsws 账号（不是另一把 API key）；用我的 token = 本地直连平台、不经我们、不扣积分。

### 5.4 分期

| WP | 做什么 | 前置 |
|---|---|---|
| WP61 公共红人库服务 | 5.3 云端；`data` scope；插件配对；`/v1/data/*` 路由包挂进 `apps/cloud` | 58 / 59 已合并 ✅ |
| WP67 kol-core + 五条渠道职责骨架 | 5.1 五条职责 yml + 岗位模板、5.2 六个对象与能力模块、YouTube 与 Instagram 适配器先做、面板五分块、3 人 pack 场景 | 与 WP61 可并行 |
| WP68 其余三渠道适配器 + campaign 向导 | Facebook / TikTok / X 适配器、跨渠道 campaign、Excel 导入 | 67 |

## 6. 知识库与"关机也在线"（L5–L6，取代 v1 的同步 / 交接）

### L5 不做同步：一个工作区一个真源，付费就把服务进程搬到云上

| 档 | 谁跑服务进程 | 数据在哪 | 关机后 | 本地改知识 |
|---|---|---|---|---|
| 本地（免费） | 你的电脑 / NAS | 你的电脑 / NAS | 停（明说） | 直接改 |
| 托管控制面 | **我们的云** | 你的 NAS / 云库（41 §2.2） | 在线 | 桌面壳远程模式改同一个库 |
| 全托管 | 我们的云 | 我们的云（按租户独立库） | 在线 | 同上 |

- 切档 = 20 的 `export → import` 一次搬家（WP36 已做），然后桌面壳"连接公司服务器"（WP36 已做）。知识、账本、审批、范围全在一个库里，**没有第二份**，所以没有同步问题。
- 桌面端离线时的体验：只读缓存 + 草稿队列（后置，不在第一期）。

### L6 "24 小时在线"= 托管档的值守，不是两个节点交接

- 付费后你的工作区在云上 7×24 跑：邮箱轮询、聊天 widget、SLA、定时跟进都在云上；手机端 / IM 收卡；桌面开着时是同一个工作区的另一个窗口。
- 不存在"本地在线本地处理、离线 SaaS 接管"这种切换——同一时刻只有一个服务进程，永远是云上那个。
- 想"数据不出家门又要在线"的公司走托管控制面：服务进程在我们这，库在他们 NAS 上，要求 NAS 对我们的进程可达（41 §2.3 第一行）。

> **WP60 实现落点（值守）**：`packages/standby`（库 + 路由包，不起服务；风格同 WP59 的
> `packages/cloud-entry`），挂进 `apps/cloud`（`src/standby.ts`，照 `entry.ts` 的写法）。
>
> **一个值守工作区 = 一个 `apps/server` 子进程**——`dist/index.js` 与用户本地跑的是
> **同一份**。L6 那句"同一时刻只有一个服务进程"靠这一条成立：云上跑的要是另一套代码，
> 那"搬家"就不是搬家，是迁移到另一个产品。
>
> | 件 | 在哪 | 关键判断 |
> |---|---|---|
> | 进程池 | `src/orchestrator.ts` | 起（分回环端口 → 取租户密钥 → 签子进程令牌 → spawn）/ 健康（`/v1/health` 过了才 `running`）/ 崩溃退避（1s→5s→15s→1m→5m 封顶）/ 停。**没有 `setInterval`、没有 `Date.now()`**：`tick()` 由装配方按节奏调，于是"崩了 8 秒之后重拉"在测试里是一行 advance 而不是一次真的等待 |
> | 订阅 | `src/service.ts` | `standby.seat.month` × 座位数 → 钱包 `reserve → settle`（12 §4：钱包是结算层，订阅只是计价方式，账落 `org_id` / 52 O3）。余额不足**只拒这一次不冻结**（402 人话）；到期先试续期，钱不够才停成 `expired`——**数据不删，导出照常**（41 §2.3）；到期前 3 天一条 `standby.renewal_due`，一期只出一次 |
> | 租户密钥 | `src/keyring.ts` | 每租户一把（21 按租户加密），只经环境变量传一次，落在**租户自己的目录**里（0600）。**不进编排层的库、不进日志、不进事件、不进导出包** |
> | 子进程令牌 | `src/child-token.ts` | 值守自己签自己验，动作集**只有 `ai` + `wallet:read`**（没有 `standby`：被攻下来的租户进程最多花掉这个租户自己的积分）。与 WP58 的 `workspace_links` **分表**——那张表上有"一个工作区一条活着的关联"这条不变量 |
> | 公网入口 | `src/proxy.ts` | `/w/:workspace_id/*` 原样代理到子进程。**流原样穿过去，不读不记正文**（SSE 因此是真的流式，49 M6 在这条路上也成立）；末端用户走**子进程自己的** magic link 会话，云进程不发、不存、不看 |
> | 控制面 | `src/routes.ts` | 五条要 `standby` 动作集，且**只能管自己那个工作区**：列表 / 开通 / 状态 / 停 / `import`（上传 WP36 的包）/ `export`（反向搬家） |
>
> **先校验再解包**：`importWorkspace` 自己核 manifest + 每文件 sha256 + zip crc，
> 任意一处对不上就抛，租户目录一个字节不动。反过来的话，坏包会先铺进去半个目录，
> 那时这个租户的数据已经是"一半新一半旧"了。
>
> 传给子进程的基础环境是**白名单**（`PATH` / `HOME` / `TMPDIR` / `TZ` / `LANG` / `LC_ALL`）
> 而不是 `...process.env`：云进程环境里有 New API 与 Stripe 的密钥，整份继承等于
> 每个租户的进程里都有一份我们的钥匙。

## 7. 在 agentsws 里的呈现（L7）

- 46 首次设置：岗位列表加"客服"（三条）与"红人营销"（六条）；公司档案加"你卖的是"。**客服三条与"你卖的是"WP54 已落地**（截图见 `docs/assets/workstation/roles-support-*.png`）；红人六条等 C 期。
- 连接页"数据后端"三档下加一格 **"在线值守（agentsws 托管）"**：一句话说明关机后谁来接、点进去走切档；不再有"KefuAgents / KOLAgents 账号"卡。**WP60 已落地**（截图 `docs/assets/workstation/standby-wizard.png`）。

> **WP60 实现落点（L7 与 L3 #11 的云端一半）**
>
> **本地那一面**：`packages/api/src/routes/standby.ts` + `apps/server/src/standby.ts`。
> `GET /v1/standby`（状态 / 座位单价 / 嵌入脚本 / 桌面壳该指到哪儿——**一个数字都不自己算**，
> 与 49 M5 逐字同一条纪律；没关联账号不是错，回 `linked: false` + 一句人话且**一跳都不打**）、
> `POST /v1/standby/switch`（WP36 `export` → 上传 → 开通 → 云上起进程，一次走完）、
> `POST /v1/standby/bring-home`（**先落包、后停云**——顺序反了，中间任何一步出错都会留下
> "云上停了、本地没有包"的状态；落完包不自己 import，那是对着**没在跑**的数据目录做的运维动作）。
> 界面在 `components/connections/standby-wizard.tsx`，挂在"数据后端"第三档底下；
> 出口（接回本机）与入口在**同一格**里——41 §2.3 第一条是随时搬家，一个只能进不能出的入口，
> 说多少遍"不锁定"都没用。
>
> **聊天窗托管**（L3 #11 的云端一半）：`apps/server/src/chat-widget.ts` + `src/widget.ts` +
> `packages/api/src/routes/chat.ts` 的公开访客组。WP57 写的"公开访客端点不是还没做，是故意不做"
> 那条理由**一个字没变**——它变成了四道门：来源域名白名单（**空 = 全拒**，不是全放）、
> 限流（`ChatRateLimiter`，与 WP57 同一个模块；建会话按来源计、发消息按访客计）、
> 访客令牌（`HMAC(secret, session_id)`，**不落库**，验就是重算一次）、
> 凭据不进 URL（SSE 那条也走 `Authorization` 头，所以嵌入脚本用 `fetch` + `ReadableStream`
> 而不是浏览器内建那个流式 API——它塞不进头）。变的是前提：值守起来之后这个进程本来就在
> 公网后面（`/w/<ws>/*`），聊天窗是托管档卖的东西之一。
> 嵌入脚本 `https://<云>/w/<ws>/widget.js`：vanilla JS、无依赖、无构建、约 7 KB，样式全内联
> （它跑在别人的网站上，带进任何一个依赖就是在别人家里和别人的版本打架）。
> 访客那条 SSE **过滤掉 `session` 帧**——它带的是"人工接管翻了没有"，访客不该知道现在
> 回他的是 AI 还是人。截图 `docs/assets/workstation/chat-widget.png`。
>
> **桌面壳远程模式**：`apps/desktop/src/mode.ts` 的 `normalizeStandbyUrl` 让服务地址
> **唯一**允许带一段 `/w/<ws>` 路径（一个云节点后面挂着很多工作区，区分它们的正是这段前缀）；
> 源仍只有一个，所以 allowedOrigins / CSP 那三处改走 `originOfBaseUrl` 取源。
> 托盘与顶栏角标按 `isStandby` 分叉成"值守中：云上运行"——判据是**地址的形状**，
> 不是另存一个开关（存了就会出现"开关说在值守、地址指着本机"这种谁也解释不清的状态）。
> 角标组件 `components/standby-badge.tsx`，`app-shell.tsx` 只多一行。
- 连接页加"KOLAgents 插件"卡：配对指向 agentsws 云；未开托管档时提示"插件采集要托管档"。
- 岗位面板：客服三块流水各一条待审车道 + 逾期 + 投诉；红人六块新增。
- 卡片：两个 SaaS 的卡型全部映射到 deck 四段式。

## 8. 旧 SaaS 怎么退（L8，需要 Luoye 定时间表）

| 步 | 做什么 | 依赖 |
|---|---|---|
| 1 | 两个 SaaS **保持运行、停新功能**，只修安全与支付 | 现在 |
| 2 | 迁移工具：KefuAgents 知识包 / 线程 / 边界 / 委托 → agentsws 工作区（用它的 Gateway 读，我们的 `import` 写）；KOLAgents 红人 / 合作 / 交付物 / 追踪链接 → `kol` 对象；**公共库整库**搬到 agentsws 云的公共红人库服务 | A 期与 C 期落地后 |
| 3 | 托管档上线（值守 + 聊天 widget 托管 + 公共红人库服务 + 钱包） | B 期 |
| 4 | 通知用户、开放一键迁移、旧 SaaS 只读 → 关停 | Luoye 定日期 |

对既有文档：33 §1"共享包 + 四个连接点"与 11 §4"三个 SaaS 进市场"按本文改为"两个 SaaS 退役、能力进本体与托管档"；12 §4 的混合计费直接用于托管档。

## 9. 分期（L8 的工程侧）

| 期 | 做什么 | 派工 |
|---|---|---|
| A 客服补齐 | L1 三条职责与岗位模板；L2 垂直包 + stage；L3 #1–#9、#11 的本地部分 | WP54–WP56（三个并行） |
| B 托管档 | 值守（工作区服务进程云上跑 + 切档向导）、聊天 widget 托管、公网回调、钱包；桌面壳远程模式打磨 | WP57–WP58 |
| C 红人岗位 | L4 `kol-core` + 职责包 + 面板；公共红人库服务（云）；插件改指向 | WP59–WP60 |
| D 迁移与退役 | 两个迁移工具 + 公共库搬迁；旧 SaaS 只读 | WP61 |
| E 收尾 | 影子质检回流、视觉附件、IM 卡片、离线只读缓存 | 后置 |

每期跟一条 15 人 pack 场景 + 真账号验收。

## 10. 请拍板

- L1 客服三条职责：网站客服（合并售前 / 售后）、网站在线客服、Amazon 客服；两条候选（社媒私信客服、客服质检）先登记不做
- L2 实物 / 虚拟是档案字段，售前 / 售后是知识 stage（Luoye 已同意）
- L3 客服十一项搬进本体，先安全边界后功能（Luoye 已同意 v1 的十项，新增第 11 项在线聊天流水线本地部分）
- L4 红人本地 `kol-core`；公共红人库**重建为 agentsws 云服务**而不是远程连旧 SaaS
- L5 不做同步：付费 = 工作区搬到云上跑，桌面壳远程模式改同一个库
- L6 在线值守 = 托管档，同一时刻只有一个服务进程
- L7 首次设置两个岗位模板 + "你卖的是"；连接页"在线值守"入口与"插件"卡
- L8 旧 SaaS 停新功能、迁移工具、托管档上线、关停日期由 Luoye 定；33 §1 与 11 §4 按本文修订
