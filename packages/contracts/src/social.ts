/**
 * 56 §1 / §2 社媒运营的九条渠道与四个对象（WP72）。
 *
 * **社媒运营 = 自己的账号；红人 = 别人的账号**（56 表头那条边界）。所以这份契约
 * 与 `kol.ts` 长得像却一条都不共用：那边的主语是 `Creator`（别人），这边的主语是
 * {@link SocialAccount}（我们自己开的号）。唯一真共用的是 YouTube 那张连接卡——
 * `social.youtube` 与 `kol.youtube` 的 `connector_kind` 都是 `youtube_data`
 * （见 {@link SOCIAL_CHANNELS}），一把 key 管两条职责。
 *
 * 四条纪律写在类型里，不写在文档里：
 *
 * 1. **九条渠道之间零共享数据**（同 48 §5.1 末句）。同一个品牌在 TikTok 与在
 *    Discord 是两条 {@link SocialAccount}，各带各的粉丝数、各算各的额度。
 *    把它们挂到一起的只有 `workspace_id`——没有"跨渠道总粉丝数"这种东西，
 *    因为那个数没有任何一个平台认。
 * 2. **社群里的客户问题不归社媒运营**（56 边界行）。{@link CommunityThread.triage}
 *    是**分类结论**不是回复：判成 `customer_question` 的那一条，社媒运营出的是
 *    一张转客服卡（`dtc.community-support`），不是一段答复。分类器在
 *    `@agentsws/social-core` 的 `triage.ts`，**只有那一份**。
 * 3. **凭据不在这里**。{@link SocialAccount.connection_id} 是一条连接的 id，
 *    取 token 要经本品牌加密库；这个文件从头到尾没有一格放得下一个 token。
 * 4. **数字带观测时间**。{@link SocialAccount.observed_at} 与
 *    {@link SocialPost.metrics_observed_at} 都是必填：三周前的曝光数拿来做
 *    "近 30 天表现"，和编一个数没什么区别（同 48 §5.1 的 `observed_at`）。
 */

import type { Iso8601, WorkspaceId } from './common.js'

/**
 * 九条渠道（56 拆法那一行，Luoye 09-16 手写）。职责 id 是 `social.<channel>`
 * （下划线写成短横线：`facebook_group` → `social.facebook-group`）。
 *
 * `meta` 是**一条**不是两条：FB 主页与 IG 商业号共用同一把 Graph API token、
 * 同一套发布接口、同一个后台，拆成两条职责等于让人为同一件事连两次、批两次。
 */
export type SocialChannel =
  | 'meta'
  | 'tiktok'
  | 'x'
  | 'youtube'
  | 'facebook_group'
  | 'reddit'
  | 'discord'
  | 'telegram_group'
  | 'whatsapp'
  // ── WP191（docs/86）：只加不改 ──────────────────────────────────────
  // Luoye 09-29：Meta 下面是三个平台，拆开定义。`meta` 这一格**不删**——老工作区的
  // 帖子、账号、审批里写着它；它在 {@link SOCIAL_CHANNELS} 上标了 `superseded_by`，
  // 新建岗位不再出现，已有分配启动时迁成 facebook + instagram（docs/86 §6）。
  | 'facebook'
  | 'instagram'
  | 'threads'
  | 'linkedin'

/**
 * 两组（56 §0）。**只是模板里的摆法**，不是两种职责——骨架相同，读写不同：
 *
 * - `content`：自己的内容账号。发布、排期、回评论；**发布永远人审**。
 * - `community`：自己的社群。入群审核、群规、群发、私信；**群发永远人审**。
 */
export type SocialChannelGroup = 'content' | 'community'

/**
 * 这条渠道的接口现实（56 §1 末行：写进连接卡的准备说明）。
 *
 * - `official`：官方 API 直接可用（申请即给，或公开）；
 * - `apply`：申请制，批了才有（TikTok Content Posting API）；
 * - `paid`：官方 API 收费（X）；
 * - `template_optin`：能发，但只能按模板发、且收件人必须先 opt-in（WhatsApp）；
 * - `browser_only`：官方接口没有了，只能走受控浏览器（Facebook Group）。
 *
 * 界面上据此说人话："这条渠道要先申请"比"连接失败"有用得多（同 `KolApiAccess`）。
 */
export type SocialApiAccess = 'official' | 'apply' | 'paid' | 'template_optin' | 'browser_only'

