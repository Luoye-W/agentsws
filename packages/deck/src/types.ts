/**
 * 36 §2.3 卡片对象 + 29 §1 积木对象的展示层类型。
 *
 * 纪律：这一层**只投影，不发明**。金额、日期、id 一律来自 `ApprovalItem` 的结构化字段
 * （14 §2「数字不经模型手」）；模型写的只有 `title` / `summary` 两行人话。
 */
import type {
  ApprovalItem,
  ApprovalKind,
  ApprovalState,
  AssignmentId,
  Iso8601,
  ObjectRef,
  RiskClass,
  RoleId,
} from '@agentsws/contracts'
import type { DeckLayout } from './layout.js'

/**
 * 岗位 id。
 *
 * 36 §3 侧栏里的「岗位」= 一个人对某个职责在某个范围上的持有，也就是一条 `Assignment`
 * （契约里没有单独的 PositionId；`Position` 是模板，不是持有）。因此 `position_id` 就是
 * `assignment_id`——这样 `X-Assignment` 头与岗位页天然一一对应，也不会出现跨 Assignment 并集。
 */
export type PositionId = AssignmentId

/** 36 §2.2：14 种审批项 + 两种系统卡。 */
export type DeckKind = ApprovalKind | 'system_alert' | 'digest'

/** 36 §2.1 五动作矩阵，没有第六个。 */
export type DeckAction = 'approve' | 'reject' | 'instruct' | 'snooze' | 'open'

export type PriorityBand = 'P0' | 'P1' | 'P2' | 'P3'

export type HighlightType =
  | 'amount'
  | 'deadline'
  | 'commitment'
  | 'risk_term'
  | 'order_ref'
  /** WP64（51 §2.3）：这一封群发要发给多少人。人按下"发送"之前该看见的第一个数。 */
  | 'audience'
  /**
   * WP64（51 §2.3）：抑制 / 退订名单里剔掉了几个人。
   *
   * 剔了要在卡上说，不剔也要在卡上说（`0`）——"这次没人被剔"与"这次没查"
   * 在群发这件事上是两回事，卡面上必须分得开。
   */
  | 'suppressed'
  /** WP64（51 §2.4）：这张单压了几天没发。 */
  | 'overdue'
  /** WP64（51 §2.4）：物流单号。标记发货的卡上没有它就不该被批准。 */
  | 'tracking'
  /**
   * WP67（48 §5.1）：这条开发信 / 这次合作对着的是谁 + 他多少分。
   *
   * 卡面上第一眼要回答"为什么是他"。打分那五项的完整解释在卡里面（`scoring.ts`
   * 的 `factors`），芯片上只放那个总分——芯片是索引，不是报告。
   */
  | 'creator'
  /** WP67：合作现在走到哪一步了（阶段机的中文名）。 */
  | 'stage'
  /**
   * WP67（48 §5.1 归因）：这条追踪链接带回来多少单 / 多少钱。
   *
   * 归不上的订单**不算进来**（`attribution.ts` 的 `unmatched`）——
   * 这个数宁可小，不能是猜的。
   */
  | 'attribution'
  /**
   * WP72（56 §2）：这条卡对着的是哪条渠道（`Meta` / `Discord` …）。
   *
   * 九条职责的卡长得一模一样，唯一分得开的就是这一格——一个人同时挂着 Meta 与
   * Discord 时，队列里两张发布卡不写渠道等于让他猜这条要发到哪儿去。
   */
  | 'channel'
  /**
   * WP72（56 §2）：这条内容**什么时候**发出去。
   *
   * 与 `deadline` 分开：`deadline` 是"再不处理就晚了"，这一格是"批了之后它会在
   * 这个时刻自己出去"。排期与立发是同一条 kind，门在**排**的时候——所以人按下
   * 那一下之前必须看见这个时刻（15 §2 / 56 §2）。
   */
  | 'scheduled'
  /** WP72（56 §2 社群组）：入群审核卡上这一条是谁递的申请。 */
  | 'member'
  /**
   * WP72（56 §4）：转客服卡——这条线程判成了客户问题，要交给
   * `dtc.community-support`。文字是那条职责的名字，不是分类器的结论代号。
   */
  | 'handoff'
  /**
   * WP76（58 §3）：这张卡对着的是哪个**规格**（`Amazon 主图` / `易拉宝`）。
   *
   * 与 `channel` 同一条理由：五条设计职责的卡长得一模一样，而"2000 见方纯白底"
   * 与"90×54mm CMYK 出血 3mm"是完全不同的两件事。写不出规格的卡，
   * 人得点进去才知道自己在批什么。
   */
  | 'spec'
  /**
   * WP76（58 §3）：这次出**几张**变体。
   *
   * 与 `audience` 同形：人按下那一下之前该看见的第一个数。额度是 6
   * （`max_variants_per_brief`），超了 guardrail 会转人审——而卡面上这一格
   * 就是他判断"这次是不是要多了"的依据。
   */
  | 'variants'
  /**
   * WP76（58 §1 / 04 §6）：**这张稿是谁点的头**。
   *
   * 入库卡上没有它 = guardrail 会当场 block（`human_pick_required`）。
   * 放在卡面上不是为了好看：它是"视觉决定永远是人"这条纪律在界面上唯一
   * 看得见的地方——批的人要看得出，这一张是**有人挑过**的，不是机器自己选的。
   */
  | 'picked_by'
  /**
   * WP76（58 §1）：**没有图片模型**那句话。
   *
   * 不是错误，是一句人话（"DeepSeek 不出图；去设置页填一个 OpenAI 兼容口的 key"）。
   * 它出现在变体卡上，而不是一块写着"去连接"的空面板——连接页上根本没有
   * 一张"图片模型"的卡可以点。
   */
  | 'no_image_model'
  /**
   * WP77（59 §3）：**主题发布卡上的预览链接**。
   *
   * 12 §2 那句"预览链接就是审批材料"在卡面上的落点。没有它的发布卡根本提不出去
   * （`@agentsws/site-core` 的 `publishReadiness`），所以这一格只要出现就一定有值。
   */
  | 'preview'
  /**
   * WP77（59 §3）：**上线检查单卡上还差几项**。
   *
   * 写成"3 项会让顾客买不成 / 2 项迟早出事"而不是一个总分：合成一个分数，
   * 没人答得上"哪儿不对"（同社群活跃度那三个数不合成"健康分"的理由）。
   */
  | 'gaps'
  /**
   * WP77（59 §3）：这张卡对着的是哪一封通知邮件 / 哪一个 App。
   *
   * 建站那四张卡长得很像，这一格是第一眼分得开它们的东西（同社媒的 `channel`）。
   */
  | 'site_target'
  /**
   * WP75（57 §3）：这条卡对着的是哪个平台（`Meta Ads` / `Google Ads` …）。
   *
   * 与 `channel` 分开：那一格说的是"发到哪个号"，这一格说的是"花哪个账户的钱"。
   * 四条投放职责的卡长得一模一样，唯一分得开的就是这一格。
   */
  | 'platform'
  /**
   * WP75（57 §3）：**岗位级日花费总闸当时还剩多少**。
   *
   * 每一张投放的卡上都有它，不只是提预算那一张。理由是 04 §5 那条纪律的全部
   * 重点：人点头之前要看得见"今天还剩多少"——而那个数与他正在批的这一条
   * 必须是同一时刻算的，不能是他点开卡之后自己去面板上再看一眼。
   */
  | 'spend_gate'
  /**
   * WP75（57 §1）：止损那张卡上的**判据**。
   *
   * 不是"止损"两个字，是"ROAS 0.6（线是 1），今天花了 400，占日预算的 40%"。
   * 卡上只写结论的话，点头这件事就没有内容——那不是审核，是随手点两下
   * （同 56 §6 入群审核那条"他填的答案要在卡面上"）。
   */
  | 'stop_loss'
  /**
   * WP78（60 §1）：外部发帖卡上的**版规检查结论**。
   *
   * 这是这张卡上第一眼要看的东西：我们在别人的地盘上，版规不让就不该发。
   * 文字是 `pr-core` 的 `explainRuleCheck` 那一句人话——与 guardrail 拦下来
   * 时用的规则名（`no_self_promotion` / `cooldown`）是同一件事的两个面，
   * 卡面上给人看的永远是那句人话。
   */
  | 'venue_rules'
  /**
   * WP78（60 §2）：新闻稿发布卡上的**数字出处**。
   *
   * 「6 个数，6 个有出处」——两个数不等的稿子根本提不上来（guardrail block），
   * 所以这一格上永远是相等的两个数。它存在的意义是让人**看见这件事被查过了**：
   * 一篇稿子被登出去之前，人要知道里面的数不是编的。
   */
  | 'facts_cited'
  /**
   * WP78（60 §1）：负面预警卡上的**情绪与传播量**（"负面 · 被转了 12 次"）。
   *
   * 传播量是去重那一步算出来的（`pr-core` 的 `dedupeMentions`），不在卡上现算——
   * 它决定的是"要不要现在就回"，而那是人要判的事。
   */
  | 'sentiment'
  /**
   * WP122（71 §5）：挑图卡与定稿入库卡上的**规范自检那一行**。
   *
   * 文字是 `ads-core` 的 `designNoteZh` 拼出来的那一句（"…不在品牌色板里"）。
   * 它是一颗芯片，**不是一道闸**：这一格上永远只出现提示，永远不会因为它
   * 而让这张卡批不下去——品牌规范是给人省事的，一个会拦住人的检查，
   * 人只会想办法关掉它。
   */
  | 'design_note'

