/**
 * 场景 DSL 类型（26 §1）。
 *
 * `state + events[] + expected` 的 Commerce Agents case 形状，扩展 `clock`（虚拟时间推进）、
 * `actors`（合成人策略）、`invariants`（全程不变量）、`rubric`（唯一主观键）。
 */
import type {
  ChangeKind,
  Iso8601,
  ProductLineRule,
  RangeRef,
  StorefrontPlatform,
  WorkspaceVertical,
} from '@agentsws/contracts'

/** 26 §4 三档。 */
export type Tier = 'fast' | 'realistic' | 'soak'

/** 全部六条不变量（26 §1）。 */
export const INVARIANT_NAMES = [
  'no_write_without_stage',
  'apply_only_after_approved',
  'provenance_respected',
  'fencing_covers_external',
  'prompt_replayable',
  'freeze_on_model_outage',
] as const
export type InvariantName = (typeof INVARIANT_NAMES)[number]

export interface ScenarioDataset {
  pack: string
  seed: number
  /**
   * WP54（48 v2 L2）：这条场景跑在一个「你卖的是 X」的工作区里。
   *
   * 缺省跟着 pack 的 `workspace.yml` 走（既有 pack 一个字节不变，全是实物）。
   * 写了就**只对这条场景**覆盖——一个 pack 的数据（人、店、订单）在两个垂直下
   * 复用，不用为了一条回归题再生成一整套合成公司。
   */
  vertical?: WorkspaceVertical
  /**
   * WP62（51 §1 N0）：这条场景跑在一个「网站是用 X 搭的」工作区里。
   *
   * 与 `vertical` 同一个套路：缺省跟着 pack 的 `workspace.yml`（既有 pack 全是
   * Shopify，一个字节不变），写了就**只对这条场景**覆盖——同一份合成公司在
   * 两个平台下复用，不为一条回归题再生成一整套。
   */
  storefront_platform?: StorefrontPlatform
}

/** 合成人策略：`always_approve` / `edit_Npct` / `reject_rules` / `slow`（26 §3）。 */
export interface ScenarioActor {
  /** `always_approve` | `edit_30pct` | `reject` */
  policy: string
  /** `'2h..8h'` / `'0m'`；不给就当场决定。 */
  latency?: string
  reject_rules?: string[]
  lane?: 'mine' | 'scope' | 'unclaimed'
}

export interface ScenarioStandIns {
  provider: 'mock_open_connector'
  model: 'stub' | 'replay' | 'real'
  clock: 'virtual'
  delivery: 'inbox'
}

/** `at` 是相对开钟时刻的偏移（`+65m` / `+1d`）或绝对 ISO-8601。 */
/** 40 §3.1：建一条待办，撞上了怎么办。 */
export interface ScenarioWorkTodo {
  /** 谁记的（`people.yml` 里的 person id） */
  who: string
  title: string
  /** 主题对象：订单号（撞车第一把钥匙） */
  order?: string
  /** 撞上了怎么办；不给就是「先查」——撞了这一条就建不成 */
  collision?: 'join' | 'handoff' | 'force'
  /** `force` 要写的那句区别 */
  distinct_reason?: string
}

/** 40 §3.2：一条还没有主人的活。 */
export interface ScenarioWorkPool {
  title: string
  /** 从哪来（会议 / 计划 / 告警…），默认 `meeting` */
  source?: string
}

/** 40 §3.2：谁点了「我来」。按标题找那条活。 */
export interface ScenarioWorkClaim {
  who: string
  title: string
}

/** 40 §3.5：跑一次闲置回收。 */
export interface ScenarioWorkIdle {
  /** 认领后几天没动就提醒 / 回池；不给按 `@agentsws/work` 的缺省 */
  idle_days?: number
}

/** WP39：本人改一格公开级别（41 §1.3）。 */
export interface ScenarioSecretaryProfile {
  who: string
  /** `positions` / `ranges` / `in_progress` / `availability` / `agenda_detail` / `skills` / `contact` */
  field: string
  /** `self` / `colleagues` / `workspace` */
  level: string
}

/** WP39：谁问了谁的秘书。 */
export interface ScenarioSecretaryAsk {
  who: string
  /** 被问的人 */
  about: string
  question: string
}

/** WP39：向对方秘书发一张「约时间」卡。`slot` 是绝对 ISO-8601（场景的钟是固定的）。 */
export interface ScenarioSecretaryMeet {
  who: string
  with: string
  slot: string
  minutes?: number
  title?: string
}

/** WP39：对方（他的秘书按他的规则）答那张卡。 */
export interface ScenarioSecretaryDecide {
  who: string
  action: 'accept' | 'decline'
}

/** WP39：把一件事丢给秘书，让它判断该谁做。 */
export interface ScenarioSecretaryRoute {
  who: string
  text: string
}

/* ── WP69（54）：岗位是任务主入口 ─────────────────────────────────────── */

/** WP69：把一个岗位模板的默认职责一次挂给一个人（46 §1 ③「勾岗位 = 职责全勾」）。 */
export interface ScenarioPositionStaff {
  who: string
  position: string
}

/** WP69：交给一个岗位一件事（岗位内路由挑职责 → 用那条职责的分配起 Run）。 */
export interface ScenarioPositionOpen {
  who: string
  position: string
  text: string
}

/** WP44：运营 Agent 改一件商品的价（先查文档 → 过官方 GraphQL 校验 → 提一条变更）。 */
export interface ScenarioShopPriceChange {
  who: string
  product: string
  price: number
  /** 故意写错的 GraphQL（回归"官方校验挡幻觉"用）；不给就按官方名字生成一段。 */
  graphql?: string
  note?: string
}

/** WP44：把主题工作副本推成一份**未发布**主题（造预览，线上不动）。 */
export interface ScenarioShopThemePush {
  who: string
  name: string
}

/** WP44：提一条"把这份副本发布上线"的变更（`publish_theme`，永远 L1）。 */
export interface ScenarioShopThemePublish {
  who: string
  /** 要发布哪一份；不给就是最近推上去的那一份。 */
  theme?: string
  /**
   * 提案时报的自动化等级。默认按职责的生效配置走（L1）。
   *
   * 场景填 `L3` 是**故意**的：等于有人在设置里把"发布主题"开到了全自动。
   * 15 §2 的 hard_ceiling 应当当场把它拉回人审——这条题要钉的就是这一下。
   */
  level?: 'L1' | 'L2' | 'L3'
}

/** WP77（59 §2）：跑一次上线检查单（只读巡检，出一张 L3 的卡）。 */
export interface ScenarioSiteChecklist {
  who: string
}

/** WP77（59 §2）：改一份通知邮件模板（草稿 L2 / 启用 L1；缺变量 guardrail 当场 block）。 */
export interface ScenarioSiteEmailTemplate {
  who: string
  /** Shopify 的通知类型 handle（`order_confirmation` …）。 */
  notification_type: string
  subject: string
  /** Liquid 正文。故意少写一个必需变量就是在验"缺变量拦得住"。 */
  body: string
  /** `true` = 提的是"以后就发这一份"。 */
  enabled: boolean
  /**
   * 提案时报的自动化等级。场景填 `L3` 是**故意**的：等于有人把"改模板"开到了全自动。
   * 启用那一档由 guardrail 按 `after.enabled` 拉回人审——这条题要钉的就是这一下。
   */
  level?: 'L1' | 'L2' | 'L3'
}

/** WP77（59 §2）：提一条装 / 卸 App（`app_install`，永远 L1）。 */
export interface ScenarioSiteAppInstall {
  who: string
  app: string
  operation?: 'install' | 'uninstall'
  reason?: string
  /** 故意报高的等级；hard_ceiling 会把它拉回人审（回归用）。 */
  level?: 'L1' | 'L2' | 'L3'
}