/**
 * 怎么干活（56 §1）。
 *
 * - `api`：走连接器 / 官方 HTTP 接口；
 * - `browser`：走第三栏受控浏览器（36 §9 / 55 §3 的浏览器执行器）。
 *   **写动作照样先出卡**：浏览器只是手，不是授权。
 */
export type SocialChannelMode = 'api' | 'browser'

export interface SocialChannelSpec {
  id: SocialChannel
  /** 职责 id（`social.meta` / `social.facebook-group`）。**不由调用方现拼**。 */
  role_id: string
  /** 中文名（界面上那一个）。 */
  zh: string
  en: string
  group: SocialChannelGroup
  /** 品牌图标 id（`apps/workstation` 的 `brand-icons`）。 */
  icon: string
  api_access: SocialApiAccess
  /**
   * 这条渠道的连接器 kind（职责 yml 的 `connectors[].kind`）。
   * `undefined` = 没有连接卡（Facebook Group：Groups API 已停，见 56 §1）。
   */
  connector_kind?: string
  mode: SocialChannelMode
  /**
   * WP191（docs/86 §6）：这条渠道**已经拆成了哪几条**。有这一格 = 老渠道：
   * 数据照样读得进来（老帖子、老审批上写着它），但新建岗位不再出它，
   * 已有分配启动时迁成这几条（第一条接手原分配的 id、队列与定时任务，
   * 其余各复制一条）。只有 `meta` 有：它拆成了 `facebook` + `instagram`。
   */
  superseded_by?: readonly SocialChannel[]
  /**
   * WP191（docs/86 §4.3）：没连上 / 平台没批发布权限时，到点那条已批准的帖子
   * **变成一条「复制文案去平台发」的待办**，而不是只在日志里记一句"没发"。
   *
   * 只有 LinkedIn 有：公司主页的发帖权限要过 Community Management API 审核，
   * 多数小公司一直批不下来；而 LinkedIn 用户协议又禁止任何自动化手段代发，
   * 所以"人去发"是这条渠道的常态，不是例外。
   */
  publish_fallback?: 'manual_task'
}

/**
 * 56 §1 / §2 那两张表的机器可读版。**只有这一份**：职责 yml、连接目录、面板分块、
 * 适配器分派都读它，谁都不许再抄一张渠道清单。
 *
 * 顺序 = 岗位模板里的摆法（内容组在前，56 §0）。
 */