export interface DeckHighlight {
  type: HighlightType
  text: string
}

/**
 * 证据芯片（37 §1 第 5 行）：**只出 i18n key + 参数**，永不出裸 id。
 *
 * `params` 里只允许放已经过服务端 enrichment 的**展示名与数字**（订单号 `#1001`、
 * 引用条数），绝不放 `fact_…` / `cus_…` / `run_…` 这类 ObjectRef id——那正是 WP15
 * 截图里露出来的东西。要跳到对象的芯片走 `entity_chips`，它自带展示名。
 */
export interface DeckEvidenceChip {
  label_key: string
  params?: Record<string, string | number>
}

/**
 * 实体芯片（订单 / 客户 / 事实卡…）：另起一行，**带展示名**。
 *
 * `label` 由 api 层的 enrichment 以本人身份查出来（29 §2）；查不到（无权见 / 已删）
 * 的 ref 在投影时就被丢掉，只在 `DeckDetail.enrichment.dropped_refs` 上留个数。
 * `id` 留着只为点击时跳转，**渲染层不许把它印在卡面上**。
 */
export interface DeckEntityChip {
  type: ObjectRef['type']
  id: string
  label: string
}

/** 37 §3 筛选的第四枚 chip：这张卡是谁引出来的。 */
export type DeckSource = 'todo' | 'conversation' | 'system'

/** 内容盒一次只显示一种语言（37 §1 第 4 行，禁双语堆叠）。 */
export type DeckContentMode = 'zh_summary' | 'original' | 'en'

export interface DeckContentVariants {
  /** 永远有：Agent 写的中文摘要，也是队列默认显示的那一种 */
  zh_summary: string
  /** 客户原文（多半是英文），从 payload 的结构化字段里取，不是模型现编的 */
  original?: string
  /** 英文版摘要；没有就回退中文摘要并在卡面上说明 */
  en?: string
}

export interface DeckOption {
  id: string
  label: string
}

