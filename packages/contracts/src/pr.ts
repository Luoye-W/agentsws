/**
 * 60 §1 / §2 公共关系岗位的四条职责与四个对象（WP78）。
 *
 * **公共关系 = 别人的地盘**（60 分界行，Luoye 09-17 手写四条职责之后定的那条）：
 *
 * | 谁 | 管的是 |
 * |---|---|
 * | `social.reddit`（社媒运营，56） | **我们自己的** subreddit：入群、版规、公告、删禁封 |
 * | `pr.reddit`（这里） | **别人的** subreddit：找版、读版规、在人家的版里发一条、答一条 |
 *
 * 同一条 Reddit 连接卡（`reddit`）供两条职责，与 56 §1「YouTube 一张卡管两条职责」
 * 是同一条纪律：连一次，两处都亮。写成两张卡的后果是用户连两遍、其中一遍永远显示没连。
 *
 * 四条纪律写在类型里，不写在文档里：
 *
 * 1. **新闻稿里的数字只能来自事实卡**（19 §3）。{@link PressRelease.facts_cited}
 *    是必填数组，{@link PressRelease.quotes} 的 `provided_by` 也是必填——
 *    **引语必须是人给的**，模型不编一句"我们的 CEO 说"。两条都由 guardrail
 *    在 `press_release` 那一支上兑现（`@agentsws/core` 的 `uncitedNumbers`）。
 * 2. **在别人的地盘上发东西永远人审**。{@link ExternalPost} 对应的
 *    `community_post` 在 `HARD_L1` 里：版规禁自我推广的版直接 block，
 *    同一个版 72 小时内重复发也 block——那两条不是额度，是"会被整版赶走"的事。
 * 3. **提及是外部文本**。{@link Mention.text} 与 {@link Mention.title} 进模型
 *    上下文之前要围栏（21 §1 / 39）；{@link MentionTriage} 只是**分类结论**，
 *    判成客户问题的那一条出的是转客服卡，不是一段答复（同 56 的那条边界）。
 * 4. **凭据一格都没有**。{@link MediaContact.email_ref} 是加密库里的 key 名，
 *    不是邮箱明文——与 48 §5.2 的 `CreatorContact.value_ref` 逐字同一条。
 */

import type { Iso8601, WorkspaceId } from './common.js'

/* ── 四条职责（60 §1，Luoye 09-17 手写）──────────────────────────────── */

/**
 * 四条职责各自靠什么干活。
 *
 * - `api`：走连接器 / 官方 HTTP 接口（新闻稿分发、Reddit、Google Alerts）；
 * - `browser`：官方接口没有，走第三栏受控浏览器（论坛 / Quora / 知乎）。
 *   **写动作照样先出卡**：浏览器只是手，不是授权（同 56 的 Facebook 群组）。
 */
export type PrRoleMode = 'api' | 'browser'

export interface PrRoleSpec {
  /** 职责 id（`pr.press` / `pr.reddit` / `pr.forums` / `pr.monitoring`）。 */
  role_id: string
  zh: string
  en: string
  mode: PrRoleMode
  /**
   * 这条职责要的连接器 kind（职责 yml 的 `connectors[].kind`）。
   * `undefined` = 没有连接卡（`pr.forums` 走浏览器；新闻稿分发登记在"待增加"里）。
   */
  connector_kind?: string
}

/**
 * 60 §1 那张表的机器可读版。**只有这一份**：岗位模板、`SEED_POSITIONS`、
 * 面板分块与服务进程的按职责分派都读它，谁都不许再抄一张四条职责的清单。
 *
 * 顺序 = 岗位模板里的摆法（Luoye 原话的顺序：新闻稿、Reddit、论坛、品牌监控）。
 */
