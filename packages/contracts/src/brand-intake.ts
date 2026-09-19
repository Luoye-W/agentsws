/**
 * 贴一个网址，我们把品牌档案填出来（70 §3，WP121）。
 *
 * 为什么住在契约里：抓取与解析在 `@agentsws/brand-intake`，发起与确认在
 * `/v1/brand-intake/*`，那张可编辑的档案卡在工作台，写进去的地方是组织 / 工作区 /
 * `@agentsws/knowledge` / WP120 的 persona——**五处都要认同一个形状**。
 *
 * 这一组的中心只有一个：{@link BrandIntakeField}。
 *
 * 自动填出来的字段与用户自己填的字段**不是一回事**，所以它们不能长得一样。
 * 每一格都拖着三样东西走：
 *
 * | 拖着的 | 它回答 |
 * |---|---|
 * | `evidence` | 这个值是**从哪个网址的哪一段**看来的（人要能自己去核） |
 * | `confidence` | 我们有多大把握（`low` 的界面上标"请确认"） |
 * | `edited` | 用户手改过没有（**重新分析不覆盖改过的格子**） |
 *
 * 第三样是最容易漏又最伤人的那一样：换了新品重跑一次分析，把用户上周改对的
 * 品牌名又覆盖回错的，这种事只要发生一次，"重新分析"这个按钮就再没人敢按。
 *
 * **抓不到就是抓不到**：拿不准的字段不出现在结果里，不填一个像模像样的猜测。
 * 一个空格子用户知道要填，一个填错的格子用户会当它是对的。
 */
import type { Iso8601, WorkspaceId } from './common.js'
import type { StorefrontPlatform } from './identity.js'

/** 用户贴进来的那一条链接是什么。`none` 是"我还没有网站"那条旁路（沿用 WP79）。 */
export type BrandIntakeSourceKind =
  | 'website'
  | 'amazon_listing'
  | 'amazon_storefront'
  | 'none'

/**
 * 出处：**哪个网址、哪一段**。
 *
 * `quote` 是页面上的原文片段，不是我们的复述——人核对的时候要能在页面上
 * 搜到这串字。`locator` 说的是"从哪一层拿的"（`jsonld:Organization.name`、
 * `og:site_name`、`selector:h1`），它决定了把握度。
 */
export interface BrandIntakeEvidence {
  url: string
  /** 从哪一层拿的：`jsonld:…` / `og:…` / `microdata:…` / `selector:…` / `model`。 */
  locator: string
  /** 页面上那一段原文（已截断）。模型抽出来的字段这里留空。 */
  quote?: string
}

/**
 * 把握度。**只有三档**，因为界面上只分三种画法：直接显示 / 显示 /
 * 显示并标"请确认"。
 *
 * - `high` —— 结构化数据里明写的（JSON-LD、og、microdata）。机器读的，不会看走眼。
 * - `medium` —— 从页面结构推出来的（标题层级、路径约定、颜色统计）。
 * - `low` —— 模型从正文里抽的，或者只有一处弱证据。**界面上标"请确认"。**
 */
export type BrandIntakeConfidence = 'high' | 'medium' | 'low'

/**
 * 一格：值 + 出处 + 把握度 + 改没改过。
 *
 * `edited: true` 的格子在重跑分析时**整格跳过**——连 `evidence` 都不刷新，
 * 因为那时候的出处说的是"我们当初为什么填错"，留着没有意义。
 */
export interface BrandIntakeField<T> {
  value: T
  confidence: BrandIntakeConfidence
  /** 至少一条。一条证据都没有的字段不该出现在结果里。 */
  evidence: BrandIntakeEvidence[]
  /** 用户手改过。重新分析跳过这一格。 */
  edited?: boolean
}

/** 主打商品的一张卡（官网商品页或 Amazon listing 都落成这个形状）。 */
export interface BrandIntakeProduct {
  title: string
  /** 店里写的那串字（`$19.99`、`¥129`），**原样存**：不换算、不补币种、不猜。 */
  price_snapshot?: string
  currency?: string
  image_url?: string
  url?: string
  /** 卖点（官网取自商品描述要点；Amazon 取五点）。 */
  selling_points?: string[]
  /** Amazon 专有。 */
  asin?: string
  /** 有没有变体（颜色 / 尺码）。抓不到变体明细时只说有没有。 */
  has_variants?: boolean
}

/** 政策要点（退换货 / 物流 / 保修）。**要点不是全文**：全文进知识库，这里只留一句。 */
export interface BrandIntakePolicy {
  kind: 'refund' | 'shipping' | 'warranty' | 'privacy' | 'terms'
  /** 一句话要点。 */
  summary: string
  /** 政策页原址（知识条目按它建源）。 */
  url: string
}

/** 一条社媒链接。`platform` 认不出来就是 `other`，链接照样留着。 */
export interface BrandIntakeSocialLink {
  platform: string
  url: string
}

