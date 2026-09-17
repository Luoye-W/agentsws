/**
 * 57 §1 投放岗位的四条平台职责与五个对象（WP75）。
 *
 * **投放 = 花钱买流量**。这条边界把它与社媒运营、红人营销分得干干净净：那两条
 * 是"我们自己的号"与"别人的号"，这一条是**广告账户**——一个独立的计费主体、
 * 一套独立的风控、一份独立的额度（04 §5）。所以这份契约与 `social.ts` / `kol.ts`
 * 一条都不共用，哪怕 Meta 那把授权在现实里可以复用（见 {@link ADS_PLATFORMS}
 * 里 `meta` 那一条的注释）。
 *
 * 五条纪律写在类型里，不写在文档里：
 *
 * 1. **额度是岗位级的，不是职责级的**。{@link AdsCaps.max_daily_spend} 是四条
 *    职责**共用的一道总闸**：Meta 花掉 800、Google 就只剩 200。写在四条 yml 的
 *    同一个 caps 名下，guardrail 按岗位聚合当日花费（`GuardrailFacts.dailySpendTotal`）。
 *    每条职责各记各的额度，等于四条一起把总闸撑爆而谁都没越自己那条线。
 * 2. **减少花钱可以自动，增加花钱不可以**（04 §5 原文）。止损暂停 L3、额度内
 *    调整 L2、**开花钱口子永远 L1**。第三条在 `HARD_L1` 里，不在职责 yml 里——
 *    yml 可以被工作区策略放宽，硬顶不行（15 §2）。
 * 3. **两个口径的归因不合并成一个数**。{@link AdAttributionRow} 有
 *    `platform_conversions` 与 `order_conversions` 两列，永远两列。平台说它带来
 *    18 单、订单表里只找得到 11 单，这两个数都是真的（归因窗口不同、跨设备、
 *    去重口径不同），合成一个"真实转化数"就是编。
 * 4. **凭据一格都没有**。{@link AdAccount.connection_id} 指的是连接页上那一条，
 *    取 token 要经本品牌加密库（WP66）。这个文件从头到尾没有一格放得下一个 token。
 * 5. **数字带观测时刻**。{@link AdMetrics} 必带 `observed_at`：三小时前的花费
 *    拿来判"总闸还剩多少"，与编一个数没什么区别——而这一个编出来的数会去批预算。
 */

import type { Iso8601, WorkspaceId } from './common.js'

/* ── 四个平台（57 拆法那一行，Luoye 09-17 手写）────────────────────── */

/**
 * 四个广告平台。职责 id 是 `ads.<platform>`。
 *
 * 为什么按平台拆而不是一条"投放"职责，理由比社媒那九条更硬（04 §5）：
 * **每个平台是一个独立的花钱账户、独立的计费与风控**，额度必须按账户设。
 * 一条"投放"职责下面管着四个账户，等于四个钱包共用一把锁。
 */
export type AdsPlatform = 'meta' | 'google' | 'x' | 'tiktok'

/**
 * 这个平台的接口现实（57 §1：写进连接卡的准备说明）。
 *
 * - `official`：官方 API，拿到 token 就能用（Meta Marketing API，权限要 App Review）；
 * - `developer_token`：要先申请一个 developer token 并过审（Google Ads）；
 * - `apply`：申请制（X Ads API）；
 * - `business_center`：要先在 Business Center 里授权（TikTok Ads）。
 *
 * 界面上据此说人话："这个接口要先申请 developer token"比"连接失败"有用得多
 * （同 `SocialApiAccess` / `KolApiAccess`）。
 */
export type AdsApiAccess = 'official' | 'developer_token' | 'apply' | 'business_center'

export interface AdsPlatformSpec {
  id: AdsPlatform
  /** 职责 id（`ads.meta`）。**不由调用方现拼**。 */
  role_id: string
  /** 中文名（界面上那一个）。 */
  zh: string
  en: string
  /** 品牌图标 id（`apps/workstation` 的 `brand-icons`）。 */
  icon: string
  api_access: AdsApiAccess
  /** 这个平台的连接器 kind（职责 yml 的 `connectors[].kind`）。 */
  connector_kind: string
  /** 这个平台的适配器在 `@agentsws/ads-core` 里有没有真调用（WP75 只做 Meta / Google）。 */
  implemented: boolean
}

/**
 * 57 §1 那张表的机器可读版。**只有这一份**：职责 yml、连接目录、面板分块、
 * 适配器分派都读它，谁都不许再抄一张平台清单。
 *
 * 顺序 = 岗位模板里的摆法（默认勾的两条在前，57 §5）。
 */