/** WP64 / 51 §2.4：跑一次超期未发的巡检（读订单 → 出异常 → 通知到人）。 */
export interface ScenarioFulfillmentSweep {
  who: string
}

/** WP64 / 51 §2.4：标记发货 + 回填单号（`create_fulfillment`，L2）。 */
export interface ScenarioFulfillmentShip {
  who: string
  /** 哪张单；不给就挑巡检里压得最久的那一张。 */
  order?: string
  carrier: string
  tracking: string
  /** 故意报的等级（默认按职责的生效配置走）。 */
  level?: 'L1' | 'L2' | 'L3'
}

/** WP64 / 51 §2.3：某个顾客点了退订（世界里发生的一件事，不是场景递答案）。 */
export interface ScenarioEmailUnsubscribe {
  email: string
}

/** WP64 / 51 §2.3：提一条群发（`campaign_send`，发送永远 L1）。 */
export interface ScenarioEmailCampaignSend {
  who: string
  campaign: string
  note?: string
  /**
   * 提案时报的自动化等级。默认按职责的生效配置走（L1）。
   *
   * 场景填 `L3` 是**故意**的：等于有人在设置里把"群发"开到了全自动。
   * 15 §2 的 hard_ceiling 应当当场把它拉回人审——这条题要钉的就是这一下。
   */
  level?: 'L1' | 'L2' | 'L3'
}

/** WP47 / 44 G1：建或改一个品牌（范围组）。改成员会重算挂了它的岗位范围并留痕。 */
export interface ScenarioOrgRangeGroup {
  id: string
  name: string
  members: RangeRef[]
}

/** WP47 / 44 G2：建或改一条产品线。 */
export interface ScenarioOrgProductLine {
  id: string
  name: string
  /** 切在哪家店 / 哪个账号 / 哪个市场里面。 */
  parent: RangeRef
  rule: ProductLineRule
}

/** WP47 / 44 G3：改某人某条职责挂的范围（挑店 / 挑品牌 / 挑产品线，取并集）。 */
export interface ScenarioOrgAssignRange {
  who: string
  role: string
  ranges?: RangeRef[]
  range_groups?: string[]
}

/** WP47 / 44 G2：记一笔"这个人现在看得到哪几张订单、哪几件商品"（给 `scope_disjoint` 用）。 */
export interface ScenarioOrgScopeCheck {
  who: string
  role: string
}

/**
 * WP62 / 51 §1 N0：记一笔"在当前这个网站平台下，这个人这条职责看得见什么"。
 *
 * 一次问三处（它们必须**说同一句话**，不然用户会在三个地方读到三种解释）：
 * 岗位面板的「店铺后台」分块、查订单 / 查商品的工具、首次设置第 ④ 步的清单。
 */
export interface ScenarioOrgPlatformCheck {
  who: string
  role: string
}

/**
 * WP51 / 46 §1 ①：某一边走完首次设置的第一步。
 *
 * `side` 是这条题里给这台机器起的名字（`solo_a` / `solo_b`），与工作区 id 无关——
 * 发现阶段本来就不该出现内部 id。
 */
export interface ScenarioOrgFirstRun {
  side: string
  who: string
  legal_name: string
  domain?: string
  discoverable?: boolean
}

/** WP51 / 46 §2 I3：一边朝另一边申请加入（对方 owner 收一张 membership 卡）。 */
export interface ScenarioOrgJoinRequest {
  from: string
  to: string
  name: string
  email: string
}

/**
 * WP50 / 45 H1：某人单干时在**自己的工作区**里攒下的东西。
 *
 * 个人工作区不是另一套界面，是同一套东西换了个 `workspace_id`——所以这里能填的
 * 就是公司那边能填的（品牌 / 产品线），外加"他在自己那儿的那条岗位"。
 */
export interface ScenarioOrgPersonal {
  who: string
  /** 他自己那个工作区的 id（`ws_solo` 之类）。 */
  workspace: string
  /** 他单干时做的那条职责。 */
  role: string
  range_groups?: ScenarioOrgRangeGroup[]
  product_lines?: ScenarioOrgProductLine[]
}

/**
 * WP65 / 52 O1：在同一个组织下开一个**品牌工作区**，并往里放几样真东西。
 *
 * 「开一个品牌」= 换一个 `workspace_id`。放的那四样分属四个不同的库
 * （分配 / 卡 / 事实卡 / 店铺连接）——"两个品牌互相看不见"要是只在一个库上成立，
 * 那就不算成立。
 */
export interface ScenarioOrgBrand {
  /** 这个品牌的 `workspace_id`（`ws_brand_a` 之类）。 */
  id: string
  name: string
  who: string
  role: string
  /** 这个品牌里的一张待审卡叫什么。 */
  card?: string
  /** 这个品牌里的一条事实（知识层）。 */
  fact?: string
  /** 这个品牌连的那家店。 */
  connection?: string
  /** WP66（52 O3）：这个品牌自己那一套模型设置（"用哪家、哪个模型"）。 */
  model?: string
}

/** WP65 / 52 O2：记一笔"这个人在这个品牌里看得到什么"（四个库各问一遍）。 */
export interface ScenarioOrgBrandCheck {
  brand: string
  who: string
}

/** WP50 / 45 H2 / H3：把个人工作区并进公司，owner 逐条选。 */
export interface ScenarioOrgJoin {
  who: string
  /** 从哪个个人工作区并过来。 */
  from: string
  /**
   * owner 在对照卡上选了什么。没提到的按对照给的建议走——
   * 那也是他按下"批准"这一下带来的（45 §4：`similar` 不会自动合）。
   */
  decisions?: {
    unique_key: string
    chosen: 'merge_union' | 'adopt_company' | 'keep_both' | 'create_in_company' | 'skip'
    name_choice?: 'company' | 'personal'
  }[]
}

/** WP57 / 48 §4 #11：访客在网站聊天窗里说了一句。 */
export interface ScenarioChatMessage {
  /** 访客的外部身份（同一个值 = 同一条会话）。 */
  visitor: string
  text: string
}

/** WP57：人工接管开关。开着的时候 AI 一句都不答。 */
export interface ScenarioChatTakeover {
  /** 哪条会话；不给就是最近开的那一条。 */
  visitor?: string
  on: boolean
}

/** WP63（51 §2.1 商品管理）：上架 / 撤下。 */
export interface ScenarioShopPublishProduct {
  who: string
  product: string
  /** `true` 上架、`false` 撤下；缺省上架。 */
  publish?: boolean
  /** 故意报高的自动化等级（回归"永远人审"用）。 */
  level?: 'L1' | 'L2' | 'L3'
  note?: string
}

/** WP63（51 §2.2 内容与博客）：写 / 发一篇文章。 */
export interface ScenarioContentBlogPost {
  who: string
  title: string
  /** `true` 是"发出去"（永远人审），缺省 `false`（草稿）。 */
  publish?: boolean
  /** 改已有那篇；不给就按标题算一个稳定 id。 */
  article?: string
  body?: string
}

/** WP63（51 §2.1 数据日报）：出一张日报卡。 */
export interface ScenarioStoreDailyReport {
  who: string
}

/** WP67 / 48 §5.1：起草并提一封开发信（第一稿故意可以带承诺词）。 */
export interface ScenarioKolOutreach {
  who: string
  creator: string
  /**
   * 第一稿里模型"多写的那一段"。
   *
   * 场景写一句带承诺的话是**故意**的：禁承诺的最后一道闸在 guardrail，
   * 这条题要钉的就是那一下 block，以及打回重写之后再过一遍闸才发出去。
   */
  draft: string
}