/** 36 §2.3 DeckCard —— 六端同一份（建议进契约 #15，见交付报告）。 */
export interface DeckCard {
  id: string
  kind: DeckKind
  /**
   * WP96：卡的**主体排版**（十一种之一）。
   *
   * 由 `layoutFor(kind, payload.kind)` 在投影层算出，六端拿到的是同一个值——
   * "这张卡长什么样"和"这张卡是什么"一起下发，前端不再自己 `switch (kind)`。
   * 通用头（岗位 · 类 / 等待时长 / 提案人）与通用页脚（按钮行 + → 圆钮）不受它影响。
   */
  layout: DeckLayout
  /**
   * WP100：`staged_change` 那条账本条目的类型（`payload.kind`，即 `ChangeKind`）。
   *
   * 投影层已经为了算 `layout` 读过它一次，顺手带出来——头一行的类别人话
   * （"网站运营 · 改价"）与金钱卡的主动词（"批准退款" / "批准补发"）都要它，
   * 而前端**不许自己去翻 `detail.payload`**：payload 是各 kind 各样的结构化原料，
   * 一旦渲染层开始读它，"这张卡长什么样"就又散回六端各写一遍了（见 `layout` 那条）。
   * 别的卡没有它。
   */
  change_kind?: string
  status: ApprovalState
  /** 由 risk_class + expires_at + 14 §8 排序算出 */
  priority_band: PriorityBand
  /** 14 §2 的三档优先级，排序第三顺位要用（KefuAgent `compareInboxQueueCards`） */
  priority: ApprovalItem['priority']
  risk_class: RiskClass
  title: string
  /** = `content_variants.zh_summary`；老调用方还在读它，所以不删 */
  summary: string
  /** 37 §1 第 4 行：一次只显示一种，队列级切换 */
  content_variants: DeckContentVariants
  position_id: PositionId
  role_id: RoleId
  /** 37 §1 第 2 行：**不进标签行**；只在详情与筛选里用 */
  customer_label?: string
  channel?: 'email' | 'chat' | 'system'
  /** 37 §2.2b：卡片是指向事项的指针；有它就在卡面顶部出「属于：事项 X」 */
  matter_id?: string
  /** 卡挂在哪条待办下（37 §2.1 交点一） */
  todo_id?: string
  matter_label?: string
  source: DeckSource
  highlights: DeckHighlight[]
  evidence_chips: DeckEvidenceChip[]
  entity_chips: DeckEntityChip[]
  available_actions: DeckAction[]
  /** 服务端给动词（outbound_draft 是「发送」而不是「批准」） */
  action_labels?: Partial<Record<DeckAction, string>>
  /** 选择题卡才有 */
  options?: DeckOption[]
  detail: DeckDetail
  dedupe_key: string
  expires_at?: Iso8601
  snoozed_until?: Iso8601
  snooze_count: number
  /** 同类合并后代表这一组的张数；1 = 没合并（37 §1 第 2 行的「合并 N 张」） */
  merge_count: number
  /** 合并进来的成员（含代表自己）：动作一次落到每一条，各带各的 version */
  merged?: { id: string; version: number }[]
  /** 乐观并发：decide 带 version（= ApprovalItem.revision） */
  version: number
}

/** 按 kind 的详情 payload；结构化字段原样带出，前端只渲染。 */
export interface DeckDetail {
  payload: unknown
  precheck: ApprovalItem['evidence']['precheck']
  diff?: ApprovalItem['evidence']['diff']
  citations: { fact_card_id: string; quote: string }[]
  links: ApprovalItem['links']
  created_at: Iso8601
  updated_at: Iso8601
  /** 提议者（人 / Agent / 哨兵），界面上一行小字 */
  proposer: ApprovalItem['proposer']
  /** 37 §1 第 5 行：run id **只进详情**，不进证据芯片 */
  run_id?: string
  /** 29 §2 enrichment：以本人身份查不到展示名的 ref 丢了几条 */
  enrichment: { dropped_refs: number }
}

export interface ProjectContext {
  now: Iso8601
  position_id: PositionId
  /** ObjectRef → 人话（服务端补；前端不猜、也不查库） */
  label?: (ref: ObjectRef) => string | undefined
  /** 15 §2 的 risk_class 在账本上；投影时由宿主给，缺省按 kind 推 */
  riskClass?: (item: ApprovalItem) => RiskClass | undefined
  /** 契约的 ApprovalItem 没有 snooze 计数器（见交付报告的契约建议） */
  snoozeCount?: (item: ApprovalItem) => number
}

// ── 29 积木 / 数字块 ───────────────────────────────────────────────────

export type RangeName = 'yesterday' | 'last_7d'
export type TileFormat = 'money' | 'count' | 'percent' | 'ratio'

/**
 * 数据源（36 §3：面板 Tab 按数据源分块）。
 *
 * WP63：多一个 `reviews`（评价应用：Judge.me / Loox）。它**今天一定是没连的**——
 * 连接目录里只把它登记成"待增加"。留着这个数据源不是为了将来好接，是为了让
 * 差评表这一块在面板上**说得出那句话**：36 §3 的老规矩是缺连接器就明说，
 * 不是把这一块从面板上抹掉（抹掉了用户以为我们不管评价）。
 */