export const ADS_PLATFORMS: readonly AdsPlatformSpec[] = [
  {
    id: 'meta',
    role_id: 'ads.meta',
    zh: 'Meta Ads（Facebook / Instagram）',
    en: 'Meta Ads',
    icon: 'meta',
    api_access: 'official',
    /*
     * **与社媒那张 `meta_graph` 是两张卡**（57 §1）。
     *
     * 现实里这两张卡可以复用同一次 OAuth 授权，但要的权限不同：主页管理是
     * `pages_manage_posts`，花钱是 `ads_management`。做成一张卡的后果是
     * "想发个帖子"要先授权"能动广告预算"——那是把一把花钱的钥匙塞给一个
     * 只想排内容的人（同 04 §5 的分离理由）。
     */
    connector_kind: 'meta_marketing',
    implemented: true,
  },
  {
    id: 'google',
    role_id: 'ads.google',
    zh: 'Google Ads',
    en: 'Google Ads',
    icon: 'google',
    // developer token 要申请并过审；OAuth 之外还要一个 `developer-token` 头
    api_access: 'developer_token',
    connector_kind: 'google_ads',
    implemented: true,
  },
  {
    id: 'x',
    role_id: 'ads.x',
    zh: 'X Ads',
    en: 'X Ads',
    icon: 'x',
    api_access: 'apply',
    connector_kind: 'x_ads',
    // WP75 只做 Meta / Google 真实现（57 §2）；这条是接口 + 一句人话
    implemented: false,
  },
  {
    id: 'tiktok',
    role_id: 'ads.tiktok',
    zh: 'TikTok Ads',
    en: 'TikTok Ads',
    icon: 'tiktok',
    api_access: 'business_center',
    connector_kind: 'tiktok_ads',
    implemented: false,
  },
]

/** 平台 id → 规格；不认识的回 `undefined`（不编造一条）。 */
export function adsPlatformSpec(id: string): AdsPlatformSpec | undefined {
  return ADS_PLATFORMS.find((p) => p.id === id)
}

/** 职责 id（`ads.google`）→ 规格；不是投放职责回 `undefined`。 */
export function adsPlatformOfRole(role_id: string): AdsPlatformSpec | undefined {
  return ADS_PLATFORMS.find((p) => p.role_id === role_id)
}

/** 全部平台 id，按 {@link ADS_PLATFORMS} 的顺序。 */
export const ADS_PLATFORM_IDS: readonly AdsPlatform[] = ADS_PLATFORMS.map((p) => p.id)

/** 四条职责的 id，按出场顺序（`BUNDLED_ROLES` 与岗位模板读它）。 */
export const ADS_ROLE_IDS: readonly string[] = ADS_PLATFORMS.map((p) => p.role_id)

/* ── 五个 ChangeKind（57 §1）────────────────────────────────────────── */

/**
 * 57 §1 的五个写动作对应的 `ChangeKind`。
 *
 * **四个是 15 §2 里早就有的名字，只有 `creative_swap` 是新加的。** 57 §1 写的是
 * `campaign_create` / `ad_pause`，仓里从第一天起叫 `create_campaign` / `pause_ad`
 * （`packages/contracts/src/changes.ts`，`KIND_RISK` / `HARD_L1` /
 * `packages/txn` 的 `ledger.ts` 三处都按这个名字写着）。两套名字同时存在的后果
 * 不是"不好看"，是**一道门要写两遍**：`HARD_L1` 里放了 `create_campaign`、
 * 有人提了一条 `campaign_create`，硬顶就静悄悄地不生效了。契约只加不删
 * （改名等于删一个名字），所以这里**沿用仓里那四个名字**，57 §1 那两个
 * 写法在这一份表里对齐。
 */
export const ADS_CHANGE_KINDS = [
  /** 57 §1 的 `campaign_create`：新建 / 复制 campaign。**永远 L1**（`HARD_L1`）。 */
  'create_campaign',
  /** 改预算。超 `max_budget_delta_pct` 或会突破日花费总闸 → 升 L1。 */
  'budget_change',
  /** 改出价。超 `max_bid_delta_pct` → 升 L1。 */
  'bid_change',
  /** 57 §1 的 `ad_pause`：暂停。止损那一档 L3，其余 L2。 */
  'pause_ad',
  /** 换素材 / 换文案。L2，文案过承诺扫描。 */
  'creative_swap',
] as const

export type AdsChangeKind = (typeof ADS_CHANGE_KINDS)[number]

/**
 * 57 §1 写的名字 → 仓里那个名字。
 *
 * 只给读文档的人对号用（面板、日志、报告里一律用仓里那个名字）。
 * 不认识的原样返回。
 */
export const ADS_KIND_ALIASES: Readonly<Record<string, AdsChangeKind>> = {
  campaign_create: 'create_campaign',
  ad_pause: 'pause_ad',
}