export const PR_ROLES: readonly PrRoleSpec[] = [
  { role_id: 'pr.press', zh: '新闻稿', en: 'Press Releases', mode: 'api' },
  {
    role_id: 'pr.reddit',
    zh: 'Reddit 营销',
    en: 'Reddit Marketing',
    mode: 'api',
    // 56 §1 那张 `reddit` 卡，**不新建一张**（文件头第二段）
    connector_kind: 'reddit',
  },
  { role_id: 'pr.forums', zh: '论坛营销', en: 'Forum Marketing', mode: 'browser' },
  {
    role_id: 'pr.monitoring',
    zh: '品牌监控',
    en: 'Brand Monitoring',
    mode: 'api',
    connector_kind: 'google_alerts',
  },
]

/** 四条职责的 id，按出场顺序（`BUNDLED_ROLES` 与岗位模板读它）。 */
export const PR_ROLE_IDS: readonly string[] = PR_ROLES.map((r) => r.role_id)

/** 职责 id → 规格；不是公关职责回 `undefined`（不编造一条）。 */
export function prRoleSpec(role_id: string): PrRoleSpec | undefined {
  return PR_ROLES.find((r) => r.role_id === role_id)
}

/* ── 对象一：媒体联系人 ──────────────────────────────────────────────── */

/**
 * 一条媒体线索的类别。分开是因为**该怎么发**不一样：
 * 记者要一封短 pitch，博主要一份可直接引用的素材包，播客要一个人。
 */
export type MediaContactKind = 'journalist' | 'blogger' | 'podcast' | 'newsletter' | 'analyst'

/** 建联到哪一步了（与 48 §5.1 的建联序列同一套节奏：首封 / +3 天 / +7 天）。 */
export type MediaPitchStage = 'new' | 'pitched' | 'replied' | 'covered' | 'declined' | 'suppressed'

/**
 * 一个媒体联系人。
 *
 * **不是顾客档案，也不是红人**：红人（`kol.*`）是我们花钱请他说话，媒体是我们
 * 请他自己判断要不要写。两边的对象因此一条都不共用——`Creator` 上有粉丝数与
 * 报价，这里有的是"他写什么领域、上次写我们是什么时候"。
 */
export interface MediaContact {
  id: string
  workspace_id: WorkspaceId
  kind: MediaContactKind
  /** 人名（"张三"）。 */
  name: string
  /** 供职的媒体 / 站点（"某某科技"）。 */
  outlet: string
  /** 他的主页 / 作者页。 */
  url?: string
  /** 他写什么（"消费电子""户外装备"）。判"这条新闻该发给谁"用它。 */
  beats: string[]
  /**
   * 邮箱在**本机加密库**里的 key 名，不是明文（文件头第 4 条）。
   * 没有这一格 = 只知道有这个人，还发不出信。
   */
  email_ref?: string
  /** 脱敏形态（`a***@x.com`）：够人认出是哪一个邮箱，不足以拿去发信。 */
  email_masked?: string
  stage: MediaPitchStage
  /** 最后一次给他发信的时刻（日配额与序列节奏读它）。 */
  last_pitched_at?: Iso8601
  /** 他上一次写我们是什么时候（没写过就没有）。 */
  last_covered_at?: Iso8601
  notes?: string[]
  created_at: Iso8601
}

/* ── 对象二：新闻稿 ─────────────────────────────────────────────────── */

/**
 * 一条引语。**必须是人给的**（60 §2）。
 *
 * `provided_by` 是必填的那一格，而且它记的是**公司里的人**（`PersonId` 或一个
 * 名字），不是"模型"。一句"我们的 CEO 说这是行业的里程碑"如果是模型写的，
 * 那它既不是事实也不是引语，是编的——而它会被媒体原样登出去。
 */
export interface PressQuote {
  /** 说话的人（"王岚，Nordvolt 创始人"）。 */
  speaker: string
  text: string
  /** 谁给的这句话（工作台上那个人的 id 或名字）。**不能是 agent**。 */
  provided_by: string
  provided_at: Iso8601
}

/** 新闻稿的状态。`distributed` 与 `approved` 分得开是这套东西的全部意义。 */
export type PressReleaseStatus = 'draft' | 'approved' | 'distributed' | 'withdrawn'