export type DataSourceId =
  | 'shop'
  | 'approvals'
  | 'ga4'
  | 'gsc'
  | 'ads'
  | 'csat'
  /** WP64（51 §2.3）：邮件营销后台（Klaviyo / Shopify Email）。 */
  | 'email_marketing'
  /** WP64（51 §2.4）：物流追踪（AfterShip / 17track）。 */
  | 'tracking'
  | 'reviews'
  /**
   * WP67（48 §5.2）：**我们自己的红人库**。永远算连上——它就在这台机器上，
   * 没有"去连接"这回事（同 `approvals`）。
   */
  | 'kol'
  /**
   * WP67（48 §5.1）：渠道那一侧（YouTube Data / IG Graph / TikTok Research /
   * FB Graph / X API）。五个连接器都还是"待增加"，所以这一块永远走"还没连"那一支。
   */
  | 'kol_channel'
  /**
   * WP72（56 §2）：**我们自己的社媒库**（帖子、排期、线程、群成员）。
   * 永远算连上——它就在这台机器上，没有"去连接"这回事（同 `kol` / `approvals`）。
   *
   * 内容日历、待发布队列、待回评论、待审入群、群发队列、转客服计数六块全走它：
   * 那些行是**我们排的、我们攒的**，平台没连也照样存在。
   */
  | 'social'
  /**
   * WP72（56 §1）：八条渠道**各一个**数据源，不是一个 `social_channel`。
   *
   * 与红人那边只有一个 `kol_channel` 的差别是真实的：红人五条职责共用一张找人清单，
   * 连哪条渠道都能往里填；社媒这九条是**九个互不相干的号**，"近 30 天表现"这一块
   * 在 Discord 连上、TikTok 没连的时候，要能分别说出"这一块有数"与"这一块去连 TikTok"。
   * 合成一个源的话，连上一条别的渠道就会把没连的那几块也点亮（36 §3 最忌讳的那种空图）。
   *
   * Facebook 群组**没有**自己的源：它没有连接器（Groups API 已停），面板上它只有
   * 我们自己库里那几块，平台那一侧的数要等 WP73 的浏览器执行器。
   */
  | 'social_meta'
  | 'social_tiktok'
  | 'social_x'
  | 'social_youtube'
  | 'social_reddit'
  | 'social_discord'
  | 'social_telegram'
  | 'social_whatsapp'
  /**
   * WP76（58 §3）：**我们自己的设计库**（需求单、brief、素材）。
   * 永远算连上——它就在这台机器上，没有"去连接"这回事（同 `kol` / `social`）。
   *
   * 出图走模型网关的**图片槽**（22），那不是一条连接：它跟着工作区的模型设置走，
   * 没有单独一张卡可连。所以设计岗位的面板上**一个渠道源都没有**——
   * 五块全走这一个。没有图片模型的时候说的那句话在卡上（58 §1），不在面板分块上。
   */
  | 'design'
  /**
   * WP77（59 §2 / §3）：**我们自己的建站库**（上一次巡检、邮件模板、已装 App）。
   * 永远算连上——它就在这台机器上，没有"去连接"这回事（同 `kol` / `social`）。
   *
   * 上线检查单上那几行是**我们自己跑出来的结论**：一个平台都没连的时候，
   * 它会照实说"这几项没读到"，而不是显示一张"去连接"的空图（36 §3）。
   */
  | 'site'
  /**
   * WP75（57 §1）：四个平台**各一个**数据源，理由与社媒那八个逐字相同——
   * 连上 Meta 不该把 Google 那一块点亮。
   *
   * 早就有的 `ads` 那个源留着不动：它喂的是首页"广告后台"那两块（旧的只读连接）。
   * 投放岗位面板上**我们自己算出来的**那几块（campaign 表、待审改动、止损记录）
   * 走的也是它——广告库是这台机器上的一张表，而不是"要去连接的一个后台"。
   */
  | 'ads_meta'
  | 'ads_google'
  | 'ads_x'
  | 'ads_tiktok'
  /**
   * WP78（60 §3）：**我们自己的公关库**（媒体名单、新闻稿、提及、外部露出）。
   * 永远算连上——它就在这台机器上，没有"去连接"这回事（同 `kol` / `social`）。
   *
   * 待发新闻稿、pitch 漏斗、外部露出记录三块全走它：那些行是**我们写的、
   * 我们攒的**，一个平台都没连也照样存在。
   */
  | 'pr'
  /**
   * WP78（60 §1 `pr.monitoring`）：**外面那一侧**（Google Alerts 的 RSS +
   * Reddit 全站搜）。
   *
   * 单列出来而不是并进 `pr`，理由与社媒那八条渠道源一样：没连的时候
   * "提及流"这一块要能照 36 §3 说"去连接页把 Google Alerts 填上"，
   * 而同一屏上的"待发新闻稿"照样有数。合成一个源的话，写了一篇稿子就会把
   * 一个根本没连的监控块点亮——36 §3 最忌讳的那种空图。
   */
  | 'google_alerts'

export interface DataSourceStatus {
  id: DataSourceId
  label: string
  connected: boolean
  /** 「查看完整报告 →」外链到对应后台 */
  report_url?: string
  /**
   * WP62（51 §1 N0 ③ / 36 §3）：**没连**与**还没做**是两回事。
   *
   * 没连 = 用户还没去连，界面出「去连接」；还没做 = 这个工作区的网站平台我们
   * 压根还没接（档案里选了 WooCommerce / Magento / 其它），这时界面该照实说
   * 那一句，而不是给一个点了也连不上的按钮。有 `note` 就显示它。
   */
  note?: string
}

export interface TileSpec {
  id: string
  label: string
  /** 命名查询名（29 §1 NamedQuery.name） */
  query: string
  format: TileFormat
  range_default: RangeName
}

/** 首页核心数据条里的一个数字块：值、环比、迷你走势（36 §3，不放图表不放表格）。 */
export interface StatTile {
  id: string
  label: string
  format: TileFormat
  source: DataSourceId
  status: 'ok' | 'not_connected'
  range: RangeName
  value?: number
  currency?: string
  previous?: number
  delta_pct?: number
  direction?: 'up' | 'down' | 'flat'
  /** 迷你走势：按天分桶，长度固定 7 */
  spark: number[]
}

export interface PositionTiles {
  position_id: PositionId
  role_id: RoleId
  role_name: string
  range: RangeName
  tiles: StatTile[]
}

// ── 命名查询 ───────────────────────────────────────────────────────────

/** 一张订单里的一行商品（44 G2：产品线要按行项目切，所以行项目得带回来）。 */
export interface OrderLineItem {
  id?: string
  product_id?: string
  variant_id?: string
  sku?: string
  title?: string
  vendor?: string
  product_type?: string
  quantity: number
  /** 这一行的小计（上游给了就用上游的，没给按单价 × 数量）。 */
  total: number
}

export interface OrderRow {
  id: string
  name: string
  email: string
  currency: string
  created_at: Iso8601
  delivered_at?: Iso8601
  total_price: number
  refunded_amount: number
  financial_status: string
  fulfillment_status: string
  /** 行项目（拉得到才有；`list_orders` 通常不给，要补一次 `get_order`）。 */
  line_items?: OrderLineItem[]
  /**
   * 44 G2：这一行是**按产品线切过**的——`total_price` 只算自己那部分行项目，
   * 整单金额在 `full_total_price`。一张混了两条产品线的订单两边都看得见，
   * 但两边的数字块各算各的那一半。
   */
  partial?: boolean
  full_total_price?: number
  /**
   * WP154：顾客第一次进店落在哪一页（Shopify 的 `landing_site`，可能只有路径）。
   * 按页面收入归因要它；上游没给就没有，**不编**。
   */
  landing_site?: string
}

/** 记录 Tab 的一行（29 role_view 的 timeline 积木）。 */
export interface RecordRow {
  id: string
  at: Iso8601
  kind: string
  title: string
  summary: string
  state: string
  ref?: ObjectRef
}

