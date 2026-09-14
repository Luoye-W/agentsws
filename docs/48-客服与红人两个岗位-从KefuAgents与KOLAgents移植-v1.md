# 48 · 客服与红人两个岗位：从 KefuAgents / KOLAgents 移植 v1（方案稿）

| | |
|---|---|
| 状态 | 方案稿，等 Luoye 拍板 K1–K8；**过了再动代码** |
| 起因 | 2026-09-14 Luoye：全面梳理两个 SaaS 的功能，移植进 agentsws 成两个岗位（客服、红人营销），按 agentsws 的规范适配改造（如客服要能选网站售前 / 网站售后 / Amazon 售前 / Amazon 售后）；知识库要能在本地改、和 SaaS 保持一致——用户电脑关了还要靠我们的 SaaS 实时答客户 |
| 输入 | 两份只读调研（KefuAgent 主仓 + Shopify 应用 + Flutter；KOLAgents 主仓，插件仓在未挂载的外置盘）、33（融合：共享包 + 四个连接点）、11 §4（三个 SaaS 进市场 = 付费包依赖免费基础包）、04 / 27（职责与岗位模板）、19（知识对象）、41 §2（数据三档）、46（首次设置） |

## 0. 一句话

**客服岗位已经搬了一半**（`@agentsws/support-core` 是从 KefuAgent 抽出来的共享包），剩下的是把 KefuAgent 两年打磨出来的"安全边界"补齐；**红人岗位一行没搬**，能本地做的抽成新共享包 `kol-core`，只能云端做的（公共红人库、插件汇聚）以远程 Backend 连；**知识库本地为真源、SaaS 为镜像**，用同一份格式双向同步；**24 小时在线答客户**这件事由 KefuAgents SaaS 承担，本地与 SaaS 之间做"值守交接"而不是同时处理。

## 1. 两个 SaaS 各自有什么（调研浓缩）

### 1.1 KefuAgents（客服）

| 能力块 | 现状 | 在 agentsws 里 |
|---|---|---|
| 邮箱 IMAP / SMTP 收发、去重、线程归并 | 完整；每文件夹 UID 游标、毒消息隔离、扫描租约、`KefuAgents` 归档文件夹 | `packages/channels` 已有基础版；缺归档文件夹、游标持久化、租约 |
| Amazon 买家消息 | 寄生在客服邮箱上，正则识别 22 个 marketplace 域，认证失败降级人工；出站硬闸（外链 / 联系方式 / 营销语）；24h SLA 三档提醒 | **没有** |
| 网站在线聊天 widget | 公开端点 + Origin 白名单 + 限流 + SSE + 聊天求助超时转邮件 | **没有，且天然要云端**（脚本分发、公网端点） |
| 处理流水线 | 分流（模型 + 关键词兜底）→ 风险 / 缺料 → 抽订单号 → 查 Shopify 订单 → 检索知识 → 取已答边界 → 起草（围栏、数字只来自事实）→ 视觉附件 → 出站守卫 → 十道自主发送门 → 人审 → outbox 投递 → 对账 → 归档 | 分类 / 边界 / 起草 / 升级 / SLA 在 `support-core`；订单事实经连接器（WP53 在接）；十道门、outbox 对账、视觉附件**没有** |
| "垂直包"（实物 / 虚拟） | 两个包各 13 组差异（人设、26 + 28 条规则、意图表、L3 黑名单、边界 registry…），逐字节冻结有 parity guard | `support-core` 只装了实物那一套的一部分 |
| 售前 / 售后 | **不是模式，是每条知识的适用范围**（`stage_scope`），一个库同时服务两边 | 我们的职责层已分 `dtc.presales` / `dtc.aftersales`，知识层没有 stage 字段 |
| 知识库 | 存文章 + 候选 + 媒体 + 缺口 + 业务边界 + 复核；六条建法（官网爬取、历史邮件学、影子质检回流、知识包导入、缺口补、边界问答卡）；**长上下文优先无向量库**三档检索；溯源四件套 + 事实指纹 + 源页变更复核 + stale 降权；承诺类永不自动发布 | 19 的 FactCard 有出处 / 有效期 / 三层权限 / 缺口 / 冲突；**缺**事实指纹、源页复核、stage、长上下文档；有 markdown 往返导出 |
| 自主发送门 | G01–G10 固定顺序、fail-closed、只记录不发送、规则集哈希只可加行 | 14 的审批 + 15 的 guardrail + halt 覆盖 G01 / G05 / G07 / G09 的一半；G04（L3 黑名单）、G06（草稿来源）、G10（承诺扫描）**没有** |
| 影子质检 + 回流 | 对比 AI 草稿与人工真实回复出四项分数，不可采纳的萃取成知识候选 | 24 学习回路有"采纳率"，**没有**影子质检 |
| 卡片流 / 移动端 / IM 卡片 | 11 种卡型五动作；Flutter 四端；飞书 / 钉钉 / 企微卡片回调 | deck 四段式一次一张已对齐；IM 投递在后置清单 |
| Agent Gateway | REST + MCP 14 工具 + 签名 webhook，API key 绑死工作区 | 我们的 `/v1` + SDK；**互通接口要用它** |
| 计费 | 积分，1 = $0.01，成本 ×3 倍率，套餐 + 充值 | 不搬（33 §1.3：两边各自收费） |