/**
 * 一篇新闻稿。
 *
 * 结构化而不是一整块 markdown，是因为**每一段的规矩不一样**（60 §2）：
 * 事实段里的数字必须引事实卡、引语必须是人给的、联系方式必须是真人。
 * 揉成一段正文的话这三条一条都查不了。
 */
export interface PressRelease {
  id: string
  workspace_id: WorkspaceId
  status: PressReleaseStatus
  /** 标题。 */
  headline: string
  /** 导语（第一段，五个 W）。 */
  dek: string
  /** 事实段。里面的每一个数字都要在 {@link facts_cited} 里有出处。 */
  body: string
  /** 引语（可以有好几条；一条都没有也行——**没有比编一条好**）。 */
  quotes: PressQuote[]
  /** 「关于我们」样板段。 */
  boilerplate: string
  /** 联系方式（媒体问过来找谁）。 */
  contact: { name: string; email: string; phone?: string }
  /**
   * 正文里的数字各自出自哪张事实卡（19 §3）。
   *
   * 一条 = 一个数字与一张卡的对应。**覆盖不全就 block**：guardrail 会把正文里
   * 的数字抽出来逐个对，对不上的那一个原样报出来（"这个数字没有出处"）。
   */
  facts_cited: PressFactCitation[]
  /** 排在什么时候发（分发那一跳读它）。 */
  embargo_until?: Iso8601
  distributed_at?: Iso8601
  created_at: Iso8601
  updated_at: Iso8601
}

/** 正文里的一个数字 ↔ 一张事实卡。 */
export interface PressFactCitation {
  /** 正文里那个数字**原样**的写法（`"3,200"` / `"18%"` / `"2026-09-17"`）。 */
  figure: string
  /** 事实卡 id（`@agentsws/knowledge` 的 `FactCard.id`）。 */
  fact_card_id: string
  /** 那张卡上的原话（卡面上给人看的一行；不参与判定）。 */
  statement?: string
}

/* ── 对象三：提及 ───────────────────────────────────────────────────── */

/** 提及是从哪儿来的。 */
export type MentionSource = 'news' | 'reddit' | 'forum' | 'review' | 'social' | 'blog' | 'other'

/**
 * 情绪三档，不是五档也不是一个分数。
 *
 * 分档的唯一用途是**决定下一步**：负面要出预警卡，正面存证，中性归档。
 * 多分两档不会让任何人多做一件事，只会让"这条算轻微负面还是中性"变成一个
 * 没人答得上来的问题。
 */
export type MentionSentiment = 'negative' | 'neutral' | 'positive'

/**
 * 归类结论（**封闭**，同 56 §3 的六类那条纪律）。
 *
 * - `customer_issue` → **转客服**（`dtc.support` / `dtc.community-support`），
 *   公关不答：一条"我的单还没到"出现在 Reddit 上，它仍然是一张工单；
 * - `reputation` → 公关自己答（舆情、误解、竞品对比）；
 * - `media_inquiry` → 公关自己答（记者来问）；
 * - `praise` → 存证（以后写新闻稿、做落地页要引用）；
 * - `noise` → 归档（同名不同物、纯垃圾）。
 *
 * 判不准落 `noise`——**不猜**。多一个"疑似"的桶只会让两边都不接。
 */
export type MentionTriage = 'customer_issue' | 'reputation' | 'media_inquiry' | 'praise' | 'noise'

/** 这条提及处理到哪一步了。 */
export type MentionStatus = 'new' | 'triaged' | 'routed_to_support' | 'responded' | 'archived'

/**
 * 一条提及。
 *
 * 归一到一个对象而不是按来源分五张表：对品牌监控来说它们是同一件事——
 * 有人在外面说了我们一句，要判情绪、判归谁、然后按类走。真正不同的是
 * **回哪儿去**，那由 `source` + `url` 决定，不需要五个类型。
 */