/** 一条库存行（WP63 库存告急表与「库存告急数」都从它算）。 */
export interface InventoryRow {
  /** 库存项 id（`inventory_item`），不是商品 id。 */
  id: string
  product_id?: string
  sku?: string
  title: string
  /** 可售数量。 */
  quantity: number
  location?: string
}

/** 一条评价（WP63 差评表）。评价应用连接器待增加，所以这一路今天永远是空的。 */
export interface ReviewRow {
  id: string
  product_id?: string
  product_title?: string
  author?: string
  rating: number
  body: string
  created_at: Iso8601
  /** 已经回过了没有（回过的不再进差评表）。 */
  replied?: boolean
}

/** 一篇文章 / 一个页面（WP63 内容与博客的草稿队列与近 30 天发布）。 */
export interface PostRow {
  id: string
  title: string
  /** `article`（博客）或 `page`（独立页面）。 */
  kind: 'article' | 'page'
  published: boolean
  updated_at: Iso8601
  published_at?: Iso8601
  author?: string
  /** 近 30 天的自然流量（GSC 没连就没有这一格）。 */
  clicks?: number
}

/**
 * WP67：面板五块要的那几行（48 §5.1 找人 / 建联 / 合作 / 审核 / 归因）。
 *
 * 形状是**投影**不是对象本身：找人清单要的是"名字 + 渠道 + 粉丝 + 分"，
 * 不是一整条 `PlatformAccount`；归因要的是"链接 → 点击 / 订单 / 收入"，
 * 不是 UTM 五参数。数字全是算好的（29 §1「数字不经模型手」）。
 */
export interface KolDeckData {
  /** 找人清单（已按分排序；`blocked` 有值的排在后面，见 `kol-core` 的 `rankCreators`）。 */
  discovery: {
    creator_id: string
    display_name: string
    channel: string
    handle: string
    followers?: number
    score: number
    /** 数据不可信时那一句（刷粉护栏）。 */
    blocked?: string
  }[]
  /** 建联漏斗：阶段 → 人数（空的格子也在，形状不随数据变）。 */
  funnel: { stage: string; label: string; count: number }[]
  /** 进行中的合作。 */
  collaborations: {
    collaboration_id: string
    display_name: string
    channel: string
    stage: string
    stage_label: string
    budget?: number
    currency: string
  }[]
  /** 待审交付物。 */
  pending_deliverables: {
    deliverable_id: string
    display_name: string
    channel: string
    kind: string
    due_at: string
    url?: string
  }[]
  /** 归因表：一条链接一行。 */
  attribution: {
    tracked_link_id: string
    display_name: string
    channel: string
    clicks: number
    orders: number
    revenue: number
    currency: string
  }[]
  /**
   * WP117b（Luoye 待定项的默认做法）：**演练那一份单独一列**。
   *
   * 上面五块一律**不含演练数据**——漏斗与归因是拿来做判断的数，掺进 24 个
   * 合成红人之后那几个数就再也不能看了。演练开着时这一格才有值，
   * 面板上单出一块「演练漏斗」；关掉演练它就没有了（**不是 0，是没有**）。
   */
  sandbox_funnel?: { stage: string; label: string; count: number }[]
}

/**
 * WP72（56 §2）：社媒面板那几块要的行（内容组四块 + 社群组五块）。
 *
 * 形状是**投影**不是对象本身（同 `KolDeckData`）：内容日历要的是"哪个号、什么时候、
 * 正文头一句"，不是一整条 `SocialPost`；活跃度要的是三个数，不是一份成员名册。
 * 数字全是算好的（29 §1「数字不经模型手」），拿不到的一律没有这一格——**不补 0**：
 * "这个平台不给这个数"与"这个数是 0"在面板上必须分得开。
 *
 * 每一行都带 `channel`：九条职责共用同一份投影，面板那一层按自己那条渠道筛
 * （`socialChannelOfRole(ctx.role_id)`），不是算九遍。
 */
/**
 * WP77（59 §3）：建站面板那五块。
 *
 * 五块全走 `site` 这个源（我们自己的库，永远算连上）：上线检查单上那几行是
 * **我们自己跑出来的结论**，一个平台都没连的时候它会照实说"这几项没读到"，
 * 而不是显示一张"去连接"的空图（36 §3）。
 */
export interface SiteDeckData {
  /** 上线检查单：一格一行。`state` 原样端出去，缺项与"没读到"在界面上是两种颜色。 */
  checklist: {
    id: string
    title: string
    state: 'ok' | 'missing' | 'unknown'
    severity: 'blocker' | 'warning'
    detail: string
    fix: string
    /** `false` = 建站岗位补不了（支付 / 税，51 §3 N2）。那一行的"怎么补"写的是去后台。 */
    fixable: boolean
  }[]
  /** 上一次巡检什么时候跑的。没跑过就没有——**不现算一份**。 */
  checked_at?: string
  /** 主题副本与预览。`role` 只有 `live` / `copy` 两种（临时主题不摆上面板）。 */
  themes: {
    theme_id: string
    name: string
    role: string
    /** 12 §2「预览链接就是审批材料」：没有它的副本发布卡提不出去。 */
    preview_url?: string
    updated_at?: string
  }[]
  /** 已装 App。目录里没有的那些也在里面（`known: false`）——看不见比看得见危险。 */
  apps: {
    app_id: string
    name: string
    installed: boolean
    known: boolean
    /** 装上了但那张"待增加"的卡还没连（59 §2 那条接缝）。 */
    connectable: boolean
  }[]
  /** 邮件模板状态。**正文一个字都不端上来**：它是外部文本，而且长（21 §1）。 */
  email_templates: {
    notification_type: string
    name: string
    enabled: boolean
    /** 缺几个必需变量（不是缺哪几个——那在卡里面）。 */
    missing_variables: number
    /** 有一份还没批下来的草稿。 */
    has_draft: boolean
  }[]
}

