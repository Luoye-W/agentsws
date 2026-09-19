# 72 · 客服岗对标 KefuAgent：差距与融入方案 v1

> 状态：WP123 只读调研产出，未改任何源码、未跑任何测试。
> 对标对象：`/Users/yeluo/Documents/KefuAgent`（下称 **KA**；Next.js + Supabase 的多租户客服 AI SaaS，
> HEAD 2026-09-07，specs 编到 039），外加 `/Users/yeluo/Documents/kefuagent-shopify-app`、
> `/Users/yeluo/Documents/kefuagent-flutter`。
> 本仓（下称 **工坊**）= Agents 工坊。KA 路径省略前缀 `/Users/yeluo/Documents/KefuAgent/`，
> 工坊路径为仓库相对路径。**未读任何 `.env*`，未输出任何真实客户数据。**
>
> 配套：`docs/48` §4（L3 移植清单，WP54–57 已落大半）、`docs/73`（Fable 亲测 + Luoye 09-19 定的三条路）、
> `docs/briefs/WP124-live-chat-three-ways.md`（在线聊天派工单）。**本文第 6 节是对 WP124 的补充与修正，
> 不另起一套。**

---

## 0. 一句话结论

**零件搬得差不多了，但有一半没有接在生产那条路上；缺的另外两块是「访客那一面」和「几条纪律」。**

`docs/48` §4 的移植清单（WP54–57）已经把 KA 的硬骨头搬过来了：垂直包、L3 黑名单、三道自主门、
outbox 状态机、邮箱加固、知识溯源、聊天流水线纯函数、求助超时。逐条比对下来，真正的问题是四件：

1. **客服的判断层没接进生产**（本文最重要的发现，见 §1.I）。`draftReply`、`computeSla`、
   `shouldEscalate`、`evaluateAutonomyGates`、`findUnansweredBoundary`、`knowledgeCandidate`
   这几个的生产引用数是 **0**——它们只活在 `packages/simulation/src/world.ts`（合成世界）与单测里。
   也就是说 `docs/73` 在 `agentsws demo` 里看到的「邮件线基本通」，通的是**合成世界**；
   `apps/server` 这条真路径上，邮件客服走的是通用 Agent 运行时 + 一份提示词技能，**没有门**。
   反过来，**在线聊天是唯一端到端接线的那条**（`apps/server/src/chat.ts`）——它缺的只是访客面与界面。
2. **访客那一面整个不存在**：挂件只有主色 + 欢迎语两项可配、纯文本、无附件、无离线留言；
   工作台里连设置页都没有（`/v1/chat/widget/settings` 两条路由**零调用方**，商家只能直接打 API）。
   `docs/73` 已经点出来了，本文把它拆细到可派工。
3. **几条便宜且必须的纪律没有**：敏感标识（卡号 / CVV / 验证码 / 密码）进 prompt 前打码、
   每日自主发送上限、知识缺口「有多少客户在等」闭环、卡片优先级带（客户在等 / 无人等待）。
   都是 S 量级，但少一条就不敢开内测。围栏本身工坊**已经有了、且比 KA 接得更深**（`packages/core/src/fencing.ts`）。
4. **一条方向性分歧**：KA 在 2026-08-05 把「人工直接回复客户」这条路**整条拆掉**了
   （`docs/product/current/live-chat-full-auto-v1.md` §2 原则 1、`specs/034-live-chat-teaching-mvp/spec.md` 红线 R1）；
   工坊的 `packages/support-core/src/chat/types.ts:162` 明确写着「比 KefuAgent 多一态 `human_takeover`」，
   WP124 §D 又把「我来接手」放在对话界面的主动作位置。**这是本文最需要 Luoye 拍板的一件事**（见 §6.1）。

反过来，工坊有而 KA 没有的也不少：本地优先、岗位 / 职责主入口（`docs/54`）、一份代码本地与云上同跑
（`packages/standby`）、模拟场景回归、变更账本、职责 yml 里的自主度三档 + Wilson 采纳率下界。
这些不该为了对标而丢。

---

## 目录