export const SOCIAL_CHANNELS: readonly SocialChannelSpec[] = [
  // ── 内容账号组（56 §2 上半行）────────────────────────────────────────
  {
    id: 'meta',
    role_id: 'social.meta',
    zh: 'Meta 社媒（FB 主页 + IG）',
    en: 'Meta (Page + Instagram)',
    group: 'content',
    icon: 'meta',
    // Graph API 公开可用，但发布权限要过 App Review——连上就能读，能发要审
    api_access: 'official',
    connector_kind: 'meta_graph',
    mode: 'api',
    // WP191（docs/86 §6）：拆成 FB 主页 + IG 两条（Threads 是新加的第三条，不从这里分）
    superseded_by: ['facebook', 'instagram'],
  },
  {
    id: 'tiktok',
    role_id: 'social.tiktok',
    zh: 'TikTok',
    en: 'TikTok',
    group: 'content',
    icon: 'tiktok',
    // Content Posting API 申请制（与红人那条的 Research API 不是同一个东西）
    api_access: 'apply',
    connector_kind: 'tiktok_content',
    mode: 'api',
  },
  {
    id: 'x',
    role_id: 'social.x',
    zh: 'X',
    en: 'X',
    group: 'content',
    icon: 'x',
    api_access: 'paid',
    connector_kind: 'x_api',
    mode: 'api',
  },
  {
    id: 'youtube',
    role_id: 'social.youtube',
    zh: 'YouTube',
    en: 'YouTube',
    group: 'content',
    icon: 'youtube',
    api_access: 'official',
    // **与红人岗位的 `kol.youtube` 是同一张卡**（56 §1）：一把 key 管两条职责。
    // 写成两个 kind 的后果是用户在连接页上看到两张 YouTube，连了一张另一张还说没连。
    connector_kind: 'youtube_data',
    mode: 'api',
  },
  // ── WP191（docs/86）：内容账号组末尾加四条（只加不改）─────────────────
  {
    id: 'facebook',
    role_id: 'social.facebook',
    zh: 'Facebook 主页',
    en: 'Facebook Page',
    group: 'content',
    icon: 'facebook',
    // Pages API 公开可用，发布权限（pages_manage_posts）要过 App Review
    api_access: 'official',
    // **与 IG 共用一张卡**（Luoye 09-29）：同一个 Meta 应用、同一次授权，
    // 连一次、批一次。写成两个 kind 的后果是为同一件事连两遍。
    connector_kind: 'meta_graph',
    mode: 'api',
  },
  {
    id: 'instagram',
    role_id: 'social.instagram',
    zh: 'Instagram',
    en: 'Instagram',
    group: 'content',
    icon: 'instagram',
    // instagram_content_publish 要过 App Review；API 发帖 24 小时 100 条上限
    api_access: 'official',
    connector_kind: 'meta_graph',
    mode: 'api',
  },
  {
    id: 'threads',
    role_id: 'social.threads',
    zh: 'Threads',
    en: 'Threads',
    group: 'content',
    icon: 'threads',
    // Threads API 是自己的一套授权（graph.threads.net + threads_* 权限），
    // Meta 那把主页令牌用不上——所以是自己一张卡（docs/86 §3.3）
    api_access: 'official',
    connector_kind: 'threads_api',
    mode: 'api',
  },
  {
    id: 'linkedin',
    role_id: 'social.linkedin',
    zh: 'LinkedIn',
    en: 'LinkedIn',
    group: 'content',
    icon: 'linkedin',
    // 个人号 w_member_social 自助开通；公司主页要 Community Management API 审核
    api_access: 'apply',
    connector_kind: 'linkedin_api',
    mode: 'api',
    // 批不下来是常态、用户协议又禁自动化：到点变成"复制文案去 LinkedIn 发"的待办
    publish_fallback: 'manual_task',
  },
  // ── 社群组（56 §2 下半行）───────────────────────────────────────────
  {
    id: 'facebook_group',
    role_id: 'social.facebook-group',
    zh: 'Facebook 群组',
    en: 'Facebook Group',
    group: 'community',
    icon: 'facebook',
    api_access: 'browser_only',
    // 没有 `connector_kind`：Groups API 已停（56 §1），走第三栏受控浏览器
    mode: 'browser',
  },
  {
    id: 'reddit',
    role_id: 'social.reddit',
    zh: 'Reddit',
    en: 'Reddit',
    group: 'community',
    icon: 'reddit',
    api_access: 'official',
    connector_kind: 'reddit',
    mode: 'api',
  },
  {
    id: 'discord',
    role_id: 'social.discord',
    zh: 'Discord',
    en: 'Discord',
    group: 'community',
    icon: 'discord',
    api_access: 'official',
    connector_kind: 'discord_bot',
    mode: 'api',
  },
  {
    id: 'telegram_group',
    role_id: 'social.telegram-group',
    zh: 'Telegram 群组',
    en: 'Telegram Group',
    group: 'community',
    icon: 'telegram',
    api_access: 'official',
    connector_kind: 'telegram_bot',
    mode: 'api',
  },
  {
    id: 'whatsapp',
    role_id: 'social.whatsapp',
    zh: 'WhatsApp',
    en: 'WhatsApp',
    group: 'community',
    icon: 'whatsapp',
    // 能发，但只能按模板发、收件人必须先 opt-in、且有 24h 客服窗口（56 §1）
    api_access: 'template_optin',
    connector_kind: 'whatsapp_business',
    mode: 'api',
  },
]

/** 渠道 id → 规格；不认识的回 `undefined`（不编造一条）。 */
export function socialChannelSpec(id: string): SocialChannelSpec | undefined {
  return SOCIAL_CHANNELS.find((c) => c.id === id)
}

/** 职责 id（`social.facebook-group`）→ 规格；不是社媒职责回 `undefined`。 */
export function socialChannelOfRole(role_id: string): SocialChannelSpec | undefined {
  return SOCIAL_CHANNELS.find((c) => c.role_id === role_id)
}

/** 全部渠道 id，按 {@link SOCIAL_CHANNELS} 的顺序（内容组在前）。 */
export const SOCIAL_CHANNEL_IDS: readonly SocialChannel[] = SOCIAL_CHANNELS.map((c) => c.id)