/**
 * WP75（57 §3）：投放面板那九块要的投影。
 *
 * 四条平台职责共用这一份（骨架相同，57 §1），面板那一层按自己那个平台筛
 * （`adsPlatformOfRole(ctx.role_id)`），不是算四遍。
 *
 * 三件事在这份形状里定死：
 *
 * 1. **每一行都带 `platform`**（同 `SocialDeckData` 的 `channel`）。
 * 2. **两个口径两列**（{@link AdsDeckData.attribution}）——面板上并排摆着，
 *    差多少一眼看得见；`gap_pct` 是算给人看的，不是修正值。
 * 3. **总闸那一格带着"哪个平台还没拉到数"**：不说的话，"还剩 800"会让人
 *    以为很宽裕，而真相是有两个平台压根没数。
 */
export interface AdsDeckData {
  /** 今日花费与总闸（一个岗位一份，不是一个平台一份——钱只有一份）。 */
  spend_gate: {
    /** 四个平台加起来今天花了多少。 */
    spent: number
    /** 岗位级总闸那个数（57 §6 默认 1000）。 */
    cap: number
    /** 还剩多少（已经负了就是负数：面板上那一格要显示真实差额）。 */
    remaining: number
    currency?: string
    /** 各平台今天各花了多少（点开看的就是这几行）。 */
    by_platform: { platform: string; spend: number; observed_at?: string }[]
    /** 哪几个平台今天还没拉到数（按 0 算了，但要说出来）。 */
    missing: string[]
  }
  /** campaign 表：一条一行。 */
  campaigns: {
    campaign_id: string
    platform: string
    account: string
    name: string
    status: string
    daily_budget?: number
    spend?: number
    roas?: number
    conversions?: number
    observed_at?: string
  }[]
  /** 待审改动**四条车道**（57 §3：预算 / 出价 / 新建 / 素材各一条）。 */
  pending: {
    approval_id: string
    platform: string
    /** 哪条车道（`budget` / `bid` / `campaign` / `creative`）。 */
    lane: string
    target: string
    /** 一句话摘要（卡面上那一句，原样端出去）。 */
    summary: string
    created_at?: string
  }[]
  /** 止损记录：自动停过哪些、为什么。 */
  stop_losses: {
    campaign_id: string
    platform: string
    name: string
    at: string
    roas?: number
    spend?: number
    daily_budget?: number
    /** 判据那句话（`ads-core` 的 `stopLossVerdict.reason`，原样）。 */
    reason: string
  }[]
  /** 像素健康：一条事件一行。 */
  pixels: {
    pixel_id: string
    platform: string
    event_name: string
    status: string
    count_24h?: number
    last_fired_at?: string
    note?: string
    observed_at?: string
  }[]
  /** 归因两列（文件头第 2 条）。 */
  attribution: {
    platform: string
    campaign: string
    platform_conversions?: number
    order_conversions?: number
    platform_roas?: number
    order_roas?: number
    /** 差多少（给人看的一个数，**不是**修正值）。 */
    gap_pct?: number
    observed_at?: string
  }[]
  /** 归不上的订单数（面板上那一行"对不上的"）。 */
  unmatched_orders?: number
  /** 今天的转化数（平台口径合计）。 */
  conversions_today?: number
  /** 今天止损了几次。 */
  stop_loss_count?: number
}

export interface SocialDeckData {
  /** 内容日历：排好期的与已发的，按时间正序。 */
  calendar: {
    post_id: string
    channel: string
    account: string
    kind: string
    status: string
    scheduled_at?: string
    /** 已经发出去的那一刻（`status: 'published'` 才有）。 */
    published_at?: string
    excerpt: string
    /** 平台退回来的原话（`status: 'failed'` 才有）。原样显示，不翻译成"出错了"。 */
    failure_reason?: string
  }[]
  /** 待发布队列：草稿与排期，最急的在最上面。 */
  queue: {
    post_id: string
    channel: string
    account: string
    status: string
    scheduled_at?: string
    excerpt: string
  }[]
  /** 近 30 天表现：只算已发的。 */
  performance: {
    post_id: string
    channel: string
    account: string
    published_at?: string
    excerpt: string
    impressions?: number
    views?: number
    likes?: number
    comments?: number
    new_followers?: number
    /** 这份数字什么时候看到的（没有它的行等于没有数）。 */
    observed_at?: string
  }[]
  /** 待回评论（评论区那一面）。 */
  pending_comments: SocialThreadRow[]
  /** 待处理帖子与私信（群里那一面）。 */
  pending_threads: SocialThreadRow[]
  /** 待审入群。 */
  pending_members: {
    member_id: string
    channel: string
    account: string
    handle: string
    display_name?: string
    applied_at?: string
    /** 申请答案**只报条数**：原文是外部文本，不往面板上端（21 §1）。 */
    answers: number
  }[]
  /** 活跃度：一个号一行。三个数不合成"健康分"——合了没人答得上哪儿不对。 */
  activity: {
    account_id: string
    channel: string
    account: string
    member_count?: number
    followers?: number
    active_7d: number
    pending_members: number
    open_threads: number
    observed_at: string
  }[]
  /** 群发队列（受众数从账号的成员数来；抑制剔除数由群发那一跳算完写在卡上）。 */
  broadcasts: {
    post_id: string
    channel: string
    account: string
    scheduled_at?: string
    excerpt: string
    audience?: number
  }[]
  /** 转客服：判成客户问题、已经出了卡的那些（56 边界行）。 */
  handoffs: (SocialThreadRow & { status: string; approval_id?: string })[]
}

/**
 * WP78（60 §3）：公关面板那五块要的行。
 *
 * 形状是**投影**不是对象本身（同 `KolDeckData` / `SocialDeckData`）：提及流要的是
 * "谁在哪儿说了什么、什么情绪、归谁"，不是一整条 `Mention`。数字全是算好的
 * （29 §1「数字不经模型手」），拿不到的一律没有这一格——**不补 0**。
 *
 * 每一行都带 `role_id` 或不带：四条职责共用同一份投影，面板那一层按职责挑块
 * （`blocksForRole`），**不在这里按职责切**——切了就得算四遍。
 */