### 1.2 KOLAgents（红人营销）

| 能力块 | 现状 | 能不能本地做 |
|---|---|---|
| 品牌 / 产品初始化（官网 → 卖点 / 关键词 / 竞品） | 完整 | 能 |
| 找红人四扇门（共享库筛选 / 关键词 / 竞品反查 / 找相似） | YouTube 官方 API（全站日配额）+ Apify 降级 + 共享库 | 关键词 / 竞品反查 / 找相似的**算法**能本地；**数据供给**（共享库、配额池、Apify）只能云端 |
| 浏览器插件采集（YouTube / TikTok / IG） | 只读用户正在看的页面、用户主动触发；两组端点（租户侧 / 公共库侧）；配对流程；日配额预扣 | 插件不动；本地只登记"连接"；采集结果可以落本地池 |
| 红人库 | 双层：共享事实（账号、内容、指标）+ 私有归属（阶段、优先级、标签、过审）；跨平台同一人只有共享邮箱自动合并；已拒绝持久化 | **私有层**本地做；**公共层**只能连 |
| 打分 | 启发式 + LLM 混合（0.4 / 0.6），确定性刷粉护栏，理由中文 | 能（纯函数） |
| 建联 | 每封现生成、三种语气、禁承诺正则兜底；人审才发；日配额 + 抖动；多轮序列；CAN-SPAM 页脚；退订 / 退信抑制；黑名单 | 能 |
| 回复识别、陌生来信 | 封闭 6 类；陌生来信双条件自动转化；`KOLAgents` 归档文件夹 | 能 |
| 合作管理 | campaign 向导（七张卡、预算档位、倒推时间线、brief）；合作条款；交付物十态；UTM 链接；GA4 / Shopify 归因；k-匿名基准 | 向导 / 条款 / 交付物 / UTM / 归因能本地；**基准**只能云端 |
| 监控 | 竞品 / 关键词 / 战略红人，每小时 | 算法能本地，数据供给同上 |
| MCP | 18 工具 + 3 资源 + 2 prompt，付费墙 | **互通接口要用它**；"纯公共库只读 API"目前不存在 |

### 1.3 四条硬边界（两份调研共同的结论）

1. **天然只能在云端的**：24 小时在线应答、公网 webhook 与 OAuth 回调、聊天 widget 脚本分发、公共红人库与插件汇聚、k-匿名基准、YouTube 配额池、跨账号风控。
2. **能本地做但要常驻进程的**：IMAP 轮询、SLA 扫描、定时跟进——桌面壳在就行，关机就停（这正是"值守交接"要解决的）。
3. **安全边界是多层硬编码的**：AI 不许承诺钱和样品这一件事，两个 SaaS 各有四道独立防线。移植时不能把它们变成"可配置项"。
4. **合规姿态是 schema 的一部分**：来源 URL、同意范围、采集模式都是一等字段。

## 2. 岗位怎么定（K1–K2）

### K1 "客服"= 一个岗位模板，勾它默认带四条职责，可去勾

