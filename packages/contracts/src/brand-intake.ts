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
import type { BrandAudience, BrandCompetitor, BrandKeywords } from './brand-insights.js'
import type { Iso8601, WorkspaceId } from './common.js'
import type { StorefrontPlatform } from './identity.js'

/** 用户贴进来的那一条链接是什么。`none` 是"我还没有网站"那条旁路（沿用 WP79）。 */
export type BrandIntakeSourceKind = 'website' | 'amazon_listing' | 'amazon_storefront' | 'none'

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
  /**
   * WP346：原价（划线价 / 建议零售价），原样存那串字。只有页面上同时写着原价与售价时才有——
   * 这时 `price_snapshot` 与 {@link sale_price_snapshot} 是同一个数（卖的那个价）。
   */
  list_price_snapshot?: string
  /** WP346：售价（实际卖的那个价），原样存。有原价时才单独给；没有原价时只看 `price_snapshot`。 */
  sale_price_snapshot?: string
  /** WP346：规格（材质、尺寸、重量、容量…）。结构化数据里读的在前，AI 补的标在 {@link model_filled}。 */
  specs?: BrandIntakeProductSpec[]
  /**
   * WP346：这张卡上**哪几样是 AI 从页面文字里补的**（`specs` / `list_price_snapshot` /
   * `sale_price_snapshot`）。界面据此挂「AI 建议」；价格只收页面上原样出现过的那串字。
   */
  model_filled?: ('specs' | 'list_price_snapshot' | 'sale_price_snapshot')[]
}

/** WP346：一条规格。 */
export interface BrandIntakeProductSpec {
  name: string
  value: string
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
  /**
   * WP258：官网页面自己漏出来的 Shopify 店铺地址（`Shopify.shop = "xxx.myshopify.com"`）。
   * 不给人看、不给人改——建站岗位登录 Shopify 后拿它和账号下的店对一下，对上了就默认选那家。
   */
  shopify_domain?: BrandIntakeField<string>
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
  /*
   * ── WP346（决策 872）：AI 从抓到的页面文字里归纳的几格 ─────────────────────
   * 层一律是 `model`（把握度 `low`，界面标「请确认」 + 「AI 建议」）。没接模型就一格都没有。
   */
  /** 目标人群：谁买、谁付钱、顾虑。 */
  audience?: BrandIntakeField<BrandAudience>
  /** 关键词（品牌 / 品类 / 场景三组）。 */
  keywords?: BrandIntakeField<BrandKeywords>
  /** 价格带（「$20–$80」这样一串；从页面上的价归纳，不编）。 */
  price_band?: BrandIntakeField<string>
  /** 子品类（比品类细一层：「AR 眼镜」下的「拍照 AR 眼镜」）。 */
  subcategory?: BrandIntakeField<string>
  /** 品牌定位一段（两三句；一句话介绍 `one_liner` 照旧保留）。 */
  positioning?: BrandIntakeField<string>
  /** 主要竞品（AI 建议 3–6 个，各带一句理由）。 */
  competitors?: BrandIntakeField<BrandCompetitor[]>
}

/**
 * WP346：AI 归纳那一步怎么样了（界面按它说一句：没接模型 / 积分不够 / 模型没答好）。
 *
 * - `done`：问过了（回来的格子可能仍有空的——模型拿不准的就不填）；
 * - `no_model`：这个品牌没接模型，AI 那几格跳过，照旧出解析结果；
 * - `budget`：页面已经花到封顶，AI 那一步没问；
 * - `failed`：问了但没答好 / 出错（解析结果照给）；
 * - `skipped`：一页都没读到 / 空店，没什么可归纳的。
 */
export type BrandIntakeInsightsStatus = 'done' | 'no_model' | 'budget' | 'failed' | 'skipped'

/**
 * WP349（Luoye 10-15 改决策 881）：品牌分析那一轮**联网查**的几部分。取舍顺序（额度装不下时）：
 * 先保官网解析，再竞品（`competitors` 发现 + `verify` 逐个核实），最后品牌评测（`brand`）。
 */
export type BrandIntakeWebPart = 'brand' | 'competitors' | 'verify'

/**
 * WP349：联网查那一步怎么样了（界面按它照实说一句）。
 *
 * - `done`：至少搜成了一次（结果进了 AI 归纳那一次）；
 * - `off`：没联网能力（没接搜索 / 设置里关着）——竞品一格留空，说「没联网，查不了竞品」；
 * - `failed`：搜了但一次都没搜成；
 * - `skipped`：AI 归纳那一步没跑（没接模型 / 一页没读到 / 空店 / 封顶），联网也就不查。
 */
export type BrandIntakeWebStatus = 'done' | 'off' | 'failed' | 'skipped'