/**
 * WP75 / 57 §1：提一条新建 campaign（`create_campaign`，**永远 L1**）。
 *
 * `level` 是**故意报高的**那一格：15 §2 的 `HARD_L1` 会把它按回人审。
 * `spend_today` 是"这个平台今天到此刻为止花了多少"——总闸判的时候四个平台
 * 加起来（04 §5 的岗位级总闸）。总闸已经满了的时候 guardrail **直接 block**：
 * 那不是"人点一下就能过"的事。
 */
export interface ScenarioAdsCampaign {
  who: string
  /** 平台 id（`meta` / `google` …，契约 `AdsPlatform`）。 */
  platform: string
  name: string
  daily_budget: number
  /** 投给谁，一句话。卡面上人要看得见。 */
  audience?: string
  /** 这个平台今天到此刻为止花了多少。 */
  spend_today?: number
  level?: 'L1' | 'L2' | 'L3'
}

/** WP75 / 57 §1：提一条改预算（`budget_change`）。超 20% 或会破总闸 → 升 L1。 */
export interface ScenarioAdsBudgetChange {
  who: string
  platform: string
  /** 改的是哪条 campaign。 */
  campaign: string
  /** 原来多少。 */
  before: number
  /** 改成多少。 */
  after: number
  spend_today?: number
  level?: 'L1' | 'L2' | 'L3'
}

/**
 * WP75 / 57 §1：提一条暂停（`pause_ad`）。
 *
 * 只有 `reason: 'stop_loss'` **且判据真的成立**才走 L3 那一档——判据由
 * `ads-core` 的 `stopLossVerdict` 按下面三格算，不是场景说了算。
 */
export interface ScenarioAdsPause {
  who: string
  platform: string
  campaign: string
  /** 封闭的一组（契约 `AD_PAUSE_REASONS`）。 */
  reason: string
  roas?: number
  spend?: number
  daily_budget?: number
  spend_today?: number
  level?: 'L1' | 'L2' | 'L3'
}

/**
 * WP75 / 57 §1：跑一次归因（**两个口径两列，永不合并**）。
 *
 * `orders` 里那几张单的 `url` 是落地页链接——`ads-core` 从它上面的 UTM 认平台与
 * campaign。没有 url、UTM 不全、或者写的是别人的口径（`utm_medium=kol`），
 * 一律进 `unmatched`：**绝不按时间窗口猜给谁**。
 */
export interface ScenarioAdsAttribution {
  who: string
  platform: string
  campaign: string
  spend?: number
  /** 平台自己报的转化数 / 转化额。 */
  platform_conversions?: number
  platform_value?: number
  orders: { id: string; url?: string; amount?: number }[]
}

/**
 * WP72 / 56 §2：提一条内容（`social_post`，**永远 L1**）。
 *
 * `level` 是**故意报高的**那一格：15 §2 的 `HARD_L1` 会把它按回人审。
 * `scheduled_at` 给了 = 到点自己出去，所以门在**排**的这一下——到点之后没有第二道门。
 */
export interface ScenarioSocialPost {
  who: string
  /** 渠道 id（`meta` / `discord` …，契约 `SocialChannel`）。 */
  channel: string
  body: string
  /** 排期时刻（ISO）。不给 = 批了就发。 */
  scheduled_at?: string
  level?: 'L1' | 'L2' | 'L3'
}

/**
 * WP72 / 56 §2 / §4：处理一条留言（评论 / 帖子 / 私信）。
 *
 * `text` 是**对方说的那句话**——它决定这条走哪一路（`social-core` 的 `triageThread`
 * 判，不是场景说了算）：判成客户问题就出转客服卡、社媒运营不答；否则按 `draft`
 * 起草一条回复，过承诺扫描。
 *
 * `draft` 可以故意写一句带承诺的话：扫到就打回重写，重写之后那一封再扫一遍才提上去。
 */
export interface ScenarioSocialReply {
  who: string
  channel: string
  /** 说话的那个人在平台上的名字。 */
  author: string
  text: string
  draft: string
  surface?: 'comment' | 'thread' | 'dm'
  level?: 'L1' | 'L2' | 'L3'
}

/**
 * WP72 / 56 §2：提一条群发（`community_broadcast`，**永远 L1** + 抑制名单必查）。
 *
 * `members` 是群里 / 名单上的全部人；**抑制名单不在这里**——它从世界里那一份
 * 退订记录来（`email.unsubscribe` 那个事件写进去的），所以"剔了几个"是真算出来的。
 */
export interface ScenarioCommunityBroadcast {
  who: string
  channel: string
  body: string
  members: string[]
  level?: 'L1' | 'L2' | 'L3'
}

/**
 * WP73 / 56 §6：批一条入群申请（`community_membership`，L2）。
 *
 * `answers` 是他在入群问题里填的那几句——**外部文本**，原样进卡（人靠它判
 * "这是不是广告号"），不进事件日志。
 */
export interface ScenarioCommunityApproveMember {
  who: string
  channel: string
  member: string
  answers?: string[]
  level?: 'L1' | 'L2' | 'L3'
}

/**
 * WP73 / 56 §6：一个管理动作（`community_moderation`）。
 *
 * 删帖 / 禁言 L2，**封禁 L1**——分档由 guardrail 按 `action` 判，不由场景说了算。
 */
export interface ScenarioCommunityModerate {
  who: string
  channel: string
  target: string
  action: 'warn' | 'delete_post' | 'mute' | 'ban' | 'permanent_ban'
  reason?: string
  level?: 'L1' | 'L2' | 'L3'
}

/** WP73 / 56 §6：改群规（`community_rules`，**永远 L1**）。 */
export interface ScenarioCommunityRulesEdit {
  who: string
  channel: string
  rules: string
  level?: 'L1' | 'L2' | 'L3'
}

/* ── WP78（60）：公共关系那三件事 ──────────────────────────────────── */

/**
 * 收一条**外面说的话**。
 *
 * `text` 决定这条走哪一路（`pr-core` 的 `triageMention` 判，场景递不进来一个
 * 结论）。判成客户问题 → 转客服卡，**公关不答**（60 分界行）。
 */
export interface ScenarioPrMention {
  who: string
  source: 'news' | 'reddit' | 'forum' | 'review' | 'social' | 'blog' | 'other'
  origin: string
  title?: string
  text: string
  author?: string
}

/**
 * 提一篇新闻稿。
 *
 * `facts_cited` 是这篇稿子声明的引用；正文里多一个没出处的数就提不上去
 * （guardrail block）。`distribute` 为真 = 要发出去 → 升 L1。
 */
export interface ScenarioPrRelease {
  who: string
  headline: string
  dek: string
  body: string
  facts_cited: { figure: string; fact_card_id: string }[]
  quotes?: { speaker: string; text: string; provided_by: string }[]
  distribute?: boolean
  level?: 'L1' | 'L2' | 'L3'
}

/**
 * 在**别人的**社区里提一条帖子。
 *
 * `rules` 是那个版的版规原文，一条一行。**不给 = 查不到规矩，按禁处理**——
 * 在别人的地盘上 fail-closed 的代价是少发一条，fail-open 的代价是被永久赶走。
 */
export interface ScenarioPrExternalPost {
  who: string
  role?: 'pr.reddit' | 'pr.forums'
  platform: string
  venue: string
  title?: string
  body: string
  rules?: string[]
  flair?: string
  /** 我们上一条在**这个版**是几小时前发的。不给 = 这一轮里没发过。 */
  last_post_hours_ago?: number
  level?: 'L1' | 'L2' | 'L3'
}