| 职责 | 已有 / 新建 | 连接器 | 说明 |
|---|---|---|---|
| 网站售前 `dtc.presales` | 已有（04 §1.1） | 客服邮箱、Shopify 商品 / 库存只读 | 折扣码 stage、高意向线索 |
| 网站售后 `dtc.aftersales` | 已有（04 §1.2） | 客服邮箱、Shopify 订单 / 物流 | 退款 / 补发 / 改地址 stage |
| Amazon 售前 `amz.presales` | **新建**（04 §2 只有 `amz.buyer-messages` 一条） | 同一个客服邮箱（寄生渠道） | 站内信里的售前问答；出站硬闸（无外链 / 无联系方式 / 无营销语） |
| Amazon 售后 `amz.aftersales` | **新建**（从 `amz.buyer-messages` 拆出） | 同上 | 24h SLA 三档；退款走 SP-API 时再接 |

- 04 §2 那条"Amazon 与独立站客服不合并"的规矩不变：四条职责额度、模板、动作各自独立，**共用的只有 `customer-care` 说话纪律**。
- 首次设置向导（46 §1 ③）里"客服"岗位默认四条全勾；只做独立站的人去掉两条 Amazon 就行。一个人勾多条 = 一个岗位多职责，范围（44）照旧。

### K2 KefuAgent 的"垂直包"变成工作区档案的一个字段，不是岗位

- 46 的公司档案加一格 **"你卖的是"：实物商品 / 虚拟产品与服务**（默认实物），存 `Workspace.profile.vertical`。
- `support-core` 把人设、规则、意图表、L3 黑名单、边界 registry 按垂直包参数化（`getVerticalPack(vertical)`），**代码里禁止 `if (vertical === 'digital')`**（沿用 KefuAgent 的纪律和 parity guard）。
- 售前 / 售后不做成模式：知识条目加 `stage: 'both' | 'presales' | 'postsales'`（19 的 FactCard 加一个可选字段），检索时按当前职责过滤；邮件渠道不过滤（混合渠道）。

## 3. 客服岗位：还要搬什么（K3）

按"先搬安全边界、再搬功能"的顺序，全部抽进 `@agentsws/support-core`（纯函数、无 IO）与 `packages/channels`：

| # | 搬什么 | 抽自 KefuAgent | 落到 agentsws 哪 |
|---|---|---|---|
| 1 | 垂直包（两套人设 / 规则 / 意图 / L3 黑名单 / 边界 registry） | `src/lib/support/verticals/**` | `support-core/verticals/*`，parity guard 测试照搬 |
| 2 | Amazon 渠道：识别（22 域 + 认证降级）、出站硬闸、SLA 三档 | `amazon-channel.ts` / `amazon-guardrail.ts` / `amazon-sla.ts` | 识别与硬闸进 `support-core`；SLA 进 `packages/schedule` 的 handler |
| 3 | 自主发送门 G04 / G06 / G10（L3 黑名单九类六语、草稿来源、承诺扫描） | `policy/autonomy-gate*.ts`、`l3-denylist.ts` | 映射进 15 的 guardrail 前置检查：`l3_denylist` / `draft_origin` / `commitment_scan` 三条 `PrecheckResult`；fail-closed；规则集哈希只可加行 |
| 4 | 投递 outbox 状态机 + 对账（`sent_unknown` 绝不自动重试，回 IMAP 搜 Message-ID 找证据） | `delivery-outbox.ts`、`reconcile-deliveries` | `packages/channels` 出站；对账进 housekeeping |
| 5 | 邮箱通道加固：每文件夹 UID 游标持久化、毒消息隔离、扫描租约、`agentsws` 归档文件夹 | `support_inbox_connection` 三组列 | `packages/channels` 存储；租约为多进程（本地 + SaaS 值守）准备 |
| 6 | 知识溯源链：事实指纹、源页变更复核、`stale` 降权、承诺类永不自动发布 | `knowledge/{provenance,fact-fingerprint,recheck}.ts` | 19 的 FactCard 加 `fact_fingerprint` / `verification_state`；健康看板加复核卡 |
| 7 | 知识检索的"长上下文档"：全库 ≤ 预算就整库注入，不检索 | `selectRelevantKnowledge` 三档 | `packages/knowledge/retrieval.ts` 加 `context` 档；`lexical` 档用我们已有的过滤下推检索 |
| 8 | 影子质检 + 回流 | `shadow-eval.ts` / `shadow-learning.ts` | 24 学习回路加"影子质检"一步：人工改稿后对比，出四项分数，不可采纳的进知识候选 |
| 9 | 六条知识建法里本地能做的：知识包导入、历史邮件学、缺口补、边界问答卡 | `knowledge-pack*.ts` / `learnKnowledgeFromHistory` / `knowledge-supplement.ts` | 知识包格式 = 我们的 markdown 导出（§5）；历史邮件学接 `packages/channels` 的原始材料区 |
| 10 | 视觉附件（读图不编） | `vision-attachments.ts` | 模型网关加视觉能力位；后置 |