export interface BrandIntakeWebReport {
  status: BrandIntakeWebStatus
  /** `off` 时为什么（一句人话，例：「联网搜索要先登录 DeepSeek 账号…」）。 */
  reason?: string
  /** 这一次一共搜了几次（命中 7 天缓存的也算一次，只是不花钱）。 */
  searches: number
  /** 搜索计了多少积分（按 {@link BRAND_INTAKE_SEARCH_CREDITS}；已含在 `budget.spent_credits` 里）。 */
  credits: number
  /** 因为额度没查（或没查全）的几部分——界面照实说哪几格因此没查。 */
  cut?: BrandIntakeWebPart[]
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

/** 花了多少、封顶多少（用官方接口时这一步计入注册送的那 5 积分）。 */
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
  /**
   * WP240：读不到的**是哪一种**（界面按它给下一步：填店铺密码 / 先跳过 / 换网址）。
   * 没有 = 老 run 或说不清是哪一种（照旧只看 `failure`）。
   */
  failure_kind?: BrandIntakeFailureKind
  /** WP240：入口是 Shopify 密码页（店铺开着访问密码）。跑完 / 跑挂都可能带它。 */
  password_protected?: boolean
  /**
   * WP244：认出官网是**刚开的 Shopify 空店**（店名还是 My Store、首页还是默认主题）。
   * 这时品牌名 / 一句话不填、默认生成的政策不进知识库；界面明说「品牌资料请自己填」，
   * 第 ③ 步推荐加上建站。
   */
  fresh_store?: boolean
  /** WP346：AI 归纳那一步怎么样了（没有 = 老 run / 还没跑到）。 */
  insights?: BrandIntakeInsightsStatus
  /** WP349：联网查那一步怎么样了（没有 = 老 run / 还没跑到）。 */
  web?: BrandIntakeWebReport
}

/**
 * WP240：读不到网站的几种原因（各配一句人话 + 下一步）。
 *
 * - `password`：Shopify 店开着访问密码（读到的是密码页）——填一次店铺密码再读，或先跳过；
 * - `password_wrong`：填了店铺密码但没解开；
 * - `blocked`：对方限流 / 拒绝（429 / 403）——过一会再试，或先跳过；
 * - `dns`：域名还没解析（或拼错了）——检查网址；
 * - `timeout`：对方太慢、一直没回；
 * - `unreachable`：别的连不上。
 */
export type BrandIntakeFailureKind =
  | 'password'
  | 'password_wrong'
  | 'blocked'
  | 'dns'
  | 'timeout'
  | 'unreachable'

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
 * 2 是**对着注册送的 5 积分定的**：分析花掉 2，剩 3 还够十几轮便宜档对话。
 * 一个新用户不该在第一分钟就把赠送的额度烧光——那样"送 5 积分"这件事
 * 反而变成了一个坏印象。
 */
export const DEFAULT_BRAND_INTAKE_CAP_CREDITS = 2

/** 官网那条路最多抓几个页面（超过就不抓了——再多也不会让第一版档案更准）。 */
export const BRAND_INTAKE_MAX_PAGES = 12

/** 主打商品最多取几个。 */
export const BRAND_INTAKE_MAX_PRODUCTS = 8

/**
 * WP346：AI 归纳那一次调用按多少积分算（与一页抽取同价）。
 *
 * 封顶照旧是 {@link DEFAULT_BRAND_INTAKE_CAP_CREDITS}：接了模型时先给这一步留出这一份，
 * 页面预算相应少一份——官网 12 页 × 0.15 + 0.15 = 1.95，仍压在 2 下面。
 */
export const BRAND_INTAKE_INSIGHTS_CREDITS = 0.15

/**
 * WP349：品牌分析那一轮最多联网搜几次——品牌评测 3 + 竞品发现 2 + 竞品核实每个 1 次、最多 4 个 = 9。
 */
export const BRAND_INTAKE_WEB_SEARCH_MAX = { brand: 3, competitors: 2, verify: 4 } as const

/**
 * WP349：一次联网搜索在品牌分析里按多少积分算。
 *
 * **0**——按现有价目（WP179）：联网搜索走用户自己的 DeepSeek 账号 / 官方 key，一次搜索 = 一次 DeepSeek
 * 模型回合，钱由 DeepSeek 那边扣，工坊不收积分；用量页「联网搜索」照常记一笔。封顶的取舍顺序照样做好
 * （先保官网解析，再竞品，最后品牌评测）：哪天搜索要收积分，改这个数就生效（决策 897）。
 */
export const BRAND_INTAKE_SEARCH_CREDITS = 0

/** WP346：「重新分析一次」逐格采纳（设置页）：采纳哪几格，可顺带改值（形状同确认的 `edits`）。 */
export interface BrandIntakeAdoptInput {
  run_id: string
  fields: string[]
  edits?: Record<string, unknown>
}