/** 57 §1 的写法 → 仓里的 `ChangeKind`；不是别名就原样返回。 */
export function resolveAdsChangeKind(kind: string): string {
  return ADS_KIND_ALIASES[kind] ?? kind
}

/* ── 额度（57 §6）───────────────────────────────────────────────────── */

/**
 * 投放岗位的额度（57 §6 的默认值）。
 *
 * 名字就是四条职责 yml 里 `mandate.caps` 的键——**这里与 yml 是同一份数的两个位置**，
 * 对不上测试会喊（`packages/roles/test`）。
 */
export interface AdsCaps {
  /**
   * **岗位级日花费总闸**（04 §5 的 `max_daily_spend_total`，57 §6 默认 ¥1000）。
   *
   * 四条职责共用一个数：guardrail 按**岗位**聚合四个平台的当日花费再判，
   * 不是各判各的。这一条是整个投放岗位唯一一条"四条职责合起来看"的闸——
   * 别的额度都是各算各的。
   */
  max_daily_spend: number
  /** 一次提预算最多提多少（57 §6 默认 20%）。超了升 L1。 */
  max_budget_delta_pct: number
  /** 一次改出价最多改多少（57 §6 默认 15%）。超了升 L1。 */
  max_bid_delta_pct: number
  /** 止损判据一：ROAS 低于这个数（57 §6 默认 1）。 */
  stop_loss_roas_below: number
  /** 止损判据二：当日花费超过日预算的这个比例（57 §6 默认 30%）。 */
  stop_loss_spend_pct: number
  /** 一天最多改多少条（57 §6 默认 20）。 */
  max_changes_per_day: number
}

/** 57 §6 的默认值。职责 yml 与 `ads-core` 读同一份，不各写一遍。 */
export const ADS_DEFAULT_CAPS: AdsCaps = {
  max_daily_spend: 1000,
  max_budget_delta_pct: 20,
  max_bid_delta_pct: 15,
  stop_loss_roas_below: 1,
  stop_loss_spend_pct: 30,
  max_changes_per_day: 20,
}

/**
 * 暂停的理由（`pause_ad` 的 `after.reason`，**封闭**）。
 *
 * 封闭是因为**只有 `stop_loss` 那一档能到 L3**（04 §5：止损是保护性动作）。
 * 开着让人随便填的后果是每一条暂停都写着"止损"——于是那一档等于没有。
 * guardrail 会核对止损的判据真的成立（ROAS 与花费两格），不成立就转人审。
 */
export const AD_PAUSE_REASONS = [
  'stop_loss',
  'budget_exhausted',
  'creative_fatigue',
  'campaign_ended',
  'manual',
] as const
export type AdPauseReason = (typeof AD_PAUSE_REASONS)[number]

/* ── 五个对象（57 §5）───────────────────────────────────────────────── */

/** 广告账户的状态。`disabled` = 被平台停了（多半是付款或政策）。 */
export type AdAccountStatus = 'active' | 'paused' | 'disabled' | 'unknown'

/**
 * 一个广告账户（**一个独立的计费主体**）。
 *
 * 一个平台上可以有好几个（一个品牌一个、一个市场一个），所以 id 不是平台名。
 * `currency` 必带：总闸是一个数，账户是多币种的——不带币种的花费加不到一起。
 */
export interface AdAccount {
  id: string
  workspace_id: WorkspaceId
  platform: AdsPlatform
  /** 平台那一侧的账户 id（`act_123456` / `1234567890`）。 */
  external_id: string
  name: string
  currency: string
  status: AdAccountStatus
  /** 哪条连接供它（没连上就没有；没连不等于这个账户不存在）。 */
  connection_id?: string
  /** 今天花了多少（**账户币种**）。总闸要它。 */
  spend_today?: number
  /** 这份数字什么时候看到的。**必填**（文件头第 5 条）。 */
  observed_at: Iso8601
}

/** campaign / 广告组 / 广告共用的投放状态。 */
export type AdDeliveryStatus = 'active' | 'paused' | 'pending_review' | 'rejected' | 'ended'

/**
 * 一条 campaign。
 *
 * `daily_budget` 是**止损判据的分母**（57 §6：花费 > 日预算 30%），所以它与
 * `AdMetrics.spend` 必须来自同一次观测——两次观测拼出来的比值没有意义。
 */
export interface AdCampaign {
  id: string
  account_id: string
  platform: AdsPlatform
  external_id: string
  name: string
  status: AdDeliveryStatus
  objective?: string
  /** 日预算（账户币种）。按总预算投的 campaign 没有这一格。 */
  daily_budget?: number
  /** 总预算（账户币种）。 */
  lifetime_budget?: number
  metrics?: AdMetrics
}