/** 这一组里的渠道（岗位模板与面板分块按它摆）。 */
export function socialChannelsOfGroup(group: SocialChannelGroup): readonly SocialChannelSpec[] {
  return SOCIAL_CHANNELS.filter((c) => c.group === group)
}

/** 九条职责的 id，按出场顺序（`packages/roles` 的 `BUNDLED_ROLES` 与岗位模板读它）。 */
export const SOCIAL_ROLE_IDS: readonly string[] = SOCIAL_CHANNELS.map((c) => c.role_id)

/**
 * WP191（docs/86 §6）：**还在用的**渠道（去掉标了 `superseded_by` 的老渠道）。
 *
 * 岗位模板、首次设置向导、新建岗位的勾选只读这一份；{@link SOCIAL_CHANNELS}
 * 仍是全表（老数据上写着 `meta`，读的时候要认得它）。
 */
export const ACTIVE_SOCIAL_CHANNELS: readonly SocialChannelSpec[] = SOCIAL_CHANNELS.filter(
  (c) => c.superseded_by === undefined,
)

/** 还在用的职责 id（岗位模板 `social-media.yml` 的顺序就是它）。 */
export const ACTIVE_SOCIAL_ROLE_IDS: readonly string[] = ACTIVE_SOCIAL_CHANNELS.map(
  (c) => c.role_id,
)

/**
 * 老渠道 → 接手它的那几条渠道（`meta` → `facebook` + `instagram`）；
 * 不是老渠道回 `undefined`。
 */
export function socialChannelHeirs(id: string): readonly SocialChannel[] | undefined {
  return socialChannelSpec(id)?.superseded_by
}

/* ── 四个对象（56 §6 WP72 那一行）──────────────────────────────────── */

/**
 * **我们自己的**一个社媒账号 / 一个社群。
 *
 * 一条渠道上可以有好几个（三个 Discord 服务器、两个 TG 群），所以 id 不是渠道名。
 * `connection_id` 指的是连接页上那一条连接；**token 不在这里**（文件头第 3 条）。
 */
export interface SocialAccount {
  id: string
  workspace_id: WorkspaceId
  channel: SocialChannel
  /** 平台上的账号名 / 群名（`@nordvolt` / `Nordvolt 桌面党`）。 */
  handle: string
  display_name: string
  url: string
  /** 平台那一侧的 id（页面 id / 频道 id / 群 id）。发布与群发按它打。 */
  external_id: string
  /** 哪条连接供它（没连上就没有；没连不等于这条账号不存在）。 */
  connection_id?: string
  followers?: number
  /** 社群组：成员数（内容组没有这一格）。 */
  member_count?: number
  /** 这份数字什么时候看到的。**必填**（文件头第 4 条）。 */
  observed_at: Iso8601
}

/** 一条内容的形态（九条渠道的并集；平台没有的形态就不出现在那条渠道上）。 */
export type SocialPostKind =
  | 'post'
  | 'image'
  | 'video'
  | 'short'
  | 'story'
  | 'thread'
  | 'poll'
  // WP191（docs/86 §3）：IG / FB 的 Reels、IG 轮播、LinkedIn 文档帖（PDF 翻页）。只加不改
  | 'reel'
  | 'carousel'
  | 'document'

/**
 * 一条帖子的状态。
 *
 * `scheduled` 与 `published` 分得开是这套东西的全部意义：内容日历看的是前者，
 * "近 30 天表现"看的是后者。`failed` 单列——平台把一条排期退回来是常事
 * （素材比例不对、标题超长），混进 `scheduled` 里就再也没人发现它没发出去。
 */
export type SocialPostStatus = 'draft' | 'scheduled' | 'published' | 'failed'

export interface SocialPost {
  id: string
  account_id: string
  channel: SocialChannel
  kind: SocialPostKind
  status: SocialPostStatus
  /** 正文（草稿期就是待审卡上那段预览）。 */
  body: string
  /** 素材引用（blob id / 外链），**不是**素材本身。 */
  media_refs?: string[]
  /** 排期时间；`published` 之后它就是"原本打算什么时候发"。 */
  scheduled_at?: Iso8601
  published_at?: Iso8601
  /** 平台那一侧的 id（发出去之后才有）。 */
  external_id?: string
  /** 平台退回来的原因（`status: 'failed'` 才有；原样显示，不翻译成"出错了"）。 */
  failure_reason?: string
  metrics?: SocialPostMetrics
  /** 这份数字什么时候看到的（有 `metrics` 就必须有它）。 */
  metrics_observed_at?: Iso8601
}