/** WP67 / 48 §5.1：建一条合作（`kol_collaboration`，**永远 L1**）。 */
export interface ScenarioKolCollaboration {
  who: string
  creator: string
  budget: number
  /** 故意报高的等级；硬顶会把它按回人审。 */
  level?: 'L1' | 'L2' | 'L3'
}

/** WP67 / 48 §5.1：建一条带联盟码的追踪链接。 */
export interface ScenarioKolTrackedLink {
  who: string
  creator: string
  code: string
}

/**
 * WP67 / 48 §5.1：有人用这个联盟码下了一单。
 *
 * 与"顾客点了退订"同一类——**世界里发生的一件事**，不是场景把答案递给 Agent。
 * 金额与币种归因那一跳自己去连接器读。
 */
export interface ScenarioKolAffiliateOrder {
  order: string
  code: string
}

/** WP67 / 48 §5.1：跑一次归因。 */
export interface ScenarioKolAttribution {
  who: string
}

/**
 * WP68 / 48 §5.2：往世界的红人库里放一个人。
 *
 * 数据写在场景里而不是藏在 world 里：campaign 挑的是谁、为什么挑他，
 * 读场景的人应该一眼看得出来。
 */
export interface ScenarioKolCreator {
  channel: string
  handle: string
  followers: number
  engagement_rate?: number
  category?: string
}

/**
 * WP68 / 48 §5.2：跑一次 campaign 向导（四格 → 挑人清单 → 按渠道建合作）。
 *
 * **不并集权限**（05 §4）：`channels` 里那个人没有对应职责的，清单上有、
 * 合作不建。这条题钉的就是这一下。
 */
export interface ScenarioKolCampaign {
  who: string
  goal: string
  budget: number
  channels: string[]
  headcount: number
}

/**
 * WP68 / 48 §5.3：往**云端公共库**里放一个人（模拟别的工作区 / 插件贡献过）。
 *
 * `email` 给了就等于库里有联系方式——`reveal` 才收得到钱；没有就不收钱。
 */
export interface ScenarioKolPublicCreator {
  channel: string
  handle: string
  followers: number
  engagement_rate?: number
  email?: string
}

/**
 * WP68 / 49 M2：开关拨到"用 agentsws 的"之后，浏览一次 + 取一次邮箱。
 *
 * 浏览免费、reveal 扣积分；余额不够回 402 与一句人话（这条题的另一半）。
 */
export interface ScenarioKolReveal {
  who: string
  channel: string
  handle: string
  /** 先给钱包充这么多积分；不给就是一分不充（用来验余额不足那一半）。 */
  topup?: number
}