export interface Mention {
  id: string
  workspace_id: WorkspaceId
  source: MentionSource
  /** 站点 / 版块（`r/BuyItForLife` / `news.ycombinator.com`）。 */
  origin: string
  url: string
  title?: string
  /** 正文（多数源只给一段摘要）。**外部文本**——进模型上下文前要围栏（21 §1）。 */
  text: string
  author?: string
  published_at: Iso8601
  /** 我们什么时候看到的（拉数那一跳写的）。 */
  observed_at: Iso8601
  sentiment?: MentionSentiment
  triage?: MentionTriage
  status: MentionStatus
  /** 去重键（`@agentsws/pr-core` 的 `mentionKey` 算的）。 */
  dedupe_key: string
  /** 判成客户问题之后那张转客服卡的 id。 */
  routed_approval_id?: string
  /** 出过预警卡的话，那张卡的 id。 */
  alert_approval_id?: string
}

/* ── 对象四：外部露出 ───────────────────────────────────────────────── */

/** 在别人的地盘上发的是什么。 */
export type ExternalPostKind = 'post' | 'comment' | 'answer'

/** 外部发帖的状态。`blocked` 单列：被版规拦下的那一条要看得见。 */
export type ExternalPostStatus = 'draft' | 'approved' | 'published' | 'blocked' | 'removed'

/**
 * 一条外部露出（别人的 subreddit / 论坛 / Quora 上的一条）。
 *
 * `rules_checked` 是**必填**：一条没查过版规就提上来的帖子，人在卡面上看不出
 * 它会不会让整个品牌被那个版永久封禁（60 §1 那一行"版规禁自我推广的 sub block"）。
 */
export interface ExternalPost {
  id: string
  workspace_id: WorkspaceId
  /** 哪条职责发的（`pr.reddit` / `pr.forums`）。 */
  role_id: string
  kind: ExternalPostKind
  /** 平台（`reddit` / `quora` / `zhihu` / 某个论坛的域名）。 */
  platform: string
  /** 版块 / 板块（`r/BuyItForLife`、某论坛的某个分区）。 */
  venue: string
  title?: string
  body: string
  status: ExternalPostStatus
  /** 版规检查的结论（**必填**，见接口注释）。 */
  rules_checked: ExternalPostRuleCheck
  /** 回在哪条下面（`kind: 'comment' | 'answer'` 才有）。 */
  parent_external_id?: string
  /** 平台那一侧的 id（发出去之后才有）。 */
  external_id?: string
  url?: string
  published_at?: Iso8601
  /** 露出之后的反馈（点赞 / 回复 / 被删）。拿不到的一律没有这一格，**不补 0**。 */
  feedback?: { score?: number; replies?: number; removed?: boolean; observed_at: Iso8601 }
  created_at: Iso8601
}

/** 版规检查的结论（`@agentsws/pr-core` 的 `checkSubredditRules` 算的）。 */
export interface ExternalPostRuleCheck {
  ok: boolean
  /** 拦下来的理由（`no_self_promotion` / `flair_required` / `cooldown`）。 */
  reasons: string[]
  /** 这个版要求带 flair 的话，用的是哪一个。 */
  flair?: string
  /** 检查的时刻（版规会改，所以这一格是必填的）。 */
  checked_at: Iso8601
}

/**
 * 一个版的规矩（读回来的那一份）。
 *
 * 三格都是**结构化**的，不是一段文字：60 §2 要的"可发 / 不可发 + 原因"
 * 只有在结构化之后才判得出来。原文留在 `raw_rules` 里给人看。
 */
export interface SubredditPolicy {
  /** 版名（`BuyItForLife`，不带 `r/`）。 */
  name: string
  /** 禁自我推广（多数版都有这一条，写法各式各样）。 */
  no_self_promotion: boolean
  /** 发帖必须带 flair。 */
  flair_required: boolean
  /** 允许的 flair（`flair_required` 为真时用）。 */
  flairs?: string[]
  /** 同一个人 / 同一个品牌在这个版两次发帖之间至少隔多久（小时）。 */
  cooldown_per_subreddit_hours?: number
  /** 版规原文（一条一行，原样存）。**外部文本**。 */
  raw_rules: string[]
  observed_at: Iso8601
}