export interface PrDeckData {
  /** 提及流（按情绪；最新的在最上面）。 */
  mentions: PrMentionRow[]
  /** 负面预警：判成舆情且情绪是负面的那些，**按被转了几次排**。 */
  negative_alerts: (PrMentionRow & { seen_count?: number })[]
  /** 待发新闻稿：草稿与批过还没发的。 */
  releases: {
    release_id: string
    status: string
    headline: string
    /** 正文里引了几张事实卡（"这篇稿子的数有没有出处"那一列）。 */
    facts_cited: number
    /** 正文里一共有几个数字。两个数不等 = 有数没出处。 */
    figures: number
    embargo_until?: string
    updated_at: string
  }[]
  /** pitch 漏斗：六个阶段各有几个人（没有人的那一档也出一行）。 */
  pitch_funnel: { stage: string; label: string; count: number }[]
  /** 外部露出记录与反馈（Reddit / 论坛）。 */
  external_posts: {
    post_id: string
    platform: string
    venue: string
    status: string
    excerpt: string
    /** 版规检查过了没有、拦下来的理由（原样，与 guardrail 那一侧同一个字符串）。 */
    rules_ok: boolean
    rules_reasons?: string
    published_at?: string
    score?: number
    replies?: number
    removed?: boolean
  }[]
  /** 转客服：判成客户问题、已经出了卡的那些（60 分界行）。 */
  handoffs: (PrMentionRow & { approval_id?: string })[]
}

/** 一条提及在面板上的样子（提及流 / 负面预警 / 转客服三块共用）。 */
export interface PrMentionRow {
  mention_id: string
  source: string
  origin: string
  url: string
  /** 标题或正文头一句。**原样截断，不改写**（外部文本，21 §1）。 */
  excerpt: string
  author?: string
  published_at: string
  sentiment?: string
  triage?: string
  status: string
}

/** 一条线程在面板上的样子（待回评论 / 待处理帖子 / 转客服三块共用）。 */
export interface SocialThreadRow {
  thread_id: string
  channel: string
  account: string
  surface: string
  author: string
  excerpt: string
  created_at: string
  /** 分类结论（六类之一，`social-core` 的 `triage` 判的）。没判过就没有。 */
  triage?: string
}

/**
 * WP76（58 §3）：设计岗位面板那五块要的投影。
 *
 * 宿主（`apps/server/src/design.ts` 的 `designDeckData`）从三张表里读出来递进来；
 * deck 这一层**不认识库**（29 §1），拿到的已经是算好的行。
 *
 * 两件事写在类型里：
 *
 * 1. **待挑与待定稿分得开**（`awaiting_pick[].stage`）。待挑 = 机器出完了在等人
 *    看一眼；待定稿 = 人已经点过「就这张」、在等那张 L1 卡。混成一块，
 *    面板上就再也看不出球在谁那儿。
 * 2. **「本周产出」数的是定稿**（`weekly.final`），出图张数只是分母
 *    （`weekly.variants`）。一天出三十张变体、一张都没定，这一周的产出是 0——
 *    把出图张数当产出的结果是这个数永远好看，而没有一张图真的上线了。
 */
export interface DesignDeckData {
  /** 需求单队列（按来源岗位；等最久的在最上面）。 */
  request_queue: {
    request_id: string
    duty: string
    /** 谁下的单（"人手动开的"也是一种来源）。 */
    from: string
    title: string
    /** 需求原文的前 60 字。**原样截断，不改写**（外部文本，21 §1）。 */
    excerpt: string
    due_at?: string
    /** 过期 = 这件事没做成，不是"逾期"——单独一格，不靠颜色表达。 */
    overdue: boolean
    created_at: string
  }[]
  /** 进行中：出了 brief、还没定稿的那些。 */
  in_progress: {
    request_id: string
    duty: string
    from: string
    title: string
    status: string
    brief_id?: string
    /** 计划出几张 / 已经出了几张（两个数分开，才看得出卡在哪一步）。 */
    planned: number
    generated: number
  }[]
  /** 待挑 + 待定稿（`stage` 分得开这两件事）。 */
  awaiting_pick: {
    asset_id: string
    duty: string
    /** 规格的中文名（认不出的原样显示 id，不丢）。 */
    spec: string
    stage: 'waiting_pick' | 'waiting_publish'
    brief_id?: string
    goal?: string
    created_at: string
  }[]
  /** 素材库：按用途分组（没打标的归「没打标」，不藏起来）。 */
  library: { use: string; count: number; final: number }[]
  /** 本周产出：`final` 是定稿数，`variants` 是出图张数（分母）。 */
  weekly: {
    since: string
    final: number
    variants: number
    by_use: { use: string; count: number }[]
  }
}

export interface QueryContext {
  now: Iso8601
  /** 工作区时区偏移（分钟），日界线按它切 */
  tz_offset_minutes: number
  base_currency: string
  role_id: RoleId
  position_id: PositionId
  orders: OrderRow[]
  approvals: ApprovalItem[]
  sources: DataSourceStatus[]
  /** WP63：库存行（拉得到才有；没有 = 库存那几块算不出来，照 36 §3 出"还没连"）。 */
  inventory?: InventoryRow[]
  /** WP63：评价行。评价应用连接器待增加，所以它今天一定是空的。 */
  reviews?: ReviewRow[]
  /** WP63：文章与页面。 */
  posts?: PostRow[]
  /**
   * WP67（48 §5.2）：红人库的五张投影（宿主从 `KolStore` 里读出来递进来）。
   *
   * 不给 = 这台机器上还没有红人岗位，五块积木一律空——**不是**"还没连"
   * （红人库永远算连上），是真的一条都没有。界面上那两句话不一样。
   */
  kol?: KolDeckData
  /**
   * WP72（56 §2）：社媒库那几张投影（宿主从 `SocialStore` 里读出来递进来）。
   *
   * 不给 = 这台机器上还没有社媒岗位，那几块一律空——**不是**"还没连"
   * （社媒库永远算连上）。界面上那两句话不一样：前者说"还没排内容，先排一条"，
   * 后者说"去连接页把 Discord 连上"。
   */
  social?: SocialDeckData
  /**
   * WP76（58 §3）：设计库那几张投影（宿主从 `DesignStore` 里读出来递进来）。
   *
   * 不给 = 这台机器上还没有设计岗位，那五块一律空——**不是**"还没连"
   * （设计库永远算连上，出图走模型网关的图片槽，那不是一条连接）。
   */
  design?: DesignDeckData
  /** WP77（59 §3）：建站面板那几块。 */
  site?: SiteDeckData
  /**
   * WP75（57 §3）：投放那几张投影（宿主从 `AdsStore` 里读出来递进来）。
   *
   * 不给 = 这台机器上还没有投放岗位，那几块一律空——**不是**"还没连"。
   * 界面上那两句话不一样：前者说"还没有广告账户，先连一个平台"，
   * 后者说"去连接页把 Google Ads 连上"。
   */
  ads?: AdsDeckData
  /**
   * WP78（60 §3）：公关库那几张投影（宿主从 `PrStore` 里读出来递进来）。
   *
   * 不给 = 这台机器上还没有公关岗位，那几块一律空——**不是**"还没连"
   * （公关库永远算连上）。界面上那两句话不一样：前者说"还没有稿子，先写一篇"，
   * 后者说"去连接页把 Google Alerts 填上"。
   */
  pr?: PrDeckData
  /**
   * WP63：这个岗位判「不正常」用的那几个数（职责 yml 的 `thresholds`）。
   *
   * 不给就用 `ANOMALY_DEFAULTS`——积木层不该因为宿主忘了传一格就算不出东西，
   * 但也不该把阈值硬写在代码里（卖家具的和卖快消的不是一个数）。
   */
  thresholds?: Record<string, number>
}