**不搬**：官网爬取（Jina 等外部抓取，本地网络不稳，留给 SaaS）、在线聊天 widget（云端组件，§6）、IM 卡片回调（本来就在后置清单）、计费。

## 4. 红人岗位：从零搭（K4）

### K4 新共享包 `@agentsws/kol-core` + 职责包 `role-packs/kol-marketing`

和 `support-core` 同一套纪律：纯函数、无 IO、无模型调用、时间与随机注入、每个文件头注写抽自哪。

| # | 模块 | 抽自 KOLAgents | 说明 |
|---|---|---|---|
| 1 | 阶段机（红人十态、交付物十态、只进不退） | `stages.ts`、`pipeline-progress.ts` | 进契约 `CreatorStage` / `DeliverableStage` |
| 2 | 打分（启发式 + LLM 混合、刷粉护栏、四种合作建议） | `creator-scoring.ts` | 模型调用由运行时做，纯函数只管启发式与混合 |
| 3 | 开发信起草（三种语气、禁承诺 + 正则兜底、< 160 词） | `outreach/personalization.ts` | 提示词组件进 `prompts/`；`stripForbiddenCommitments` 进 guardrail 前置 |
| 4 | 回复分类（封闭 6 类）、陌生来信（双条件自动转化、经纪永不自动） | `reply-classifier.ts`、`inbound-lead-*.ts` | 同上 |
| 5 | 日配额 + 抖动、多轮序列、CAN-SPAM 页脚、退订头、抑制名单 | `outreach/{daily-cap,compliance,email-headers,suppression}.ts` | 发信仍走 `packages/channels`，人审才发（14） |
| 6 | 跨平台同一人合并规则（共享邮箱自动、其余提案）、已拒绝持久化 | `identity-attach.ts`、`im_discovery_dismissal` | 复用 40 §2 / 45 的查重与提案卡 |
| 7 | campaign 向导（七张卡、预算档位、倒推时间线、brief） | `campaign-{wizard,plan,draft}.ts` | 卡走 deck 四段式 |
| 8 | UTM 链接、GA4 / Shopify 归因 | `tracked-links.ts`、`attribution-sync.ts` | 连接器：GA4 已在目录，Shopify 已通 |
| 9 | Excel / CSV 历史导入（确定性表头 + LLM 补残余、只填空不覆盖） | `legacy-import.ts` | 免费 |
| 10 | 平台 URL / handle 解析 | `normalizers.ts` | 纯函数 |

**新对象类型**（进契约 + 登记表，47 J1）：`creator` / `platform_account` / `creator_contact` / `collaboration` / `deliverable` / `tracked_link`（`campaign` 已有）。本地只有"私有归属"一层；"共享事实"经远程 Backend 读。

**职责**（04 §4 六条不变）：`kol.discovery`（本地算法 + 远程数据）、`kol.outreach`、`kol.campaign`、`kol.content-review`、`kol.affiliate`、`kol.attribution`。岗位模板"红人营销"默认勾六条。

**只能连、不能搬**（11 §4 的 `kolagents/pro` 付费包，08 §7.2 的远程 Backend 形态）：公共红人库读写、插件采集汇聚、k-匿名基准、YouTube / Apify 数据供给、邮箱抓取。认证用 KOLAgents 的 API key（用户自己在 SaaS 后台签发，填进连接页原生表单）。**SaaS 侧要新写一个"纯公共库只读 API"**（调研确认现在的 `/discovery/library` 仍要求 org 上下文）。