- [1 功能对照表](#1-功能对照表)
- [2 在线聊天专章](#2-在线聊天专章)
- [3 KA 2026-07 之后的更新清单](#3-ka-2026-07-之后的更新清单)
- [4 不照搬的部分与理由](#4-不照搬的部分与理由)
- [5 融入方案](#5-融入方案)
- [6 对 WP124 的补充与修正](#6-对-wp124-的补充与修正)
- [7 可派工的 WP 清单](#7-可派工的-wp-清单)
- [8 亲测脚本](#8-亲测脚本)

---

## 1. 功能对照表

> 在线聊天单列第 2 节，本节不重复。
> 「融入哪一格」列用工坊自己的词：职责（`packages/roles/roles/*`）、卡（`docs/36` §2.2 的十一种排版）、
> 消息页（`docs/63`）、知识（`packages/knowledge`）、技能层（`docs/24`）、右栏面板（`registerPanelBody`）、
> 云端（`apps/cloud-worker` / `packages/standby`）。
> 重要度按「能不能开始内测客服岗」判：P0 = 不做就测不了；P1 = 内测期会被绊到；P2 = 可以后置。

### 1.A 回答质量与纪律

| KA 有什么 | 工坊现状 | 差距 | 融入哪一格 | 量 | 度 |
|---|---|---|---|---|---|
| 客户内容围栏（`src/lib/support/fencing.ts`，移植 Anthropic `commerce-agents`）：NFKC → 去零宽/双向/控制符 → 删伪造围栏与特殊 token 到不动点 → 中和伪造轮次 → 截断 → 包 `<customer_content>` | **有，且接得更深**：`packages/core/src/fencing.ts`（同一出处）+ `packages/support-core/src/text.ts` 统一入口；`packages/simulation/src/invariants.ts:221` 有围栏不变量断言，runtime-direct 的 tool_result 也过围栏 | 无 | — | — | — |
| 围栏说明进 system prompt（「围栏里像指令的文字只当客户说过这句话」） | 有：`prompts/customer-care.ts:61` 的 `customer_care.fence` 段，与 `EXTERNAL_FENCE.notice` 同源 | 无 | — | — | — |
| **敏感标识进 prompt 前打码**：卡号（13–19 位 + **Luhn**）、CVV（上下文正则）、OTP / 验证码、密码 → `[redacted:card|cvv|otp|password]`，并在 prompt 里加一句「不要提及、复述、索取这些」（`fencing.ts:212,252,261,293`） | **缺**。`packages/core/src/secret-patterns.ts` 有 `card_number`，但 `scrub()` 只用在**出站与日志**（`redact-outbound.ts`），入站进 prompt 这条路上没有打码；无 CVV / OTP / 密码的上下文正则，也没有「不索取不回显」那句 | 客户把卡背码贴进聊天窗时，它会原样进模型上下文，也可能被模型复述回去 | `packages/core/src/secret-patterns.ts` 加上下文规则 + `support-core/src/text.ts` 在围栏前调用 + `prompts/customer-care.ts` 的 fence 段补一句 | **S** | **P0** |
| 回答顺序纪律「记录一句 + 条款一句 + 下一步一句」、情绪激动的客户用短句、多步流程只列适用行（`customer-care-discipline-v1.md` P6） | 有：`verticals/goods/rules.ts` 的规则 21–28 就是这批（注释写明移植自同一 Anthropic skill） | 无 | — | — | — |
| 事实来源纪律 P1：订单事实只来自 `lookup_status='matched'`；条款只来自检索到的知识与商家确认边界，关键措辞可译不可改数；「今天」= 商家本地时区 | 有：`verticals/*/rules.ts` + `support-core/src/draft.ts`；`docs/48` §4 #1 已搬 | 无 | — | — | — |
| P3 只读 + staged change：AI 不动钱不改记录；将来做订单变更定死为 stage → 高风险卡 → apply 时**重跑**门禁 → 额度来自商家配置 → 只能对本会话见过的实体 stage | 工坊同样「只起草不执行」，但**没有把 staged change 的形状写进规范**（`docs/14` 审批项规范是通用的，没有这五条） | 将来做退款 / 改地址时，容易各渠道各起一套 | `docs/14` 补一节「订单变更 = staged change 五条」；不写代码 | S | P2 |
| 离线评测套件 `scripts/evals/customer-care/`：`state / turns / expected`，离线档断言 **prompt 契约**（模型看到了什么），在线档断言回复（`reply_includes/omits`、`never_claims_completed`、`no_compensation_invented`、rubric 交 LLM 裁判、温度 0、记裁判指纹）；**每个拒绝类 case 配一个 should-serve 对照** | 部分：`packs/dtc-3c-3p/scenarios/**` 是场景级回归，断言的是动作序列与门决策，**不断言 prompt 里有没有出现订单事实**；没有 should-serve 对照的成套设计 | 「过度拒绝」这类退化在工坊今天测不出来 | `packages/simulation` 加一类 `prompt_contains / prompt_omits` 断言；拒绝类场景成对写 | M | P1 |
| 影子测试（`shadow-eval.ts`）：只读连邮箱、同步 Sent、AI 草稿 vs 真人回复四维打分（事实一致 / 承诺安全 / 完整 / 语气）→ `adoptable / minor_gap / not_adoptable`；采纳率 `first_draft / ai_revised` 喂 `min_adoption_rate` 阈值 | 部分：`packages/learning` 有回流，`docs/24` 有学习回路，但**没有「连真实邮箱只读跑一遍、拿真人回复当参照」这条**；也没有初稿直发率这个指标 | 内测时没有一把尺子说「AI 够不够格自己发」 | `packages/learning` + 消息页一张「影子报告」右栏面板；指标落 `docs/24` | **L** | P1 |

### 1.B 自主发送与放权

| KA 有什么 | 工坊现状 | 差距 | 融入哪一格 | 量 | 度 |
|---|---|---|---|---|---|
| 十门自主门 `decideAutonomy`：G01 kill_switch → G02 语言 → G03 身份 → G04 意图风险(L3 T1+T2) → G05 商家规则 → G06 知识证据 → G07 订单上下文 → G08 版本(recorded) → G09 预算频次 → G10 承诺扫描(L3 T3)；7 种 disposition；`gate_error` 一律 fail-closed | 部分：`packages/support-core/src/gates/`（G04 / G06 / G10 三门，`docs/48` §4 #3）+ `packages/txn/src/precheck.ts`。**没有** G01 / G02 / G03 / G05 / G07 / G09，也没有统一的 `decideAutonomy` 单一入口与 7 种 disposition | 今天是「三门 + 散落判断」，不是一条有序链；`docs/15` 的 guardrail 前置是对的方向但门数不全 | `support-core/src/gates/` 扩成有序链 + 单一入口；缺的几门先 `recorded` 不 enforce（照 KA 的 G08 做法） | M | P1 |
| **每日自主发送上限** `AUTONOMY_DAILY_SEND_CAP = 50`（服务端常量，不暴露给商家） | 缺 | 一个 prompt 事故可以在一夜之间发 500 封 | `support-core/src/gates/` 加 G09；计数落变更账本 | S | **P0** |
| 决策记录表：每次评估一行，含每门结果向量 / matchedRules / `AUTONOMY_POLICY_VERSION` / `AUTONOMY_RULESET_HASH` / traceId / latency；**原文绝不入库**（`inboundText` 被明确排除在 schema 外）；保留 90 天 | 有等价物：`packages/txn` 建卡时落 `guardrail.gate_decided`（只有门名、结论、规则 id、规则集哈希，被扫文本一个字不进日志，`docs/48` §4 #3） | 无（工坊这条做得和 KA 一样严） | — | — | — |
| 影子模式 `shadow_simulate`：**不短路，十门全评**，恒 `simulated_send`，产出 `wouldSend` + enforce 序下的第一个 `blockingGate` | 缺 | 没法在不发信的前提下回答「上个月 AI 本来会自动发多少封、卡在哪一门」 | 门链加 `mode` 参数（纯函数，测试友好）；报表进右栏面板 | M | P1 |
| 放权闭环（022）：`agent_trust_stat` 日桶 → 30 天窗口内 `untouched >= 20` 且 `instructed + rejected = 0` → AI **主动出一张 `delegation_proposal` 高风险卡**请求放权；reject 后冷却 30 天；`general` 分类永不提议；收回 = 统计清零重计 | 缺。工坊有审批项与卡，但没有「卡越来越少」的机制 | 内测跑两周后，商家仍然每天批同样的卡 | 新卡型（`docs/36` §2.2 加一种排版）+ `packages/txn` 信任统计；**阈值是服务端常量，不做设置页**（照 KA） | M | P2 |
| 卡片预算：低优先级卡型按 `AGENT_TASK_DAILY_RELEASE_BUDGET = 15` + `10:00` 放出槽 + 安静时段压制；`release_at` 可空列，未放出的卡对端侧「不存在」；**聚合先于预算**（5 张并成 1 张只占 1 位） | 缺 | 一次知识导入会在早上糊商家一屏 | 审批项加 `release_at`；查询一律追加 `release_at IS NULL OR <= now()` | M | P2 |
| 批量确认卡 `batch_confirm`（≥5 条同类合一张，「全对」/「逐条看」，拆回无损可逆） | 缺 | 同上 | 同上 | S | P2 |
| 能力解析器 + 全局 kill switch（026）：18 个 key，`global → environment → workspace → connection` 四级 **关闭优先**；`fresh` / `ttl30` 两档缓存（60 秒内全局停）；**不依赖 Web 可用性的应急直连 DB 脚本** | 部分：工坊有出站急停（`docs/48` §4.1 提到「急停 outbound」），但没有分级能力表与应急脚本 | 出事时只能改代码重发版 | `packages/core` 加能力 registry（纯常量）+ `apps/cli` 一条应急子命令 | M | P1 |

### 1.C 知识

| KA 有什么 | 工坊现状 | 差距 | 融入哪一格 | 量 | 度 |
|---|---|---|---|---|---|
| 知识溯源（033）：来源页、`last_verified_at`、`derived_from_content_hash`、事实指纹五类（duration / money / percent / currency / responsibility，`money` **绝不做汇率换算**，`responsibility` 用闭集词表宁漏不误）；**LLM 只抽取，绝不判定「是否实质变更」** | 有：`packages/knowledge/src/{fact-fingerprint,provenance,recheck}.ts`（WP56，`docs/48` §4 #6） | 无 | — | — | — |
| `stale ≠ 不可用`：源页变了的知识照常进 prompt，只排最后 + 标注；唯一排除路径是人显式说「先别用」；`gone=true`（404）**不触发** stale | 有（`recheck.ts` 同款） | 需核对「stale 仍进 prompt」这条是否也成立 | 核对，不成立就补 | S | P2 |
| 复核卡 capability **默认 off**，`MAX_RECHECK_SUBJECTS_PER_CHANGE = 3` | 部分：工坊有复核卡与 `POST /v1/knowledge/rechecks/:id/resolve`，但没有「默认关 + 每次变更最多问 3 个主题」的节流 | 一次改版会出一堆复核卡 | `packages/knowledge/src/recheck.ts` 加上限常量 | S | P2 |
| **知识缺口「有多少客户在等」闭环（037）**：答不上来 → 落缺口 + `waitingCount`（按 `threadId` 去重）→ 待补区**按等待人数排序**（不是更新时间）→ 商家补（贴链接 / 粘文字 / 标「不需要」三选一，**零上传零富文本**）→ 给每个等待者各生成一张 `pending_review` 草稿卡（**路径里零发送函数**） | **缺**。工坊有「缺口两种补法（贴链接 / 粘文字）」（`docs/48` §4 #9，WP56），但**没有等待队列、没有补完批量回灌** | AI 答不上来 → 客户等着 → 商家补了知识 → 没有任何东西把那批人捞回来 | `packages/knowledge` 加缺口等待表（可落既有事实卡的 evidence，零新表更好）+ 一张「需要补素材」路由卡 + 补完批量出草稿卡 | M | **P0** |
| 路由卡上选一句**预期并立刻发给客户**：`compiling_details / checking_with_team / sending_guide` 三个 **preset id**，对客文案由 AI 用客户语言现写；「都不承诺具体时限之外的任何事」 | 缺 | 客户在沉默里等 | 同上（这是缺口闭环的第一步，也是最便宜的一步） | S | **P0** |
| 手工补的素材不被爬站覆盖：`MediaAssetRef.source = 'manual'`，判定与合并**只有一份实现**，三处写回全部经 `mergeCrawledMediaRefs`、零裸写 | 工坊今天不爬站（`docs/48` §4「不搬：官网爬取」），暂不适用 | — | 做爬站时再看 | — | P2 |
| 知识包导入 / 导出（`kefu-knowledge-pack/v1`，承诺类落候选走人工确认、`audience: internal` 永不进对客上下文） | 有：`packages/knowledge/src/pack.ts` 双向转换 + `POST /v1/knowledge/import`（WP56） | 需核对 `audience: internal` 这条 | 核对 | S | P2 |
| 媒体作为一等知识（`media-knowledge-after-sales-v1.md`）：安装视频 / 对比图进知识，回答时组合图文 | 缺 | 售后「怎么装」这类问题答不好 | `docs/19` 知识对象加媒体位；后置 | L | P2 |

### 1.D 渠道、收件与出站

| KA 有什么 | 工坊现状 | 差距 | 融入哪一格 | 量 | 度 |
|---|---|---|---|---|---|
| 出站 outbox 状态机（024）：`prepared → sending → accepted_by_provider → confirmed`，失败出口 `failed_retryable | sent_unknown`；每 draft 至多一条存活操作（**数据库唯一约束**）；Message-ID 一次生成永不重铸；**对账永不重发**；三档灰度 `off / record / enforce` | 有：`packages/channels/src/outbox.ts` 七态 + 合法迁移表 + `channels.reconcile_deliveries`（WP55，`docs/48` §4 #4） | 无（工坊七态比 KA 六态还细） | — | — | — |
| 持久事件 inbox（025）：所有 webhook / 收信**先落盘再 ACK**，cron 兜底重试 → 死信 → 人工 redrive；UID 游标按「原始收据是否落盘」推进而非「处理是否成功」 | 有：`packages/channels/src/email/cursors.ts` + 死信重投 `POST /v1/channels/dead-letters/:id/requeue`（WP55，§4 #5） | 无 | — | — | — |
| Amazon 渠道（038）：三层判定（22 个 relay 域 + Authentication-Results，**零 AI 零扣费**）、11 种消息型、18 种出站违规码硬闸、SLA 唯一时钟锚 `lastBuyerMessageAt`、反 canned（7 天 Jaccard > 0.95 告警不拦发）、垃圾箱必扫 | 有大半：`packages/support-core/src/amazon/{detect,outbound-guard,sla}.ts`（WP55，常量表逐字节抄） | 缺**反 canned 相似度告警**与**垃圾箱扫描**；SLA 锚已对齐 | `support-core/src/amazon/` 加相似度告警（纯函数）；垃圾箱扫描进 `channels/email` | S | P2 |
| **未证实项纪律**（038 R7）：调研里标⚠️的判据不许硬编码成事实，常量逐条带证据等级注释 + `// TODO(sampling#N)` 指回采样清单行号；R8 全程 shadow，GA 门禁 = 采样清单跑完 | 缺（工坊是逐字节抄 KA 的表，等于继承了 KA 的证据等级，但没有把证据等级标注也抄过来） | 将来自己加一行域名时没有尺子 | `support-core/src/amazon/detect.ts` 注释补证据等级 | S | P2 |
| 邮箱接管规范：默认行为、文件夹策略、不设默认等待期、**不把置信度门槛暴露给用户**、thread 接管规则、纠错机制、审计与回滚 | 有：`docs/63`（消息与邮箱全量接入）+ `packages/channels`；归档文件夹按岗位 | 需核对「置信度门槛不暴露」这条在工作台上成立 | 核对 `apps/workstation` 的消息页 | S | P2 |
| 垂直包（039）：`VerticalPack` 十项；**R2 业务代码禁止 `vertical === 'digital'` 字面比较**，只能读包字段，结构性分支只允许两处且必须在 `verticals/` 目录内；parity guard 冻结 19 处渲染后字符串 + `AUTONOMY_RULESET_HASH` 逐字节比对 | 有：`packages/support-core/src/verticals/{goods,digital}/**`（WP54） | 缺 **parity guard 那条纪律**（工坊是新建，不是改造，所以当时不需要；但以后改包时需要） | `packages/support-core` 加一个快照测试钉住渲染后字符串与规则集哈希 | S | P1 |

### 1.E 卡片、收件箱与工作台

| KA 有什么 | 工坊现状 | 差距 | 融入哪一格 | 量 | 度 |
|---|---|---|---|---|---|
| **一个入口**（035 `SC-002`：商家处理一天工作所需访问的入口数 = 1，队列之外的可操作副本数 = 0）；聊天设置页、知识页全部降级为档案室 | 部分：工坊是「岗位是任务主入口」（`docs/54`）+ 消息页（`docs/63`）两条线；聊天今天第三条线（沙盒页），**不在导航里**（`docs/73` #1） | 在线聊天没有入口；聊天会话与消息页无关 | 见 §2 与 §5 | — | **P0** |
| `priorityBand` 四档 P0–P3 由裸 `priority` **派生**（不存第二份）；排序键 `band ASC → expiresAt ASC NULLS LAST → priority DESC → createdAt ASC`；分组计数「客户在等 N · 无人等待 M」 | 缺。工坊的卡有优先级但没有「客户在不在等」这一维 | 在线聊天上线后，紧急求助会和知识确认卡排在一起 | `docs/36` §2.3 的 `DeckCard` 加派生 `band` + `expiresAt`；**派生不存列** | S | **P0** |
| **P0 超时不许静默消失**：倒计时归零 → 就地降级为「已转邮件跟进」态并移出计数 | 缺 | 商家会以为自己漏了 | 同上 | S | P1 |
| 卡片尺寸铁律：`max-w-[780px]` / `min-h-[320px]` / 内容区 `max-h-[420px] overflow-y-auto`，三个令牌是唯一真源 | 工坊有 `--ws-*` 令牌与十一种排版（`docs/36` §2.2），但没有把卡的三围钉成令牌 | 卡会长短不一 | `docs/36` §1.1 加三个令牌 | S | P2 |
| 手势语义：右=对 / 左=不对 / 上=稍后 / 下=指导，**所有端口共用**；「不对」原位展开说明口径再飞出；禁止「所有动作同一方向消失」 | 部分：工坊有卡与快捷键提示，未见方向语义规范 | 将来上移动端会打架 | `docs/36` §2 加一节手势语义表（现在只写规范，不改代码） | S | P1 |
| 内容语言模式 `zh / original / en`，**一次只显示一种，禁双语堆叠**；按槽位切（`customerExcerpt / draftBody / question / answer`） | 有：客服岗位页已有中英摘要切换（`docs/73` 亲测通过） | 需核对是否按槽位、是否禁双语堆叠 | 核对 | S | P2 |
| 通用实体卡（S5）：一套 schema（`entityType / title / sections{fields,timeline} / actions / sourceMeta`），服务端投影，前端一个渲染器吃所有类型；**即时拉取不落库**，卡面标 `fetchedAt`；IM 端渲染脱敏简版；仅商家侧可见，永不进客户 transcript | 缺。`packages/support-core/src/entities.ts` 只有抽取，没有投影卡 | 商家看到求助卡后要去 Shopify 后台翻 | 右栏面板（`registerPanelBody`）+ `packages/contracts` 加实体卡 schema；订单投影先行 | M | P1 |
| 「问 AI」第 2 层：指导输入框里直接问 AI（「这单从哪个仓发的」），答案**只给商家不发客户**，按低价路由计费 | 部分：`docs/36` §9.1 的右栏已有「问 AI」 | 需核对它能不能吃订单 / 会话上下文 | 核对；不能就补上下文注入 | S | P2 |

### 1.F 端口（IM / 移动 / 网关）

| KA 有什么 | 工坊现状 | 差距 | 融入哪一格 | 量 | 度 |
|---|---|---|---|---|---|
| 飞书 / 钉钉 / 企微交互卡片（016 / 017）+ IM 里回一句话 = 完成指导（同一个动作 API）；静默时段压制推送但**不压制拉取** | 部分：工坊有 IM 渠道卡片（飞书 / 钉钉 / 企微），`packages/channels/src/im-cards.ts`；`docs/73` #6 说未验证 | 需真跑一遍；静默时段语义未定 | 亲测脚本（§8）+ `docs/25` 补静默时段归属 | S | P1 |
| Flutter 端口（`kefuagent-flutter`）：一屏一卡 deck + 桌面 Pet；四方向手势；中文语音指挥（端上 ASR，不可用回落服务端）；iOS APNs，**无 FCM**；REST 为真相源、Supabase Realtime 只当加速器（收到信号后跑一次 `updatedAfter` 追赶，订阅健康时轮询放慢到 5 分钟当安全网，503 则本会话永久降级纯轮询） | 缺移动端；工坊只有 IM 卡片这条路 | 商家出门看不到求助 | **本轮不做**。`docs/73` #6 的结论保持：先把 IM 卡片这条路验证通（它已经能推到手机） | — | P2 |
| Agent Gateway（018 / 019）：REST v1 + webhook + MCP 15 个工具 1:1 投影；外部 Agent 的 `submit_draft` 经同一套 `draft-gate.ts` | 工坊有 `docs/28` API 网关与 `packages/api`；MCP 侧未对标 | 本轮不看 | — | — | P2 |
| 多端口共享的**动作矩阵不在客户端硬编码**（`availableActions` / `actionLabelsZh` 全来自卡片数据）；API key actor 对高风险卡**结构性**只有 `open_in_web` | 部分：工坊的卡有动作，但「API key 不能批高风险卡」这条未见 | 网关一开，机器可以批高风险卡 | `packages/api` + `docs/14` 加一条：高风险卡的 `availableActions` 对机器 actor 恒为只读 | S | P1 |

### 1.G 接入、设置与"不填表"

| KA 有什么 | 工坊现状 | 差距 | 融入哪一格 | 量 | 度 |
|---|---|---|---|---|---|
| **废掉 44 项前置问卷**（031）：接入只给入口（官网 / 客服邮箱 / 店铺），业务边界在 AI **第一次遇到时**用一张选择题卡问一次，`UNIQUE(workspace, boundary_key)` 就是「只问一次」；不答 = `declined`，该场景继续人工审批，**不阻塞任何流转**；爬取值只预填、商家答案优先 | 有：`packages/support-core/src/boundaries.ts`（15 条，前 10 条与 KA 逐条对齐）+ `docs/14` 的选择题卡 + `boundaryDedupeKey` | 需核对：`BoundaryTriggers.l3_categories` 在工坊「还没有消费方」（注释自陈），即边界卡今天可能触发不全 | 把 L3 类目接成触发源 | S | P1 |
| **覆盖证明表是验收工件**：44 个问卷信息项逐项指出由哪类来源承接，`SC-001` = 100% 覆盖、0 项要求用户使用前填写 | 缺这张表 | 没有尺子说「我们真的不用填表了」 | `docs/46`（首次设置）补一张覆盖表 | S | P2 |
| 一个链接推导整个工作台（032）：官网地址 → 品牌 / 平台 / 客服邮箱 / IMAP-SMTP 预设 / 商家自己的商品分类；三步 onboarding，第 2 步全是选择题 | 部分：`apps/server/src/onboarding.ts` 有垂直选择；邮箱预设有（`docs/48` §4 #5 提到十家预设） | 缺「从官网推导」这一段（工坊明确不搬爬取） | 保持不搬；改由知识导入承担 | — | P2 |
| **原则 16：边界归人，内容归数据**。客户会看到的运营内容（开场语、引导问题、FAQ）只允许三种控件：**开关、预设单选、预览 + 不对**；出现「增删改排」表单即违规信号 | 工坊有等价方向（`docs/36` 减字、`docs/73` #4），但没把这条写成判据 | 聊天窗设置页很容易长成一张大表单 | **写进 `docs/36`**，作为 WP124 §D 那三块界面的验收条件 | S | **P0** |
| 外观预设体系：AI 按品牌出 3 套主题包 → 8 款内置单色 SVG 图标（`currentColor`，一套资产覆盖所有配色）→ 双色 + **WCAG ≥3:1 对比度校验**（不达标一键改黑/白）→ 形状 / 动效 / 招呼气泡；暗色模式自适应；**不做自由画布** | 工坊只有 `accent`（`#RRGGBB`）+ `greeting` 两项（`apps/server/src/chat-widget.ts` 的 `safeAccent` / `DEFAULT_GREETING`） | 外观几乎不可配，且没有对比度校验 | WP124 §D 的「聊天窗」页；**照 KA 的预设体系做，不要做调色盘** | M | P1 |
| 形象上传只限头像位（2026-08-22 改判）：服务端按 `sharp` 解出的**真实格式**判（不信 `Content-Type`）、拒 SVG（脚本）、拒 GIF / 多帧 WebP（自己动）、≤512KB、最短边 ≥128px、每 workspace 每分钟 ≤10 次、只存处理后的、原图丢弃 | 缺 | — | 后置；真要做就照抄这七条 | S | P2 |
| 安装心跳：widget 每次 `/session` 由**服务端自己读 origin**（永不信 `body.origin`），只留 hostname，聚合出「最近 7 天加载次数 / 会话数 / 来源域名」；「已上线」靠数据不靠商家打勾。心跳**禁止**写用量表（会污染给商家看的用量卡） | 缺 | 商家装没装上、装在哪个域名，系统答不出来 | WP124 的转发器天然是这个数据的唯一经过点 | S | P1 |

### 1.H 计费与运营

| KA 有什么 | 工坊现状 | 差距 | 融入哪一格 | 量 | 度 |
|---|---|---|---|---|---|
| 积分按操作类型路由到不同档模型（普通回信 flash-lite、深入分析上大模型）；单次操作积分消耗估算表；**沙盒试聊不豁免计费**（拒绝「内部测试免费」的诱惑） | 部分：`packages/metering` 有钱包 + `pricing.json` + `cost-table.json`；`plans.json` 只有一个占位档 `beta-tester` 且自带 `needs_decision` | 档位与权益未定（已知） | `docs/67` / WP118 | — | P1 |
| 聊天用量事件细分 `chat_presales / chat_assist_requested / chat_assist_answered / chat_email_follow_up`，且**读时折叠旧事件名**（不迁移历史行，否则发布当天报表会断成两截）；新事件名**不许以 `ai_` 开头**（否则污染 AI 成本报表） | 缺细分 | 上线后说不清「求助了多少次、转了多少封邮件」 | `packages/metering/src/usage-ledger.ts` 加事件名 + 读时折叠 | S | P1 |
| **被废弃的 AI 生成照常计费并记 usage**（客户补消息导致重生成时）——真实发生的成本不隐藏 | 未定 | WP124 做话轮合并时会碰到 | 写进 WP124 验收 | S | P1 |
| 北极星指标：AI 自主解决率（无求助即关闭的会话占比）；配套求助响应时长中位数、求助触达率、IM 认领率、队列清空率、同类合并命中率、求助→沉淀转化率、**同类问题二次求助率（应持续下降）**、转邮件跟进率（过高 = IM 没绑） | 缺整套 | 内测时没法判断「这套设计在不在变好」 | `docs/24` / `docs/37` 加一节指标定义；先只定义不实现 | S | P1 |

### 1.I 一条横跨全表的发现：**客服的判断层没接进生产**

这条比上面任何一格都重要，单独写。

`packages/support-core` 的纯函数面很厚，但**逐个查生产引用**（排除 `test/` 与 `packages/simulation/`）后是这样：

| 函数 | 生产接线处 |
|---|---|
| `classifyChatTurn` / `buildChatPlan` / `evaluateChatTurn` / `acceptChatTeaching` | `apps/server/src/chat.ts` ✅ |
| `detectAmazonChannel` / `evaluateAmazonOutbound` | `apps/server/src/channels.ts:135,760` ✅ |
| `classifyText`（邮件分类） | `packages/runtime-direct/src/providers/brain.ts:131` ✅ |
| `detectAnsweredBoundaries` / `SUPPORT_BOUNDARIES` | `apps/server/src/server.ts:91,3029`（**只读对账**，列出哪几条答过） |
| `draftReply` | **零**（只在 `packages/simulation/src/world.ts` 与单测） |
| `computeSla` / `targetsFor` | **零** |
| `shouldEscalate` / `evaluateManualReview` | **零** |
| `evaluateAutonomyGates`（三道自主门） | **零**（只有 `packages/simulation/src/world.ts:7603`） |
| `findUnansweredBoundary` / `answerBoundary` | **零** |
| `knowledgeCandidate(s)` / `canAutoPropose` | **零** |
| `policyQuestionRequest` / `knowledgeUpdateRequest` / `aiQuestionRequest` | **零** |

> 已逐条 grep 复核：`grep -rn '<name>' --include='*.ts' packages apps | grep -v test` 的结果就是上表。

含义有两层，都要说清楚：

1. **`agentsws demo` 里看到的「邮件线基本通」（`docs/73`）是合成世界跑出来的**——`packages/simulation/src/world.ts` 把这些纯函数串成了完整流水线；`apps/server` 这条真路径上，邮件客服走的是**通用 Agent 运行时**（`apps/server/src/runtime.ts` 起草 `outbound_draft`）+ 提示词技能（`packages/support-core/skills/customer-care/SKILL.md`）。两条路的判断质量不是一回事。
2. **在线聊天反而是唯一端到端接线的那条**（`apps/server/src/chat.ts` 把聚合 → 分类 → 计划 → 五种动作 → 教 AI → 求助超时全串起来了）。这与 `docs/73` 的直觉印象正好相反：聊天缺的是**访客那一面与界面**，邮件缺的是**判断层本身**。

所以真正的 P0 排序应该是：**先把三道自主门与 SLA / 升级接进 `apps/server` 的邮件路径**（否则「客服岗内测」测的是一个没有门的 AI），再补在线聊天的访客面。

**另外两条同源的缺**：

- **置信度算了但没人用**：`Classification.confidence` 与 `ChatClassification.confidence` 都算了，`chat/plan.ts` / `draft.ts` / `gates/gates.ts` 一次都没读。KA 那边 `G06 knowledge_evidence` 是有阈值的。补一条门即可（S）。
- **职责 yml 里的额度没有执行者**：`dtc.support` 写着 `reply_customer: 200/day`、`stage_refund: max_auto_refund_amount 50 USD`，但 `packages/metering` 里没有按能力 / 按工作区的配额机制（只有积分钱包的余额不足）。额度今天是**声明，不是约束**。这一条与 1.B 的 `AUTONOMY_DAILY_SEND_CAP` 是同一件事，应该一起做。

---

## 2. 在线聊天专章

KA 的在线聊天是 2026-08-05 的 `live-chat-full-auto-v1.md` 一次性重构的，分 S1–S5 五期，
落成 specs 034（S1 教学式协作）、035（S2 统一卡片工作台）、036（S3 页面上下文），
S4（开场引导）与 S5（实体卡）并入后续轮次。**它那一整套的纲领是一句话**：

> 前台永远是 AI 在说话；人工永远只教 AI 说话。设置与运营分离；售前靠页面上下文驱动。

工坊这边的现状（`docs/73` 亲测 + 本次逐文件核对）：后端流水线端到端通了，
**访客那一面与界面几乎不存在**。下面逐项拆。

### 2.1 逐项对照

| # | 项 | KA（含出处） | 工坊现状（含路径） | 差距 | 度 |
|---|---|---|---|---|---|
| 1 | **挂件外观与嵌入** | `public/chat-widget.js`（98 KB，由 `scripts/lib/widget-*-block.ts` 四个生成块拼出，**CI 断言两份 widget 逐字节相同**）；外观 = 主题包 3 套 + 8 款单色 SVG 图标（`currentColor`，一套资产覆盖所有配色）+ 双色 + WCAG ≥3:1 校验 + 形状 / 动效 / 招呼气泡；暗色自适应；实时预览 | `apps/server/src/widget.ts:39-324` 的内联 vanilla JS；56px 圆 launcher + 340×460 面板；**可配只有 `accent` 与 `greeting` 两项**（`chat-widget.ts` 的 `safeAccent` / `DEFAULT_GREETING`）；无预览、无主题包、无对比度校验 | 外观几乎不可配；没有「一份定义两处渲染」的约束（工坊只有一份 widget，但 WP124 要上三种部署，会变成多份） | P1 |
| 2 | **访客会话生命周期** | `open → assist_requested → assist_answered → email_follow_up → closed`；`human_handling` 与 `operator` 直发**已废弃**（只读兼容）；`closed` 的写入路径在 S1 一并补上（勘误 12-D：之前是死代码） | `packages/support-core/src/chat/types.ts` 六态（多一态 `human_takeover`），迁移表是真源，巡检谓词从表算；`closed` 有写入路径 | 状态机更完整；分歧只在 `human_takeover`（§6.1） | — |
| 3 | **AI 自动答与置信度** | 触发求助八条规则：知识缺口 / 只有 `unverified`·`stale` 可依据 / 行业模板缺品牌数值 / 高风险边界 / 订单歧义 / 客户点名要人工 / 商家主动介入；G06 `knowledge_evidence` 有证据阈值 | `chat/plan.ts` 五种动作按优先级：`handoff` → `assist` → `human_review`（**`money_touch` 为真时 `can_auto_reply` 恒 false，任何垂直包都覆盖不了**）→ `collect_info` → `answer` | **`confidence` 算了但没人读**（`plan.ts` / `draft.ts` / `gates.ts` 零引用）；知识缺口与 stale 知识没有进触发条件 | **P0** |
| 4 | **转人工与接管** | **不存在**。`handoff` 语义改 `assist`；`human_handoff` 意图保留但话术**不承诺「转接真人」**；开场引导里的「Talk to a person」被删掉换成「其他问题」（不主动教客户绕过 AI） | `PUT /v1/chat/sessions/:id/takeover` + 沙盒页上的接管开关；`ChatMessageRole` 含 `operator` | **方向性分歧**，见 §6.1 | **P0（要拍板）** |
| 5 | **离线与邮件续聊** | T+0 诚实话术（不装知道、不承诺结果、不承诺时限）→ T+3 换措辞再要一次邮箱（**勘误 12-C：T+0 已经要过一次，照抄会连发两遍同一句**）→ 等待时长 **1/3/5/10 分钟预设单选、默认 1 分钟**、**服务端白名单、非法值回落默认而不是最长档**、死线在求助那一刻固化进 `assist_deadline_at`（改设置不影响正在等的人）；超时转 `email_follow_up`，**发件身份永远是 AI**；无邮箱则不发信、下次客户回来优先补收 | `support-core/src/chat/assist-timeout.ts` 的 **T+3 / T+10 两个固定钟点**；`packs/dtc-3c-3p/scenarios/chat/assist-timeout-to-email.yml` 钉住了整条；没接邮件渠道时**转态但不假装发了邮件**（好） | 工坊的 10 分钟是 KA 2026-08-22 **主动改掉**的那个值；理由很硬：「在线聊天里等的人是客户，对着一句『我去和团队确认一下』的页面等十分钟不叫耐心，叫会话已经丢了」 | **P1（建议改默认 1 分钟）** |
| 6 | **主动邀请** | 招呼气泡（teaser）：launcher 旁自动冒出当前场景开场语第一句，预设 关 / 延迟 3s / 延迟 8s。**没有传统意义的「主动邀请规则引擎」** | 缺 | 小；且要照 KA 的做法做成预设而不是规则 | P2 |
| 7 | **商品 / 订单卡片** | 三层披露：第 0 层卡面证据摘要（订单号 / 状态 / 金额 / 物流最后事件 / 客户邮箱有无 / 当前页面 / 卡住的知识条目及可信度，**全部取自已有上下文，零新增查询**）；第 1 层通用实体卡（一套 schema、一个渲染器吃七种类型，**即时拉取不落库**，标 `fetchedAt`，IM 端脱敏简版）；第 2 层「问 AI」 | 缺全部三层。`support-core/src/entities.ts` 只有抽取（`extractOrderRef` / `extractAmount`） | 商家看到求助卡后只能去 Shopify 后台翻 | P1 |
| 8 | **多语言与逐句翻译** | 客户侧回复用**客户语言**；商家侧界面中文优先；卡片内容三档 `zh / original / en`，**一次只显示一种，禁双语堆叠**，按四个槽位切；缺译回退原文并提示 | 挂件界面词只有中 / 英两套，且按**宿主页面 `<html lang>`** 判（不跟服务端配置走）；招呼语是商家写的单一字符串，不分语言；岗位页的中英摘要切换已有 | 挂件侧的语言判定错位（应按访客浏览器语言 + 服务端配置） | P1 |
| 9 | **附件与图片理解** | spec 013 qwen-vision-attachments + `attachments/route.ts` + 010 附件生命周期；上传有格式 / 大小 / 频次硬限 | `ChatChannelAdapter` 能力写死 `{ text: true, image: false, file: false, card: false }`（`packages/channels/src/chat/adapter.ts:92`） | 访客发不了图 | P2 |
| 10 | **评价与复盘** | **明确「永不做」CSAT 弹窗**（`opening-guide-data-loop-v1.md` §6.2 第 4 条）：满意度从行为推断（无求助关闭、复购、转化）。复盘走「会话已结束时提交指导 → 只沉淀不发消息」 | 缺；`docs/73` 里把「评价与复盘」列成待补项 | **建议照 KA 不做 CSAT**，只做「会话结束后教一句 = 只沉淀」这条 | P2 |
| 11 | **Shopify 应用嵌入** | `kefuagent-shopify-app` 是**纯壳**（一个 `shopify.app.toml` + 一个 Theme App Extension，`extensions/chat-widget/blocks/chat_widget.liquid`，`target: body`）；商家在 *Themes → Customize → App embeds* 打开「KefuAgent Chat」开关即上线，**不改主题代码、不贴 script**；embed 只有三个设置项（开关 / 可选强调色 / app origin），Liquid 注释明写「外观唯一真源在后台」；**不把 workspace id 暴露在前台**，用 `shop.permanent_domain` 由后端反查；scopes **刻意不申请 `read_customers`** | `docs/43`（Shopify 接入）已有；Theme App Extension 形态未做 | 独立站用户装挂件要贴 script；Shopify 用户本可以一键 | P1（与 WP124 同期最省） |
| 12 | **移动端通知与回复** | `kefuagent-flutter`：一屏一卡 deck + 桌面 Pet；四方向手势；中文语音指挥（端上 ASR，不可用回落服务端）；iOS APNs，**无 FCM**；**REST 为真相源、Realtime 只当加速器**（收到信号跑一次 `updatedAfter` 追赶；订阅健康时轮询放慢到 5 分钟当安全网；503 则本会话永久降级纯轮询）；动作带 Idempotency-Key + expectedVersion | 缺移动端；只有 IM 渠道卡片（飞书 / 钉钉 / 企微），`docs/73` #6 说未验证 | **本轮不做移动端**：IM 卡片已经能推到手机，先把它验证通 | P2 |
| 13 | **关机后的在线值守** | KA 是 SaaS，不存在这个问题 | `packages/standby` 的「值守」= **进程值守**（云侧为每个租户拉起一个 `apps/server` 子进程 + 反向代理 `/w/:workspace_id/*`，`node-host.ts` 依赖 `child_process`）；`apps/cloud-worker` 里**没有任何聊天 / 客服 / standby 的 DO 或路由**（只有 `AccountsDO` / `LedgerDO` / `WalletDO`） | Cloudflare Workers **跑不了** `packages/standby`（不能 spawn 子进程）。这正是 `docs/73` #2「托管档在 Cloudflare 形态里没开」的根因 | **P0（架构分叉，见 §5.3）** |

### 2.2 KA 那套里最值得抄的五条机制（与外观功能无关，都是纪律）

1. **指导原文泄漏守卫**（`src/lib/support/chat.ts:517` `containsInstructionVerbatimLeak`）：
   商家的中文指导进 prompt、**永不进 `bodyText`**；但「prompt 里写了」不是保证——
   投递前先问一句「这条回复里有没有逐字引用商家那句话」（两侧先归一化空白，12 字以上按最长公共连续串判）。
   **工坊的 `POST /v1/chat/sessions/:id/teach` 今天没有这道守卫**，而工坊的教 AI 是中文、客户多半是外语，
   泄漏出去商家还撤不回来。**S 量级，P0。**
2. **打字信号只承载布尔，服务端强制拒绝带自由文本的载荷**（FR-035）——隐私红线不依赖客户端自律。
   配套 7 个可调常量（缓冲窗 2s / 打字中静默 8s / 停止判定 3s / 连珠炮封顶 20s / 活跃键击上限 60s /
   点动画最短 1.5s / 上报节流 ≤1 次每 2s），**全部是纯函数 + 冻结时钟可测**。
   工坊的 `chat/aggregate.ts` 已有 2s / 20s 两个，缺打字信号这一维。
3. **消息接收与回复投递解耦**（FR-047）：消息落库即确认，回复走异步通道；
   否则 60 秒的等待上限会撞穿函数执行时限。**这条直接决定 WP124 的转发器协议形状**（见 §6.3）。
4. **服务端自己读 origin，永不信 `body.origin`**（`src/app/api/support/chat/session/route.ts` 注释）：
   「调用方给的值是一个声明，而声明对这里的两件事（证明安装、授权安装）都一文不值」；
   请求体里**故意没有 origin 字段**，连误读都不可能。心跳只留 hostname，
   所以一个带着购物车 URL、query 里有邮箱的 `Referer` 也漏不出去。
   工坊的 `chat-widget.ts` 已经按 Origin 头判（好），但**心跳 / 安装证据这一块整个没有**。
5. **一次客户话轮恰好产出一条 AI 回复**（`SC-009`），生成中来新消息则废弃重生成、点动画不闪断，
   且**被废弃的那次生成照常计费并记 usage**——真实发生的成本不隐藏。

---

## 3. KA 2026-07 之后的更新清单

KA 在这两个月里跑了约 742 个提交、迁移从 0044 推到 0072。改得最多的文件依次是
`chat-service.ts`(34) > `support.schema.ts`(33) > `service.ts`(27) > `agent-tasks.ts`(24) > `knowledge-learning.ts`(16)——
重心很清楚：**在线聊天 + 卡片流 + 知识**。逐条如下（每条一句话 + 我们要不要）。

| 时间 | 更新 | 要不要 / 怎么融 |
|---|---|---|
| 07-12～15 | **多端口 Agent 内核**（014 / 014b / 014c）：卡片任务流 + REST 双认证 + Realtime/SSE + 语音指令 + webhook envelope | 要，工坊已有等价物（审批项 + `packages/api`）。**只抄一条**：动作矩阵不在客户端硬编码，`availableActions` 随卡下发 |
| 07-14～15 | **IM 卡片三件套**（016 / 017）：飞书 / 钉钉 / 企微交互卡，落在同一个 `im-card-port` 接缝上 | 要，工坊已有 `packages/channels/src/im-cards.ts`；**缺验证**（`docs/73` #6），进亲测脚本 |
| 07-14 | **022 fewer-cards**：委托循环 + 卡片预算 + 静默时段 + 被抑制通知补投 | 要，但 **P2**。先抄「卡片预算 + 安静时段只压推送不压拉取」；放权闭环后置 |
| 07-15 | **Agent Gateway**（018 / 019）：REST v1 + webhook + MCP 15 个工具 1:1 投影 + 三个生态包 | 部分要。工坊有 `docs/28`；**本轮只抄一条**：高风险卡对机器 actor 结构性只读 |
| 07-23 | **P0 止血九刀**（HF-1～HF-9）：cron 多租户化、放权发送接总开关、公开聊天纯邮箱查单需验证、统一安全出网防 SSRF、出站防重复、入站毒消息隔离、附件上传加固 | 要。工坊 WP55 已搬大部分（毒消息隔离、outbox）；**「公开聊天里纯凭邮箱查单必须先验证」这条要单独确认**——WP124 的访客面会踩到 |
| 07-23 | **Round 2 四刀**：026 能力解析器、023 自主门、024 出站 outbox、025 事件 inbox + 027 CI 质量门 | 024 / 025 已搬；023 搬了三门未接生产（§1.I）；**026 能力解析器工坊没有，P1** |
| 07-24 | **Amazon 接入起步**（028 / 029 / 030）：CommerceProvider 抽象 + LWA OAuth + Orders 只读投影 + PII 治理 + storefront bootstrap | 要，但工坊走 `docs/43` 自己的 Shopify 路；**CommerceProvider 这层抽象值得抄**（一个 mapper 服务端定义一次，前端零改动） |
| 07-24 | **031 废掉 44 项前置问卷** → 入口自动采集 + 即时决策边界卡 | **已搬**（`support-core/src/boundaries.ts` 15 条）。缺的是「覆盖证明表」这个验收工件 |
| 07-28～29 | 后台**双语清零**（累计数千字硬编码中文归零）+ 信息密度收敛（长说明收进 ⓘ 悬浮） | 要。工坊 `docs/36` §7 已有「解释性文字放哪」；**把「服务端拼装文案」这个 i18n 盲区记下来** |
| 07-28～29 | 两个数据真实性 P0：生产后台把演示假数据当真实数据显示；演示 fixture 泄漏（把别家租户状态当成自己的） | **要引以为戒**。工坊的 `agentsws demo` 合成世界与真实工作区共用同一套界面，**同样的坑就在前面**（§1.I 已经是它的一个表现） |
| 07-31～08-01 | **032 一个链接推导整个工作台**：官网 → 品牌 / 平台 / 客服邮箱 / IMAP-SMTP 预设 / 商家自己的商品分类；三步 onboarding | 部分要。工坊明确不搬爬取（`docs/48` §4）；**「商家自己的分类，不要堆成一堆」这条产品判断要记进 `docs/46`** |
| 08-01 | Gateway 升到 MCP 2026-07-28（SDK v2）；商品页改卡片式 + 商家分类分组 | 不急 |
| 08-03～04 | **计费 v3 全面重做**：按操作类型路由模型、两池积分账本 + 档位、1 积分 = $0.01、推荐送积分 | 对应工坊 `docs/67` / WP118。**「按操作类型路由到不同档模型」这条要**（聊天实时回复走低价档，求助总结与知识沉淀走质量档） |
| 08-04～05 | 合规补齐：自助删除级联 + 数据保留 UI + 同意审计轨迹；跨 workspace 数据共享改显式开关（默认关） | 要。工坊有 `docs/40` / `docs/39`；核对「跨工作区共享默认关」是否成立 |
| **08-05** | **S034 在线聊天 v3 教学式协作 MVP**（迁移 0060）：拆除人工直发 → 教学动作；客户话轮管理（打字信号 + 投递解耦 + 到点调度）；求助超时 cron 与转邮件降级闭环 | **本文第 2 / 6 节的主体**。工坊已有其中的求助超时与教 AI，缺打字信号、投递解耦、泄漏守卫；`human_takeover` 是分歧点 |
| 08-05 | 人工把关从**七个旋钮**改成**四档预设**；工作台导航改名重组 | 要。这是「边界归人但形式是选择题」的样板 |
| **08-06～07** | **S035 统一卡片收件箱**（0062）：队列落 `/inbox` 首屏、`/chat` 变纯设置页、深链翻转、语言模式三处收敛为唯一真源并扩 English 档 | **要**。优先级带 P0–P3 与「入口数 = 1」是 P0；`docs/36` / `docs/63` 落点 |
| **08-07** | **S036 页面上下文**（0063）：widget 采集所在页面 → 落库 → 进 prompt（**400 字封顶**）→ 分场景开场语四级回退 + 当前商品优先检索；**page context 与心跳两条路彻底分开**（合并是诱人的一行改动，会把心跳的隐私底线拉到调用方可控） | 要，**P1**，与 WP124 同期做最省（挂件反正要改）。隐私红线照抄：只留 `host + pathname`，不采登录客户 id / 邮箱 / 地址 / 输入框内容 |
| 08-08 | **开场引导数据闭环**（S4'）：采集 → 挖掘 → 归一化 → 聚类 → 排序 → 出牌；后台只留一个开关；开场语改只读预览 + 自动 A/B。同日发散出**原则 16**与**永不做清单** | **原则 16 与永不做清单要**（§4 全文引用）；数据闭环本身 P2 |
| 08-08 | **S5 通用实体卡** schema + 订单投影 + 商家上下文问答；**门控放权建议卡**（系统按数据提案，商家一滑批准） | 实体卡 P1（右栏面板）；放权建议卡 P2 |
| 08-10～14 | **S6 补知识**：「教 AI」与「内容缺口」合并为补知识、手工补的素材不被爬站覆盖；AI 路由调档；**038 Amazon 渠道 v1** 四工单落地 | 补知识闭环 **P0**（§1.C）；Amazon 已搬大半 |
| 08-19～09-07 | 首页改版（点名对比 Zendesk / Freshdesk、嵌入真实后台组件）；**039 垂直包 v0**（goods 逐字节入包 + parity guard + digital 包 + 知识包导入）；**Mascot v1**（形象上传只限头像位）；**09-07 客服纪律 round57**（客户内容围栏 + 敏感标识打码 + prompt 装配抽纯函数 + 离线评测套件；G10 承诺扫描改按子句看否定） | 垂直包**已搬**；**round57 的打码与离线评测是 P0 / P1**；Mascot 后置 |

**两个兄弟仓最后提交都停在 2026-07-29 前后**——近两个月的迭代基本全在主仓。
Flutter 那边 README 列的外部依赖（bearer、语音端点、Realtime 方案）都已由主仓交付。
**结论：移动端这一路本轮不跟**，工坊先把 IM 卡片这条路验证通。