export interface ScalarResult {
  value: number
  previous: number
  delta_pct?: number
  spark: number[]
  currency?: string
}

export interface TableResult {
  columns: {
    key: string
    label: string
    align?: 'left' | 'right'
    /**
     * WP63：这一列的数怎么念。
     *
     * 不给 = 按金额（前端一直是这么干的，老积木一个字不用改）。库存件数、
     * 评分、条数这些**不是钱**——把 2 件货渲染成 `US$2.00` 不是小瑕疵，
     * 是把一句真话说成了假话。
     */
    format?: 'money' | 'count' | 'percent'
  }[]
  rows: Record<string, string | number>[]
}

export interface SeriesResult {
  x: string[]
  series: { key: string; label: string; points: number[] }[]
  currency?: string
}

export interface RecordsResult {
  rows: RecordRow[]
}

export type QueryData = ScalarResult | TableResult | SeriesResult | RecordsResult

export type QueryResult =
  | { status: 'ok'; source: DataSourceId; data: QueryData }
  | { status: 'not_connected'; source: DataSourceId }

// ── 积木与面板 ─────────────────────────────────────────────────────────

/** 29 §1 组件注册表里允许的组件名（未注册的一律拒）。 */
export type ComponentName = 'stat_tile' | 'table' | 'chart_line' | 'timeline' | 'kv' | 'markdown'

export interface BlockDef {
  id: string
  placement: 'queue' | 'alert' | 'focus' | 'digest' | 'role_view'
  component: ComponentName
  title: string
  query: string
  source: DataSourceId
  /** 面板块里的「查看完整报告 →」 */
  report_url?: string
}

export interface BlockData {
  block: BlockDef
  range: RangeName
  status: 'ok' | 'not_connected'
  payload?: QueryData
}

export interface ViewSection {
  source: DataSourceId
  label: string
  connected: boolean
  report_url?: string
  /** WP62：这个数据源"还没做"时那一句人话（见 `DataSourceStatus.note`）。 */
  note?: string
  blocks: BlockDef[]
}

// ── decide ─────────────────────────────────────────────────────────────

export type InstructionScope = 'single_reply' | 'similar_cases' | 'global_rule'

export interface DeckInstruction {
  scope: InstructionScope
  text: string
}

export interface DeckDecideInput {
  action: DeckAction
  /** 选择题卡必填 */
  selected_option_id?: string
  instruction?: DeckInstruction
  reason?: string
  edited_payload?: unknown
  defer_until?: Iso8601
  /** 乐观并发；与 card.version 不一致即 conflict */
  version?: number
}

/** 翻译成 14 §4 的 Decision（`instruct` 不是 14 的动作，见 decide.ts 的说明）。 */
export interface ResolvedDecision {
  action: 'approve' | 'approve_edited' | 'reject' | 'defer'
  reason?: string
  edited_payload?: unknown
  defer_until?: Iso8601
  instruction_scope?: InstructionScope
}

// ── 筛选与战报（37 §1 末段） ────────────────────────────────────────────

/** 等待态：客户此刻是不是坐在对面等（KefuAgent 的 waiting / nobody_waiting 两枚 chip）。 */
export type DeckWaiting = 'customer_waiting' | 'nobody_waiting'

export interface DeckFilters {
  position_id?: PositionId
  waiting?: DeckWaiting
  kind?: DeckKind
  source?: DeckSource
}

export interface DeckFilterResult {
  /** 过滤后的队列（已排序） */
  cards: DeckCard[]
  /** 被筛掉但仍要置顶提示的 P0（37：P0 永不被筛掉） */
  pinned_p0: DeckCard[]
  counts: {
    /** 按**张数**算（合并前），不是按组数 */
    total: number
    customer_waiting: number
    nobody_waiting: number
    matched: number
  }
}

/** 今日战报四格（37 §1 第 9 行；数从事件日志来，不估算）。 */
export interface BattleReport {
  /** 工作区本地日期 YYYY-MM-DD */
  date: string
  /** AI 自主处理：跑完且全程没回头问人的运行 */
  ai_handled: number
  /** 你已处理：本人做出的决定 */
  handled: number
  /** 自动发送：额度内自动批准、没经过人的 */
  auto_sent: number
  /** 拦截待确认：被拦下来转人确认的（= 建了卡） */
  intercepted: number
}

export interface HomeAssembly {
  queue: DeckCard[]
  alerts: DeckCard[]
  /**
   * WP96（09-18）：**看完即过的报表**——日报（WP63）与上线检查单（WP77）。
   *
   * 它们不再进 `queue`：队列里的每一张都该是"要你决定的"，而这两样一个决定都
   * 不要人做（36 §2）。它们照旧在账本里（14 的老规矩：Agent 主动做的每件事都
   * 进同一条账），只是投影到界面时落进岗位面板的报表块。
   */
  reports: DeckCard[]
  tiles: PositionTiles[]
  digest?: DeckCard
  estimated_minutes: number
  range: RangeName
}