/**
 * 分析出来的品牌档案。**每一格都是 {@link BrandIntakeField}**，没有裸值。
 *
 * 全部可选：抓不到的字段**不出现**，而不是出现一个空字符串。界面按"在不在"
 * 决定画不画那一行，所以空字符串会画出一行空格子，比没有更糟。
 */
export interface BrandIntakeProfile {
  brand_name?: BrandIntakeField<string>
  /** 公司 / 法律实体名（与品牌名常常不是一个，所以分两格）。 */
  legal_name?: BrandIntakeField<string>
  logo_url?: BrandIntakeField<string>
  /** 主色，`#rrggbb`。取自 logo 或站点主题色。 */
  primary_color?: BrandIntakeField<string>
  /** 一句话定位。 */
  one_liner?: BrandIntakeField<string>
  category?: BrandIntakeField<string>
  storefront_platform?: BrandIntakeField<StorefrontPlatform>
  products?: BrandIntakeField<BrandIntakeProduct[]>
  /** 目标市场（ISO 国家码）。 */
  markets?: BrandIntakeField<string[]>
  languages?: BrandIntakeField<string[]>
  currency?: BrandIntakeField<string>
  social_links?: BrandIntakeField<BrandIntakeSocialLink[]>
  support_email?: BrandIntakeField<string>
  policies?: BrandIntakeField<BrandIntakePolicy[]>
  /** 口吻样例：站上的原话，给 WP120 的 persona 当语气参考。 */
  tone_samples?: BrandIntakeField<string[]>
  /** Amazon 专有：评分与评论数（只在 listing 那条路上有）。 */
  rating?: BrandIntakeField<number>
  reviews_count?: BrandIntakeField<number>
}

/** 一次分析跑到哪一步了。 */
export type BrandIntakeRunStatus =
  /** 排上了还没开跑 */
  | 'queued'
  /** 正在抓 / 正在抽 */
  | 'running'
  /** 跑完了，等用户在档案卡上点"看着没问题" */
  | 'awaiting_confirm'
  /** 用户确认了，已经写进组织 / 工作区 / 知识库 */
  | 'confirmed'
  /** 花到封顶了，**停在这儿**（已经抓到的部分照样给） */
  | 'budget_exceeded'
  /** 一个页面都没抓着 */
  | 'failed'
  | 'cancelled'

/** 花了多少、封顶多少（用官方接口时这一步计入注册送的那 10 积分）。 */
export interface BrandIntakeBudget {
  /** 开跑前给用户看的预估。 */
  estimated_credits: number
  /** 封顶。**超了就停**，不问、不续。 */
  cap_credits: number
  /** 到目前为止真花了多少。 */
  spent_credits: number
}

/** 抓过的一个页面（进度条按它走，出错也按它如实说）。 */
export interface BrandIntakePage {
  url: string
  /** 首页 / 关于 / 联系 / 政策 / 商品 / 站点地图。 */
  kind: 'home' | 'about' | 'contact' | 'policy' | 'product' | 'collection' | 'sitemap'
  ok: boolean
  /** 没抓着的时候说人话（`404`、`超时`、`robots 不让抓`）。**不编。** */
  reason?: string
}

/** 一次分析。 */
export interface BrandIntakeRun {
  id: string
  schema_version: 1
  workspace_id: WorkspaceId
  status: BrandIntakeRunStatus
  /** 用户贴的那些链接（原样）。 */
  inputs: { url: string; kind: BrandIntakeSourceKind }[]
  pages: BrandIntakePage[]
  budget: BrandIntakeBudget
  profile: BrandIntakeProfile
  created_at: Iso8601
  updated_at: Iso8601
  /** 跑挂了的那一句人话。 */
  failure?: string
}

/** 发起一次分析。 */
export interface BrandIntakeStartInput {
  workspace_id: WorkspaceId
  urls: string[]
  /** 不给就用 {@link DEFAULT_BRAND_INTAKE_CAP_CREDITS}。 */
  cap_credits?: number
}

/**
 * 确认（"看着没问题"）。
 *
 * `edits` 是用户在档案卡上改过的那几格——**只带改过的**，没带的按分析结果走。
 * 改过的格子在库里被标成 `edited`，重新分析时整格跳过。
 */
export interface BrandIntakeConfirmInput {
  run_id: string
  /** 字段名 → 用户改成了什么。值的形状与 {@link BrandIntakeProfile} 对应那一格的 `value` 相同。 */
  edits?: Record<string, unknown>
}

/**
 * 一次基础分析的积分封顶（70 §3）。
 *
 * 2 是**对着注册送的 10 积分定的**：分析花掉 2，剩 8 还够几十轮便宜档对话。
 * 一个新用户不该在第一分钟就把赠送的额度烧光——那样"送 10 积分"这件事
 * 反而变成了一个坏印象。
 */
export const DEFAULT_BRAND_INTAKE_CAP_CREDITS = 2

/** 官网那条路最多抓几个页面（超过就不抓了——再多也不会让第一版档案更准）。 */
export const BRAND_INTAKE_MAX_PAGES = 12

/** 主打商品最多取几个。 */
export const BRAND_INTAKE_MAX_PRODUCTS = 8
