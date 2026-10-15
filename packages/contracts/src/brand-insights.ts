/**
 * WP346（决策 872）：品牌档案第二版那几格——**AI 从抓到的页面文字里归纳的**，一律由人确认。
 *
 * 为什么单独一个文件：同一个形状要住三处——一次分析的结果（`BrandIntakeProfile`，每格包成
 * `BrandIntakeField`）、品牌档案（`WorkspaceProfile`，裸值 + `ai_suggested` 记哪几格还没人点头）、
 * 下游四处（Reddit 巡查 / GEO / 红人 / 广告）读的那一份。放在任何一处都会让另两处反向依赖它。
 *
 * 字段口径移植自 KOLAgents `src/influencer/services/enrichment.ts` 的 `analyzeBrand`
 * （`audienceNotes` / `keywords` / `priceRange` / `subcategory` / `description`），按工坊的档案拆细：
 * 人群拆成「谁买 / 谁付钱 / 顾虑」，关键词分三组，另加竞品（两边都没有的新格子）。
 */

/**
 * 目标人群。
 *
 * KOLAgents 那一版是一段话（`audienceNotes`），这里拆成三格：下游用得上的是「谁买」（找红人、
 * 选版块）与「顾虑」（写内容、写广告），拆开才读得到。
 */
export interface BrandAudience {
  /** 谁买（年龄段、身份、在做什么决定）。一两句。 */
  buyers: string
  /** 谁付钱——**和用的人不是同一个时才有**（给孩子买的家长、给团队买的主管）。 */
  payer?: string
  /** 买之前顾虑什么（拦住他们下单的那几条）。 */
  concerns?: string[]
}

/** 关键词分三组：品牌词 / 品类词 / 场景词。下游各取所需（广告要品类 + 场景，巡查要品牌 + 品类）。 */
export interface BrandKeywords {
  brand: string[]
  category: string[]
  scenario: string[]
}

/**
 * WP349（决策 881 改）：一条来源——这一格 / 这个竞品是从**哪个网页**看来的（联网搜到的那一条）。
 * 界面上可点开；人要能自己去核。
 */
export interface BrandSource {
  url: string
  /** 网页标题（搜索结果给的；没有就画域名）。 */
  title?: string
}

/**
 * 一个主要竞品。AI 整理的，界面标「AI 建议」。
 *
 * WP349（Luoye 10-15 改决策 881）：**竞品必须联网查到、带来源才收**——只出现在模型记忆里的不算；
 * 没联网能力时竞品一格留空并照实说。人在设置页自己加的竞品可以没有来源（人说了算）。
 */
export interface BrandCompetitor {
  name: string
  /** 一句理由（为什么算竞品）。 */
  reason: string
  /** 官网（WP349 起：搜到的网页里核对得上才留）。 */
  url?: string
  /** WP349：从哪几个网页看来的（AI 整理的竞品至少一条；人加的可以没有）。 */
  sources?: BrandSource[]
}

/** 档案里由 AI 填的那几格（品类是 WP335 起就 AI 填的，一并算在里面）。 */
export type BrandInsightField =
  | 'category'
  | 'subcategory'
  | 'positioning'
  | 'price_band'
  | 'audience'
  | 'keywords'
  | 'competitors'

export const BRAND_INSIGHT_FIELDS: readonly BrandInsightField[] = [
  'category',
  'subcategory',
  'positioning',
  'price_band',
  'audience',
  'keywords',
  'competitors',
]

/** 竞品最多几个（AI 建议 3–6 个；人可以多加，但封顶）。 */
export const BRAND_COMPETITORS_MAX = 8

/** 每组关键词最多几个。 */
export const BRAND_KEYWORDS_PER_GROUP_MAX = 12

/** WP349：一格最多挂几条来源。 */
export const BRAND_SOURCES_PER_FIELD_MAX = 3