export type ScenarioEvent =
  | { at: string; type: 'inbound.email'; inbound: ScenarioInbound }
  | { at: string; type: 'actor.decide'; decide: ScenarioDecide }
  | { at: string; type: 'clock.advance'; advance: Record<string, never> }
  | { at: string; type: 'inject.fault'; fault: ScenarioFault }
  | { at: string; type: 'model.outage'; outage: ScenarioOutage }
  | { at: string; type: 'inject.budget'; budget: ScenarioBudget }
  /** 25：装上「一天的例行公事」（早上计划卡 / 晚上复盘卡 / 复盘后的接力）。 */
  | { at: string; type: 'routine.start'; routine: ScenarioRoutine }
  /** WP29：装上学习回路（lesson 池 + 每天 07:30 的次日提案）。 */
  | { at: string; type: 'learning.start'; learning: ScenarioLearning }
  /** WP32 soak：跑一次对账（15 §5.8 unknown 的自动对账），soak 档每天一次。 */
  | { at: string; type: 'reconcile.run'; reconcile: Record<string, never> }
  /** WP32 soak：进程"重启"——关掉事件日志的连接再开一次，验链还完整。 */
  | { at: string; type: 'process.restart'; restart: Record<string, never> }
  /** WP38：某人记一条待办（走「建之前先查」，40 §3.1）。 */
  | { at: string; type: 'work.todo'; todo: ScenarioWorkTodo }
  /** WP38：把一条活丢进待认领池（会议 / 计划 / 告警的最小替身，40 §3.2）。 */
  | { at: string; type: 'work.pool'; pool: ScenarioWorkPool }
  /** WP38：某人点「我来」（认领即锁）。 */
  | { at: string; type: 'work.claim'; claim: ScenarioWorkClaim }
  /** WP38：跑一次闲置回收巡检（40 §3.5）。 */
  | { at: string; type: 'work.idle_sweep'; idle: ScenarioWorkIdle }
  /** WP39：本人改一格公开级别（41 §1.3）。 */
  | { at: string; type: 'secretary.profile'; profile: ScenarioSecretaryProfile }
  /** WP39：问别人的秘书（代答）。 */
  | { at: string; type: 'secretary.ask'; ask: ScenarioSecretaryAsk }
  /** WP39：约时间（撞上了不发卡，回冲突 + 替代时段）。 */
  | { at: string; type: 'secretary.meet'; meet: ScenarioSecretaryMeet }
  /** WP39：答一张「约时间」卡（点头才进双方日历）。 */
  | { at: string; type: 'secretary.meet_decide'; decide_meet: ScenarioSecretaryDecide }
  /** WP39：把一件事丢给秘书（任务路由 → 认领卡）。 */
  | { at: string; type: 'secretary.route'; route: ScenarioSecretaryRoute }
  /* ── WP69（54）：岗位是任务主入口 ── */
  /** WP69：给一个人配上一个岗位（它的默认职责全挂上）。 */
  | { at: string; type: 'position.staff'; staff: ScenarioPositionStaff }
  /** WP69：交给这个岗位一件事（路由 → 起 Run，拿不准出选择卡）。 */
  | { at: string; type: 'position.open'; open_at_position: ScenarioPositionOpen }
  /** WP44：运营改价（真读 → 官方校验 → staged price_change）。 */
  | { at: string; type: 'shop.price_change'; price_change: ScenarioShopPriceChange }
  /** WP44：推一份未发布主题副本（造预览）。 */
  | { at: string; type: 'shop.theme_push'; theme_push: ScenarioShopThemePush }
  /** WP44：提一条主题发布变更（15 §2 永远 L1）。 */
  | { at: string; type: 'shop.theme_publish'; theme_publish: ScenarioShopThemePublish }
  // WP77（59 §4）：建站那三条
  | { at: string; type: 'site.checklist'; checklist: ScenarioSiteChecklist }
  | { at: string; type: 'site.email_template'; email_template: ScenarioSiteEmailTemplate }
  | { at: string; type: 'site.app_install'; app_install: ScenarioSiteAppInstall }
  /** WP64：跑一次超期未发巡检（51 §2.4）。 */
  | { at: string; type: 'fulfillment.sweep'; sweep: ScenarioFulfillmentSweep }
  /** WP64：标记发货 + 回填单号（51 §2.4）。 */
  | { at: string; type: 'fulfillment.mark_shipped'; ship: ScenarioFulfillmentShip }
  /** WP64：某个顾客点了退订（51 §2.3）。 */
  | { at: string; type: 'email.unsubscribe'; unsubscribe: ScenarioEmailUnsubscribe }
  /** WP64：提一条群发（51 §2.3，发送永远 L1）。 */
  | { at: string; type: 'email.campaign_send'; campaign_send: ScenarioEmailCampaignSend }
  /** WP72：提一条内容（56 §2，发布永远 L1）。 */
  | { at: string; type: 'social.post'; post: ScenarioSocialPost }
  /** WP72：处理一条留言（56 §2 / §4，先判类：客户问题转客服）。 */
  | { at: string; type: 'social.reply'; reply: ScenarioSocialReply }
  /** WP72：提一条群发（56 §2，群发永远 L1 + 抑制名单必查）。 */
  | { at: string; type: 'community.broadcast'; broadcast: ScenarioCommunityBroadcast }
  | {
      at: string
      type: 'community.approve_member'
      approve_member: ScenarioCommunityApproveMember
    }
  | { at: string; type: 'community.moderate'; moderate: ScenarioCommunityModerate }
  | { at: string; type: 'community.rules_edit'; rules_edit: ScenarioCommunityRulesEdit }
  /** WP75：提一条新建 campaign（57 §1，开花钱口子永远 L1）。 */
  | { at: string; type: 'ads.campaign'; ads_campaign: ScenarioAdsCampaign }
  /** WP75：提一条改预算（57 §1，超额度或破总闸升 L1）。 */
  | { at: string; type: 'ads.budget_change'; ads_budget_change: ScenarioAdsBudgetChange }
  /** WP75：提一条暂停（57 §1，止损那一档要判据真的成立）。 */
  | { at: string; type: 'ads.pause'; ads_pause: ScenarioAdsPause }
  /** WP75：跑一次归因（57 §1，两个口径两列不合并）。 */
  | { at: string; type: 'ads.attribution'; ads_attribution: ScenarioAdsAttribution }
  /** WP78：收一条外面说的话（60，判类不是参数：客户问题转客服）。 */
  | { at: string; type: 'pr.mention'; mention: ScenarioPrMention }
  /** WP78：提一篇新闻稿（60 §2，数字没出处就 block）。 */
  | { at: string; type: 'pr.release'; release: ScenarioPrRelease }
  /** WP78：在别人的社区里提一条帖子（60 §1，**永远 L1** + 版规 + 冷却）。 */
  | { at: string; type: 'pr.external_post'; external_post: ScenarioPrExternalPost }
  /** WP67：起草并提一封开发信（48 §5.1，禁承诺由 guardrail 拦）。 */
  | { at: string; type: 'kol.outreach'; outreach: ScenarioKolOutreach }
  /** WP67：建一条合作（48 §5.1，永远 L1）。 */
  | { at: string; type: 'kol.collaboration'; collaboration: ScenarioKolCollaboration }
  /** WP67：建一条带联盟码的追踪链接（48 §5.1，L3）。 */
  | { at: string; type: 'kol.tracked_link'; tracked_link: ScenarioKolTrackedLink }
  /** WP67：有人用这个联盟码下了一单（48 §5.1）。 */
  | { at: string; type: 'kol.affiliate_order'; affiliate_order: ScenarioKolAffiliateOrder }
  /** WP67：跑一次归因（48 §5.1）。 */
  | { at: string; type: 'kol.attribution'; attribution: ScenarioKolAttribution }
  /** WP68：往世界的红人库里放一个人（48 §5.2）。 */
  | { at: string; type: 'kol.creator'; creator: ScenarioKolCreator }
  /** WP68：跑一次 campaign 向导（48 §5.2，不并集权限）。 */
  | { at: string; type: 'kol.campaign'; campaign: ScenarioKolCampaign }
  /** WP68：往云端公共库里放一个人（48 §5.3）。 */
  | { at: string; type: 'kol.public_creator'; public_creator: ScenarioKolPublicCreator }
  /** WP68：浏览公共库 + 付费取一个邮箱（49 M2 / M4）。 */
  | { at: string; type: 'kol.public_reveal'; public_reveal: ScenarioKolReveal }
  /** WP63：上架 / 撤下一件商品（51 §2.1，永远人审）。 */
  | { at: string; type: 'shop.publish_product'; publish_product: ScenarioShopPublishProduct }
  /** WP63：写 / 发一篇博客文章（51 §2.2，草稿 L2、发布 L1）。 */
  | { at: string; type: 'content.blog_post'; blog_post: ScenarioContentBlogPost }
  /** WP63：出一张店铺日报卡（51 §2.1，L3 自动出、看完归档）。 */
  | { at: string; type: 'store.daily_report'; daily_report: ScenarioStoreDailyReport }
  /** WP47：建 / 改一个品牌（44 G1；成员变了岗位范围自动跟并留痕）。 */
  | { at: string; type: 'org.range_group'; range_group: ScenarioOrgRangeGroup }
  /** WP47：建 / 改一条产品线（44 G2）。 */
  | { at: string; type: 'org.product_line'; product_line: ScenarioOrgProductLine }
  /** WP47：改某人某条职责挂的范围（44 G3）。 */
  | { at: string; type: 'org.assign_range'; assign_range: ScenarioOrgAssignRange }
  /** WP47：记一笔"他现在看得到什么"（44 G2 读那一半）。 */
  | { at: string; type: 'org.scope_check'; scope_check: ScenarioOrgScopeCheck }
  /** WP51：某一边走完首次设置（46 §1 ①：公司档案 + 发现开关）。 */
  | { at: string; type: 'org.first_run'; first_run: ScenarioOrgFirstRun }
  /** WP62：记一笔"当前平台下面板 / 工具 / 清单各说了什么"（51 §1 N0）。 */
  | { at: string; type: 'org.platform_check'; platform_check: ScenarioOrgPlatformCheck }
  /** WP51：一边朝另一边申请加入（46 §2 I3）。 */
  | { at: string; type: 'org.join_request'; join_request: ScenarioOrgJoinRequest }
  /** WP50：某人单干时在自己的工作区里攒下的东西（45 H1）。 */
  | { at: string; type: 'org.personal'; personal: ScenarioOrgPersonal }
  /** WP50：把个人工作区并进公司（45 H2 / H3）。 */
  | { at: string; type: 'org.join'; join: ScenarioOrgJoin }
  /** WP65：在同一个组织下开一个品牌工作区（52 O1）。 */
  | { at: string; type: 'org.brand'; brand: ScenarioOrgBrand }
  /** WP65：记一笔"这个人在这个品牌里看得到什么"（52 O2）。 */
  | { at: string; type: 'org.brand_check'; brand_check: ScenarioOrgBrandCheck }
  /** WP56：一个知识源（网页 / 文档）同步了一次新正文（48 §4 #6）。 */
  | { at: string; type: 'knowledge.source_sync'; source_sync: ScenarioKnowledgeSourceSync }
  /** WP57：访客在网站聊天窗里说一句（48 §4 #11 的实时车道）。 */
  | { at: string; type: 'chat.visitor_message'; chat_message: ScenarioChatMessage }
  /** WP57：人工接管这条会话（AI 停口）。 */
  | { at: string; type: 'chat.human_takeover'; chat_takeover: ScenarioChatTakeover }
  /* ── WP76（58）：设计岗位 ── */
  /** WP76：别的岗位下一张需求单（路由到设计岗 → brief L3 自动出）。 */
  | { at: string; type: 'design.request'; design_request: ScenarioDesignRequest }
  /** WP76：出变体初稿（L2 出卡给人挑；没有图片模型就只出计划并明说）。 */
  | { at: string; type: 'design.variants'; design_variants: ScenarioDesignVariants }
  /** WP76：人挑了一张 → 定稿入库卡（`asset_publish`，**L1 硬顶**）。 */
  | { at: string; type: 'design.pick'; design_pick: ScenarioDesignPick }

/**
 * WP76（58 §1）：**别的岗位**下一张需求单。
 *
 * `from` 是来源职责（`dtc.store` / `social.meta` / `kol.youtube`）——这条动作
 * 是从**那一条**分配上提的，权限与额度是它的（05 §4 不并集）。落到哪条设计
 * 职责由 `routeWithinPosition` 真判，场景不指定。
 */
export interface ScenarioDesignRequest {
  who: string
  from: string
  title: string
  /** 需求原文（**外部文本**：brief 的整理靠它，但它不当指令读）。 */
  need: string
  /** 要哪几个规格（不给就由 brief 那一跳按职责给默认那一条并记一句问）。 */
  specs?: string[]
}