/**
 * 一条帖子的表现。
 *
 * 五个数各平台叫法不同（曝光 / 触达 / 播放），这里只按**我们**的口径取名，
 * 各渠道适配器负责翻译。拿不到的一律 `undefined`——**不补 0**：
 * "这个平台不给这个数"与"这个数是 0"在面板上必须分得开。
 */
export interface SocialPostMetrics {
  impressions?: number
  reach?: number
  likes?: number
  comments?: number
  shares?: number
  /** 视频类才有。 */
  views?: number
  /** 涨粉（这条帖子带来的；多数平台不给，所以多数时候是 `undefined`）。 */
  new_followers?: number
}

/** 社群成员的状态。`pending` = 递了入群申请还没批（待审入群那一块就是它）。 */
export type CommunityMemberStatus = 'pending' | 'active' | 'muted' | 'banned' | 'left'

/**
 * 社群里的一个人。
 *
 * **不是顾客档案**：这里只有平台那一侧的身份（`external_id` / `handle`），
 * 认不认得出他是哪个订单的买家是客服那一侧的事（`dtc.community-support`
 * 拿着转客服卡去问）。社媒运营这条职责的 scopes 里根本没有 `customer` 域。
 */
export interface CommunityMember {
  id: string
  account_id: string
  channel: SocialChannel
  external_id: string
  handle: string
  display_name?: string
  status: CommunityMemberStatus
  joined_at?: Iso8601
  /** 入群申请里他自己填的答案（有些群设了问题）。原样存，**不当指令读**。 */
  application_answers?: string[]
  /** 最后一次发言。判"活跃度"用它。 */
  last_active_at?: Iso8601
  /**
   * WP73：群里给这个人打的标签（"老客""内测""只看不说话"）。
   *
   * 群发向导的"发给带这个标签的人"读它。**不是顾客画像**——标签是运营在群里
   * 自己打的一串字，与订单、消费额、客服工单一个字都不挂钩（这条职责的 scopes
   * 里根本没有 `customer` 域，见这个接口开头那一段）。
   */
  tags?: string[]
}

/**
 * 分类的六类（56 §3 `triage.ts`，**封闭**）。
 *
 * 封闭是为了让"该谁答"这件事有唯一答案：
 *
 * - `customer_question` → **转客服**（`dtc.community-support`），社媒运营不答；
 * - `partnership` → 提示转红人营销（`kol.*`）；
 * - `praise` / `complaint` / `spam` / `other` → 社媒运营自己处理
 *   （夸要回、投诉要接住并看要不要转客服、垃圾按群规处理、其它归档）。
 *
 * 判不准就落 `other`——**不猜**。多一个"疑似客户问题"的桶只会让两边都不接。
 */
export type CommunityTriage =
  | 'customer_question'
  | 'praise'
  | 'complaint'
  | 'spam'
  | 'partnership'
  | 'other'

/** 一条讨论 / 一条评论 / 一条私信的处理状态。 */
export type CommunityThreadStatus = 'open' | 'answered' | 'routed_to_support' | 'closed'

/**
 * 社群 / 评论区 / 私信里的一条线程。
 *
 * 三处合成一个对象而不是三张表：对社媒运营来说它们是同一件事——有人说了句话，
 * 要判它属于六类里的哪一类，然后按类走。真正不同的是**回哪儿去**，
 * 那由 `channel` + `account_id` + `external_id` 决定，不需要三个类型。
 */
export interface CommunityThread {
  id: string
  account_id: string
  channel: SocialChannel
  /** 平台那一侧的 id（帖子 id / 评论 id / 会话 id）。回信按它打。 */
  external_id: string
  /** 在哪儿：群里的帖子 / 帖子下的评论 / 私信。 */
  surface: 'thread' | 'comment' | 'dm'
  author_external_id: string
  author_handle: string
  /** 正文。**外部文本**——进模型上下文前要围栏（21 §1 / 39）。 */
  text: string
  created_at: Iso8601
  status: CommunityThreadStatus
  /** 分类结论（文件头第 2 条：这是分类，不是回复）。没判过就没有。 */
  triage?: CommunityTriage
  /** 判成 `customer_question` 之后那张转客服卡的 id。 */
  routed_approval_id?: string
  /** 回过的话，回的那条在平台上的 id。 */
  reply_external_id?: string
}