**插件**：不动。agentsws 只做两件事：连接页登记"KOLAgents 插件已配对"（读 SaaS 的配对状态），采集结果通过远程 Backend 拉回本地私有池。

## 5. 知识库：本地为真源、SaaS 为镜像（K5）

这是 Luoye 最关心的一条。原则一句话：**一份知识、一种格式、两处副本、一个真源。**

### 5.1 同一种格式

- 19 §5 已定"整库可导出 markdown 文件夹（零锁定）"，`packages/knowledge/markdown.ts` 往返保 id 与出处。
- KefuAgent 的 `kefu-knowledge-pack/v1`（`pack.yaml` + 9 个 md + front matter）与它**互相可转**：写一个转换器（两边各一份，都在共享包里），字段对照：

| KefuAgent 条目 | agentsws FactCard | 备注 |
|---|---|---|
| `title` / `body_md` | `text`（标题进第一行） | |
| `stage_scope` + overrides | `stage`（K2 新加） | override 拆成两张卡 |
| `audience: internal` | `visibility` 内部层 | 永不进对客 prompt |
| `source_url` / `last_verified_at` / `derived_from_content_hash` | `source` / `valid.verified_at` / `fact_fingerprint`（K3 #6 新加） | |
| `verification_state: stale / quarantined` | `health` + `status: retired` | |
| 承诺类文件（pricing / policies / boundaries） | 进候选，走 `knowledge_update` 审批 | 按文件名判，不按 front matter |

### 5.2 同步机制

```
本地 agentsws（真源）                      KefuAgents SaaS（镜像）
  知识卡通过审批 ──推（增量，带 id + 出处）──▶ Gateway import_knowledge_pack / propose_knowledge
                                              ↓ SaaS 侧按它自己的规矩：承诺类进候选、其余直接可用
  ◀──拉（变更流 since=游标）──────────── SaaS 侧学到的：影子质检回流候选、商家在 SaaS 里批过的候选
  拉回来的一律是 knowledge_update 提议 → 本地审批 → 通过才成事实
  冲突（同 id 两边都改）→ 19 §4：双值并存出 resolve_conflict 卡
  每日对账：两边各出一份 (id, hash) 清单，缺的补、多的问
```

- **触发**：本地审批通过即推（在线时）；离线时进出站队列，上线后先拉后推；每天一次对账。
- **权限**：推送用 KefuAgents API key（用户自己签发，绑死一个 SaaS 工作区），只走 `knowledge/*` 三个接口；本地从不拿 SaaS 的邮箱密码，SaaS 从不拿本地的。
- **SaaS 侧要新增**：`GET /api/gateway/v1/knowledge/changes?since=` 变更流（现在只有 search / proposals / import）。
- **用户体验**：在本地知识页改一条 → 通过 → 十几秒后 SaaS 那边就在用；不用再去 KefuAgents 后台补知识。反过来 SaaS 学到的东西会以"提议"出现在本地待办里。

## 6. 24 小时在线：值守交接，不是双跑（K6）

用户关机 → 本地的 IMAP 轮询、SLA、运行时全停。用户选"用我们的 SaaS 保证在线"= 装 `kefuagents/pro` 并开"值守"：

| 状态 | 谁处理来信 | 怎么切 |
|---|---|---|
| 本地在线 | **本地**处理；SaaS 只做知识镜像，不碰邮箱 | 本地每 60 秒向 SaaS 发心跳 |
| 本地离线 > N 分钟（默认 5） | **SaaS 接管**：同一个邮箱，用同一套共享包处理，卡片推到手机（Flutter）/ IM | SaaS 心跳超时即接管；接管期间处理过的信移进 `KefuAgents` 文件夹（它本来就这么做） |
| 本地回来 | 本地先**拉回**接管期间的线程、草稿、决策进本地事项时间线（21 事件带源工作区），再重新接管 | 拉完发"我回来了"；SaaS 停轮询 |