/**
 * WP76（58 §1）：出变体初稿。
 *
 * `image_model: false` = 这台机器上没有图片模型——**一张图都不出，但 brief、
 * 尺寸与变体计划照样有**，那句人话进卡面（58 §1：没有就明说）。
 */
export interface ScenarioDesignVariants {
  who: string
  brief_id?: string
  /** 这次出几张（不给就按 brief 的变体计划；上限由 guardrail 按额度判）。 */
  n?: number
  image_model?: boolean
  level?: 'L1' | 'L2' | 'L3'
}

/**
 * WP76（58 §1 / 04 §6）：人点了「就这张」。
 *
 * `level` 是**故意报高的**那一格：`asset_publish` 在 `HARD_L1` 里，会被按回人审。
 * `without_pick: true` 是另一条题：**不写"谁点的"**——那时 guardrail 直接 block，
 * 因为那不是"要不要人批"，是那张卡本身不该存在。
 */
export interface ScenarioDesignPick {
  who: string
  asset_id?: string
  level?: 'L1' | 'L2' | 'L3'
  without_pick?: boolean
}

/**
 * WP56（48 §4 #6）：源页 / 文档同步了一次。
 *
 * 场景给的是**新正文**，不是"内容变了没有"——变没变由内容 hash 判，
 * 该不该惊动人由事实指纹判。两件事都在 `packages/knowledge` 里，场景不参与。
 */
export interface ScenarioKnowledgeSourceSync {
  /** 源的 ref（pack 里那条知识的出处，或 `knowledge.source_sync` 前先登记过的 url）。 */
  ref: string
  /** 这一版的正文。 */
  content: string
}

export interface ScenarioInbound {
  from: string
  /** `new` 或 `$thread`（沿用上一条线程）或线程外部 id。 */
  thread: string
  subject?: string
  /** pack 内相对路径（`fixtures/anna-return.txt`）；与 `body` 二选一。 */
  body_ref?: string
  body?: string
  message_id?: string
}

export interface ScenarioDecide {
  who: string
  /** `$last_outbound_draft` / `$last_staged_change` / `$last_skill_lesson` / 具体 approval_item id。 */
  item: string
  action: 'approve' | 'approve_edited' | 'reject'
  reason?: string
  /** 选择题卡（36 §2.1）：批准必须带一个选项 id。 */
  option?: string
}

export interface ScenarioFault {
  action: string
  code: 429 | 500 | 'timeout'
  times: number
}

export interface ScenarioOutage {
  /** `2h` / `30m`；缺省 1h。 */
  duration?: string
}

/** 25：例行公事的两个钟点（本地时区）。 */
export interface ScenarioRoutine {
  plan_hour?: number
  review_hour?: number
}

/** WP29：次日提案几点出（本地时区），缺省 07:30。 */
export interface ScenarioLearning {
  propose_hour?: number
  propose_minute?: number
}

/** 26 扩展（本包）：把模型预算压到某个值，用来跑"预算耗尽 → 熔断"。 */
export interface ScenarioBudget {
  workspace_daily_base?: number
  workspace_monthly_base?: number
  assignment_daily_base?: number
}

/**
 * WP32：这条场景要把交易控制模块的两个时限旋钮调成多少（14 §11.6 / §13.2）。
 *
 * 为什么放进场景而不是改默认：默认值就是 14 里定的那套（24 / 48 工作小时、10% 抽检），
 * 不能为了让一条回归题跑得快就把全公司的时限改了。升级链场景要在几小时内看见两级升级，
 * 就在这条场景里把它压小——**改的是配置，不是语义**。
 */
export interface ScenarioTxnPolicy {
  escalation_hours?: { scope_manager?: number; owner?: number }
  /** L2 自动批的抽检比例（0..1）。 */
  sampling_rate?: number
  /** 审批项的过期天数（`default` 或按 kind）。 */
  expiry_days?: Record<string, number>
}

/** 数值断言：裸数字 = 相等；字符串支持 `>=x` `<=x` `>x` `<x` `==x`。 */
export type NumericAssertion = number | string

export interface ScenarioApprovalItems {
  kind: string
  count?: NumericAssertion
  /** 子项的 kind 列表（父子结构，14 §12）。 */
  children?: string[]
}