/** 一个广告组（受众 / 出价落在这一级）。 */
export interface AdSet {
  id: string
  campaign_id: string
  account_id: string
  platform: AdsPlatform
  external_id: string
  name: string
  status: AdDeliveryStatus
  /** 出价（账户币种）。自动出价的没有这一格——**不补 0**。 */
  bid_amount?: number
  bid_strategy?: string
  daily_budget?: number
  /** 受众摘要（新建 campaign 卡上那一段：人要看得见"投给谁"）。 */
  audience_summary?: string
  metrics?: AdMetrics
}

/** 一条广告（素材落在这一级，所以 `creative_swap` 的目标是它）。 */
export interface Ad {
  id: string
  ad_set_id: string
  campaign_id: string
  account_id: string
  platform: AdsPlatform
  external_id: string
  name: string
  status: AdDeliveryStatus
  /** 素材引用（blob id / 外链），**不是**素材本身。 */
  creative_refs?: string[]
  /** 主文案（换文案那一下改的就是它，要过承诺扫描）。 */
  primary_text?: string
  headline?: string
  metrics?: AdMetrics
}

/**
 * 一次观测到的表现。
 *
 * 各平台叫法不同（曝光 / 触达 / 展示），这里只按**我们**的口径取名，适配器负责翻译。
 * 拿不到的一律 `undefined`——**不补 0**："这个平台不给这个数"与"这个数是 0"
 * 在面板上必须分得开（同 `SocialPostMetrics`）。
 */
export interface AdMetrics {
  /** 花费（账户币种）。 */
  spend?: number
  impressions?: number
  clicks?: number
  /** 平台口径的转化数（平台自己的归因窗口算的）。 */
  conversions?: number
  /** 平台口径的转化额。 */
  conversion_value?: number
  /** 平台口径的 ROAS。**不由我们除**：各家的分子分母口径不一样。 */
  roas?: number
  /** 这份数字什么时候看到的。**必填**（文件头第 5 条）。 */
  observed_at: Iso8601
}

/**
 * 像素 / 转化事件的一条健康记录（57 §1：**只读 + 异常卡**）。
 *
 * 改追踪代码那件事**不归投放**——那是建站的事，而且永远 L1（04 §5 `ads.tracking`
 * 那一行）。所以这个对象上没有一个写口子：投放看得见"像素掉了"，出一张卡请人
 * 去找建站，自己不动一行代码。
 */
export interface PixelEvent {
  id: string
  account_id: string
  platform: AdsPlatform
  /** 像素 / 转化动作那一侧的 id。 */
  external_id: string
  /** 事件名（`Purchase` / `AddToCart` / `conversion_action_123`）。 */
  event_name: string
  /** 近 24 小时收到多少条。0 与 `undefined` 是两件事：前者是真没有，后者是没查过。 */
  count_24h?: number
  /** 上一次收到是什么时候。掉了的那一条靠它判。 */
  last_fired_at?: Iso8601
  status: PixelHealth
  /** 平台说的原话（拒登 / 域名未验证 / 缺参数）。原样显示，不翻译成"出错了"。 */
  note?: string
  observed_at: Iso8601
}

/**
 * 像素的健康状态。
 *
 * `stale` 与 `missing` 分得开：前者是"还在，但很久没响了"（多半是有人改了主题），
 * 后者是"平台上查不到这个事件"。两句话在卡上要说得不一样，因为去找谁修不一样。
 */
export type PixelHealth = 'healthy' | 'stale' | 'missing' | 'misconfigured'

/* ── 归因的两列（57 §1）────────────────────────────────────────────── */

/**
 * 归因表上的一行：**平台口径与订单口径并排，永远不合并**（文件头第 3 条）。
 *
 * 两个数不一样是常态，不是 bug：平台按点击后 7 天 / 浏览后 1 天算，订单表按
 * 落地页上那串 UTM 算；跨设备的那一单平台认、UTM 不认，直接进店搜品牌名下单的
 * 那一单两边都不认。面板上两列并排摆着，差多少一眼看得见——那正是人要判的东西。
 */
export interface AdAttributionRow {
  platform: AdsPlatform
  /** 按 campaign 聚合（UTM 的 `utm_campaign` 与平台的 campaign 名对齐）。 */
  campaign: string
  /** 平台自己报的转化数。 */
  platform_conversions?: number
  /** 平台自己报的转化额。 */
  platform_value?: number
  /** 订单表里用这串 UTM 找到的订单数。 */
  order_conversions?: number
  /** 那些订单的金额合计。 */
  order_value?: number
  /** 花费（算两个 ROAS 的同一个分母）。 */
  spend?: number
  observed_at: Iso8601
}