- **不允许双跑**：同一邮箱同一时刻只有一方轮询（用 IMAP 文件夹 + 心跳做协调，不需要额外服务）。
- **值守期间的审批**：卡片在 SaaS 侧出、在手机上批；本地回来后这些决策进本地账本，不重复出卡。
- 网站在线聊天 widget 永远由 SaaS 提供（云端组件），本地只看会话与卡片。
- 这条和 41 §2.3 的"托管控制面"不冲突：那是"服务进程放我们这跑"，这是"某个岗位在你离线时由 SaaS 顶班"。两条都可选。

## 7. 在 agentsws 里的呈现（K7）

- 46 首次设置：岗位列表加"客服"（四条职责）与"红人营销"（六条职责）；公司档案加"你卖的是"（K2）。
- 连接页：客服邮箱已有；加"KefuAgents 账号（API key）"与"KOLAgents 账号（API key）"两张卡（原生表单，凭据进本机加密库），各自显示"值守：开 / 关"与"知识镜像：上次同步时间"。
- 岗位面板：客服四块（待审回复、待批退款 / 补发、逾期订单、投诉升级）已在 27；红人六块（红人池、待发建联、待批回复、进行中合作、交付物到期、归因）新增。
- 卡片：两个 SaaS 的卡型全部映射到 deck 四段式（`reply_approval` → 回信草稿卡、`knowledge_confirm` → knowledge_update、`policy_question` → policy_change 问句形态、`delegation_proposal` → 自动化升级卡……）。

## 8. 不做什么

- 不把 SaaS 改成中台前端；不停 SaaS 的 IMAP（33 §1.3）；不合并计费；不要求 SaaS 用户装中台。
- 不搬公共红人库、不搬插件、不搬 k-匿名基准、不搬 YouTube 配额池（只能连）。
- 不把"AI 不许承诺钱和样品"做成开关。
- 不搬官网爬取与在线聊天 widget 到本地。

## 9. 分期（K8）

| 期 | 做什么 | 派工 |
|---|---|---|
| A 客服补齐 | K2 垂直包参数化 + stage；K3 #2 Amazon 渠道、#3 三道门、#4 outbox 对账、#5 邮箱加固、#6 溯源链、#7 长上下文档；K1 的两条 Amazon 职责 + 岗位模板 | WP54–WP56（三个并行） |
| B 知识同步 + 值守 | K5 转换器 + 推 / 拉 / 对账；K6 心跳与接管；连接页两张卡；**SaaS 侧**：变更流接口、心跳接口、依赖共享包 | WP57（agentsws 侧）+ KefuAgent 仓一个 WP |
| C 红人岗位 | K4 `kol-core` + 职责包 + 六条职责 + 面板 + 远程 Backend 连接；**SaaS 侧**：纯公共库只读 API | WP58–WP59 + KOLAgents 仓一个 WP |
| D 收尾 | 影子质检回流、视觉附件、IM 卡片 | 后置清单 |

每期都跟一条 15 人 pack 场景 + 真账号验收。

## 10. 请拍板

- K1 "客服"岗位 = 网站售前 / 网站售后 / Amazon 售前 / Amazon 售后四条职责，默认全勾可去勾；Amazon 两条从 `amz.buyer-messages` 拆出
- K2 实物 / 虚拟是工作区档案字段（垂直包参数化），售前 / 售后是知识条目的适用范围不是模式
- K3 客服按表搬十项，先安全边界后功能；不搬爬取、聊天 widget、计费
- K4 红人新建 `kol-core` + 职责包，本地只有私有层；公共库、插件、基准以远程 Backend 连；SaaS 侧新写纯公共库只读 API
- K5 知识本地为真源、SaaS 为镜像：同一格式互转、审批通过即推、变更流拉回成提议、每日对账；SaaS 侧新写变更流接口
- K6 24 小时在线 = 值守交接：本地在线本地处理，离线 5 分钟 SaaS 接管，回来先拉后接管；同一邮箱不双跑
- K7 首次设置加两个岗位模板与"你卖的是"；连接页加两张 SaaS 账号卡
- K8 分四期，A / B / C 各派工，SaaS 侧各一个配套 WP