export interface ScenarioExpected {
  calls_tool?: string[]
  first_tool?: string
  never_calls?: string[]
  staged_change_kinds?: ChangeKind[]
  /**
   * WP76（58 §1）：那一张需求单。
   *
   * `routed_to` 是**岗位路由真判出来的**那条设计职责（不是场景指定的）；
   * `brief_auto_approved` 为真 = brief 在 L3 上自动出了（它只产生一段给人看
   * 的文字）；`brand_system_missing` 为真 = 这家公司还没设过品牌系统，
   * 于是出了「先设品牌系统」卡（**不挡路**，但 brief 上会记一句）。
   */
  design_request?: {
    routed_to?: string
    brief_drafted?: boolean
    brief_auto_approved?: boolean
    brief_level?: string
    /** brief 整理不出来的那几件事至少有几条（**不编默认值**的证据）。 */
    questions_at_least?: number
    brand_system_missing?: boolean
  }
  /**
   * WP76（58 §1）：那一次出变体。
   *
   * `image_model` 为假时 `generated` 必须是 0，而 `reason_stated` 必须为真
   * ——58 §1 要的是"没有就明说"，不是一句"生成失败"。
   */
  design_variants?: {
    n?: number
    generated?: number
    image_model?: boolean
    reason_stated?: boolean
    auto_approved?: boolean
    level?: string
  }
  /**
   * WP76（58 §1 / 04 §6）：那一下定稿。
   *
   * `auto_approved` 永远是假（`asset_publish` 在 `HARD_L1` 里）；
   * `blocked` 为真 = 没写"谁点的"，guardrail 当场拦下。
   */
  design_pick?: {
    staged?: boolean
    auto_approved?: boolean
    level?: string
    blocked?: boolean
  }
  /** `$approve` = 第一条 `approval.decided`；断言此前没有 `change.applied`。 */
  no_applied_changes_before?: string
  approval_items?: ScenarioApprovalItems
  reply_omits?: string[]
  reply_includes_any?: string[]
  memory_contains?: string[]
  max_tool_calls?: number
  metrics?: Record<string, NumericAssertion>
  /** 26 扩展：本次模拟里 `run.failed` 的错误码集合（冻结 / 熔断场景）。 */
  run_failed_codes?: string[]
  /** 26 扩展：收到通知的人（owner 熔断通知）。 */
  notifications_to?: string[]
  /** 26 扩展：被门禁挡下的规则（`authorization_check` 等），毒样本场景断言用。 */
  blocked_rules?: string[]
  /** 25 扩展：这些类型的事件至少各出现一次（`schedule.fired` 之类）。 */
  event_types?: string[]
  /** 25 扩展：按 kind 数审批项（`daily_plan: 1`、`review: '>=1'`）。 */
  approval_kinds?: Record<string, NumericAssertion>
  /** 25 扩展：这些处理器至少各有一条定时任务（证明「接力已注册」）。 */
  scheduled_handlers?: string[]
  /**
   * WP29 扩展：最后一次运行的 prompt 里至少出现其中一条。
   * 「采纳之后下一次运行真的用了新版本」就靠它钉住。
   */
  prompt_includes_any?: string[]
  /** WP29 扩展：夜间整理被拦下的原因（`rejected_before` / `policy_layer` …）。 */
  lessons_filtered?: string[]
  /** WP29 扩展：池里 lesson 的条数。 */
  lessons_pooled?: NumericAssertion
  /** WP32 扩展：升级链上真的升到过哪几级（`scope_manager` / `owner`）。 */
  escalated_tiers?: string[]
  /** WP32 扩展：升级把卡交到了谁手上（跨岗位交接看的是**人**换了没有）。 */
  escalated_to?: string[]
  /** WP32 扩展：被抽检选中的自动批项条数。 */
  sampled?: NumericAssertion
  /** WP32 扩展：自动批（`auto_approved`）的项数——"不解锁自动执行"的反证也靠它。 */
  auto_approved?: NumericAssertion
  /** WP32 扩展：规则 judge 的分数下限（模型 judge 只报不拦，不接受断言）。 */
  judge_min_score?: number
  /**
   * WP32 扩展：这些人身上有 ≥2 个分配时，**没有任何一个分配**拿到并集权限
   * （05 §"不做跨 Assignment 并集"）。
   */
  assignments_not_unioned?: string[]
  /** WP39：秘书把事路由给了这些职责（`role_id`）。 */
  routed_to?: string[]
  /**
   * WP69（54 §2）：**岗位内路由**落到了这些职责（`role_id`）。
   * 与 `routed_to` 是两件事：那一条是秘书在全工作区里判"这属于哪个职责"，
   * 这一条是在**一个岗位的职责集合内**判"该走哪条"。
   */
  position_routed_to?: string[]
  /** WP39：代答里至少出现过这些类别（`doing` / `scope` / `busy` / `skills` / `private` / `professional`）。 */
  secretary_kinds?: string[]
  /**
   * WP47 / 44 G2：这些人（各自那一次 `org.scope_check`）看到的订单与商品**两两不相交**，
   * 而且各自都不是空的——"同一个账号的两条产品线，互相看不到对方的订单和商品"。
   */
  scope_disjoint?: string[]
  /**
   * WP62 / 51 §1 N0：这几个人（各自那一次 `org.platform_check`）在**三处**都被
   * 明确告知"这个平台还没接"——岗位面板的「店铺后台」分块、查订单 / 查商品的工具、
   * 首次设置第 ④ 步的清单（那张店铺卡干脆不出）。
   *
   * 为什么三处一起断言：选错平台这件事，用户是在哪一处撞上的说不准；
   * 只要有一处含糊其辞（给一个点了也连不上的「去连接」、或者默默回空数据），
   * 这一跳就白做了。
   */
  platform_unsupported?: string[]
  /**
   * WP64 / 51 §2.4：这一轮超期巡检应当找出几张单、最久的压了几天。
   *
   * 钉的是"**结构化字段判出来的**，不是模型说的"——`worst_days` 对得上，
   * 说明用的是订单上的 `created_at`，不是谁转述的。
   */
  overdue_orders?: { count?: NumericAssertion; worst_days?: NumericAssertion }
  /**
   * WP64 / 51 §2.3：那一条群发提案的四件事。
   *
   * `requested_level` 报 L3 而 `auto_approved` 是假 = 硬顶把它按回人审了；
   * `suppressed_removed` + `stated_on_card` = 名单里的人被剔掉了，而且卡上说了。
   */
  campaign_send?: {
    requested_level?: string
    auto_approved?: boolean
    suppressed_removed?: NumericAssertion
    audience_size?: NumericAssertion
    stated_on_card?: boolean
  }
  /**
   * WP72 / 56 §2：那一条内容提案。
   *
   * `requested_level` 报 L3 而 `auto_approved` 是假 = 硬顶把它按回人审了。
   * `scheduled_at` 要在卡面上写出来（`stated_on_card`）——批了之后它会在那个时刻
   * 自己出去，人按下那一下之前必须看得见。
   */
  social_post?: {
    requested_level?: string
    auto_approved?: boolean
    scheduled_at?: string
    stated_on_card?: boolean
  }
  /**
   * WP75 / 57 §1：那一条新建 campaign 的提案。
   *
   * `requested_level` 报 L3 而 `auto_approved` 是假 = 硬顶把它按回人审了。
   * `blocked` 为真 = 总闸满了、连卡都没建（04 §5 熔断）——那时 `stated_on_card`
   * 说的是**拦下来那句话里有没有把数摆出来**。
   * `gate_stated_on_card` = 总闸那句话在不在卡面上（每一张投放的卡上都该有）。
   */
  ads_campaign?: {
    requested_level?: string
    auto_approved?: boolean
    blocked?: boolean
    stated_on_card?: boolean
    gate_stated_on_card?: boolean
  }
  /**
   * WP75 / 57 §1：那一条改预算。
   *
   * `within` 为假 + `caps_hit` 里有 `max_budget_delta_pct` = 超了额度、升 L1。
   * `delta_pct` 是算出来那个数（卡面上人读到的就是它）。
   */
  ads_budget?: {
    delta_pct?: NumericAssertion
    within?: boolean
    auto_approved?: boolean
    caps_hit?: string[]
    stated_on_card?: boolean
  }
  /**
   * WP75 / 57 §1 / 04 §5：那一条止损。
   *
   * `outcome` 是 `ads-core` 算的三态之一（`trigger` / `hold` / `unknown`）。
   * `auto_approved` 为真 = 止损那一档真的到了 L3；`stated_on_card` 说的是
   * **判据那句话**在不在卡面上——卡上只写"止损"的话，点头这件事就没有内容。
   */
  ads_stop_loss?: {
    outcome?: string
    requested_level?: string
    auto_approved?: boolean
    caps_hit?: string[]
    stated_on_card?: boolean
  }
  /**
   * WP75 / 57 §1：那一次归因。
   *
   * `merged` **必须是假**——两个口径合成一个数在 57 §1 里是明令禁止的；
   * 它一旦为真，这条纪律就名存实亡了（同 `community_handoff.answered_by_social`）。
   */
  ads_attribution?: {
    platform_conversions?: NumericAssertion
    order_conversions?: NumericAssertion
    unmatched?: NumericAssertion
    merged?: boolean
  }
  /**
   * WP72 / 56 §2：那一条回复。
   *
   * `triage` 是判出来的类（六类之一）。`commitment_hits` 非空 + `rewritten` 为真 =
   * 第一稿被承诺扫描拦下、打回重写过；`auto_approved` 为真 = 改写之后那一封
   * 在额度内自己发出去了。
   */
  social_reply?: {
    triage?: string
    commitment_hits?: string[]
    rewritten?: boolean
    auto_approved?: boolean
  }
  /**
   * WP72 / 56 §4：那一张转客服卡。
   *
   * `answered_by_social` 必须是假——**社媒运营不答客户的问题**，那是 56 的边界；
   * 它一旦为真，这条边界就名存实亡了。
   */
  community_handoff?: {
    triage?: string
    routed_to?: string
    answered_by_social?: boolean
    held?: boolean
  }
  /**
   * WP73 / 56 §6：那一条入群审核提案。
   *
   * `answers_on_card` 为真 = 他填的那几句在卡面上。没有它，人只看得到一个
   * 陌生 id，那就不是"审核"，是随手点两下。
   */
  community_membership?: {
    requested_level?: string
    auto_approved?: boolean
    answers_on_card?: boolean
  }
  /**
   * WP73 / 56 §6：那一个管理动作。
   *
   * `auto_approved` 在删帖 / 禁言那一档可以为真（L2 在额度内自己走），
   * 封禁那一档**永远**是假——guardrail 按 `after.action` 把它升到 L1。
   */
  community_moderation?: {
    action?: string
    requested_level?: string
    auto_approved?: boolean
  }
  /** WP73 / 56 §6：那一次群规改动（**永远 L1**，新群规正文要在卡面上）。 */
  community_rules?: {
    requested_level?: string
    auto_approved?: boolean
    stated_on_card?: boolean
  }
  /**
   * WP73 / 56 §6：那一条排期**撞车**了没有。
   *
   * `conflict_kinds` 是判出来的种类（`too_close` / `over_daily_cap` / …）；
   * `stated_on_card` 为真 = 撞车那句话真的在卡面上——只在返回值里说"撞了"
   * 而卡面上不写，等于没说。
   */
  /**
   * WP78（60 分界行）：那一条提及判成了什么、转给了谁。
   *
   * `answered_by_pr` 必须是假——**公关不答客户的问题**；它一旦为真，
   * 60 的那条分界就名存实亡了，而这几条题存在的全部理由就是钉住它。
   */
  pr_mention?: {
    triage?: string
    sentiment?: string
    routed_to?: string
    answered_by_pr?: boolean
    /** 有人真持有客服那条职责没有（没人持有 = 这张卡落到 owner 头上）。 */
    held?: boolean
    card?: string
  }
  /** WP78（60 §2）：那一篇新闻稿。`blocked` 为真 = 数字没出处 / 引语是编的。 */
  pr_release?: {
    blocked?: boolean
    /** 正文里没出处的那几个数（原样）。 */
    uncited?: string[]
    requested_level?: string
    auto_approved?: boolean
    stated_on_card?: boolean
  }
  /** WP78（60 §1）：那一条外部发帖。`blocked` 为真 = 版规不让 / 冷却没过。 */
  pr_external_post?: {
    blocked?: boolean
    rules_ok?: boolean
    /** 拦下来的理由（与 guardrail 那一侧的 hit 名逐字相同）。 */
    reasons?: string[]
    requested_level?: string
    auto_approved?: boolean
    stated_on_card?: boolean
  }
  social_calendar?: {
    conflict_kinds?: string[]
    stated_on_card?: boolean
  }
  /**
   * WP72 / 56 §2：那一条群发。
   *
   * `suppressed_removed` 查过就有一个数，**哪怕是 0**——"没查"与"查了没人"
   * 在群发这件事上必须分得开（同 `campaign_send`）。
   */
  community_broadcast?: {
    requested_level?: string
    auto_approved?: boolean
    audience?: NumericAssertion
    suppressed_removed?: NumericAssertion
    stated_on_card?: boolean
  }
  /**
   * WP67 / 48 §5.1：那一封开发信的四件事。
   *
   * `forbidden_hits` 非空 + `rewritten` 为真 = 第一稿被 guardrail 拦下来、
   * 打回重写过；`auto_approved` 为真 = 改写之后那一封在 L2 上自己发出去了。
   */
  kol_outreach?: {
    forbidden_hits?: string[]
    rewritten?: boolean
    auto_approved?: boolean
    suppressed_removed?: NumericAssertion
  }
  /**
   * WP67 / 48 §5.1：那一条合作提案。
   *
   * `requested_level` 报 L3 而 `auto_approved` 是假 = 硬顶把它按回人审了。
   */
  kol_collaboration?: {
    requested_level?: string
    auto_approved?: boolean
    budget?: NumericAssertion
  }
  /**
   * WP67 / 48 §5.1：那一次归因。
   *
   * `unmatched` 也要断言：归不上的订单**不猜**给谁，这个数不为 0 才是对的。
   */
  kol_attribution?: {
    matched?: NumericAssertion
    unmatched?: NumericAssertion
    revenue?: NumericAssertion
    basis?: string[]
  }
  /**
   * WP68 / 48 §5.2：那一次 campaign 向导。
   *
   * `picks` 是清单上一共几个人，`blocked_channels` 是**挑到了人却建不了合作**
   * 的那几条渠道——它不为空，才说明"跨渠道的清单不并集权限"真的成立
   * （05 §4）。`created` 是真建出来的合作数：只该等于 allowed 那几组的人数。
   */
  kol_campaign?: {
    picks?: NumericAssertion
    allowed_channels?: string[]
    blocked_channels?: string[]
    created?: NumericAssertion
  }
  /**
   * WP68 / 49 M2 / M4：那一次"浏览 + reveal"。
   *
   * `browse_credits` 必须是 0——**浏览免费**那句话不是文案，是账上的数。
   * `ok` 为假时 `reason` 说的是为什么（余额不够 / 库里没有联系方式），
   * 而且那一次 `reveal_credits` 也必须是 0（没取到就不收钱）。
   */
  kol_reveal?: {
    ok?: boolean
    reason?: string
    browse_credits?: NumericAssertion
    reveal_credits?: NumericAssertion
    /** 取回来的那一条在本地库里是不是只留了加密库 key 名。 */
    stored_as_ref?: boolean
    /**
     * 第一次那一下被拦下来了没有（余额不够 / 库里没有联系方式）。
     *
     * 断言里要有它，是因为 `kol_reveal` 的其余几格读的是**最后一次**——
     * 不单独钉一句，"钱不够那一半"就永远跑在一个已经充过值的钱包上，等于没测。
     */
    first_refused?: boolean
  }
  /**
   * WP57：这几轮聊天判成了哪几种动作（`answer` / `collect_info` / `human_review` /
   * `assist` / `handoff`），**按顺序**。
   *
   * 为什么是顺序而不是集合：这条流水线的价值就在顺序里——"先答了运费，再把退款
   * 转成卡"与"先转卡、再答运费"是两件完全不同的事，集合断言分不开它们。
   */
  chat_actions?: string[]
  /** WP57：求助超时各做了几次（`reminder` / `email_follow_up`）。 */
  chat_assist?: Record<string, NumericAssertion>
  /**
   * WP55 / 48 §4 L3 #2：本次模拟里入站被判成的**渠道细分**（`amazon`）。
   * 传输层仍是邮件，规则不是邮件的那一套——判错了，出站硬闸那一层根本不会被调用。
   */
  sub_channel?: string
  /**
   * WP55 / 48 §4 L3 #3：这几道 guardrail 前置门在本次模拟里**至少各判过一次
   * 「不自主」**（`fail` 或 `gate_error`）。
   *
   * 断言的是「门说了话」，不是「卡被拦了」——三道门只记录不改状态，卡照常进队列。
   */
  gates_failed?: string[]
  /**
   * WP63 / 51 §2.1：日报卡出了几张。
   *
   * 断言的是"人一下都没按就有了这张卡"——数据日报那一面没有写动作，它唯一的产出
   * 就是这张卡；要是它也要人点一下才出，这一面就白做了。
   */
  daily_reports?: NumericAssertion
  /** WP63：日报卡里那几个数（`sales` / `orders` / `low_stock` / `pending`）。 */
  daily_report_figures?: Record<string, NumericAssertion>
}

export interface Scenario {
  id: string
  version: 1
  dataset: ScenarioDataset
  actors: Record<string, ScenarioActor>
  stand_ins: ScenarioStandIns
  clock: { start: Iso8601 }
  events: ScenarioEvent[]
  expected: ScenarioExpected
  invariants: InvariantName[]
  /** 唯一主观键；交模型 judge（realistic 档有 key 时才真跑，只报不拦；26 §1）。 */
  rubric?: string
  /** WP32：这条场景要调的交易控制模块时限（升级 / 过期 / 抽检比例）。 */
  policy?: ScenarioTxnPolicy
  /** WP32：这条场景只在这些档跑（不写 = 每档都跑）。 */
  tiers?: Tier[]
  /** 隐藏场景集标记（31 §1 I9：不随 pack 发布）。 */
  hidden?: boolean
  /** 毒样本必配的 should-serve 对照场景 id（26 §2 / §6.2）。 */
  control_for?: string
  /** 场景文件的来源路径，解析时填。 */
  source?: string
}
