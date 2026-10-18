/**
 * WP159：违规宣称规则**按市场分组**（WP154「要定」第 4 条，Luoye 09-27：可以）。
 *
 * 规则表放知识库（`subject.type === 'content_rule'` 的事实卡，人可改、可关）。这里是自带的那一份
 * 与「知识库里的卡 + 品牌的目标市场 → 这一次真用哪些规则」的合成——纯函数，服务端只接线。
 *
 * - `global`（永远开）：绝对化用语、医疗功效（原 `DEFAULT_CLAIM_RULES`，加了出处）；
 * - `us`：FTC——未经证实的功效、「Made in USA」、评价与代言披露、笼统环保宣称；
 * - `eu_uk`：欧盟 UCPD / 2024/825 绿色转型指令、比较广告指令；英国 ASA（CAP 守则）与 CMA 绿色宣称准则；
 * - `ca`：加拿大竞争局——「Made in / Product of Canada」、性能宣称要事先测试、环保宣称；
 * - `au`：澳大利亚 ACCC——产地、环保宣称、网上评价；TGA 的治疗性宣称。
 *
 * 每条都写清出处（官方指南链接，WP159 调研时逐条打开核过）与一句人话。
 *
 * **知识库里的卡怎么盖过自带的**：卡的 `subject.key` 等于自带规则的 id → 用卡上的写法
 * （改过的 pattern / 理由），`structured.enabled === false` 就是关掉；key 不是自带 id 的卡 =
 * 人自己加的规则，`structured.market` 不写就当通用。市场组的开关按目标市场自动定，人拨过的
 * 以人为准（服务端存在品牌目录里）。
 */
import type {
  ClaimMarketGroup,
  ClaimMarketGroupView,
  ClaimRuleRow,
  ContentClaimRule,
} from '@agentsws/contracts'
import { builtinContentTable, readContentTable } from '@agentsws/core'
import CLAIM_RULES_FILE from './claim-rules.content.json' with { type: 'json' }

export const CLAIM_MARKET_GROUPS: readonly ClaimMarketGroup[] = [
  'global',
  'us',
  'eu_uk',
  'ca',
  'au',
]

export const CLAIM_GROUP_LABEL: Readonly<Record<ClaimMarketGroup, string>> = {
  global: '通用',
  us: '美国（FTC）',
  eu_uk: '欧盟 / 英国',
  ca: '加拿大',
  au: '澳大利亚',
}

/** 欧盟 27 国 + 英国（`GB` / `UK` 都认）。 */
const EU_UK = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  'GB',
  'UK',
])

/** 一个国家码属于哪个市场组（认不出 → `undefined`，只用通用组）。 */
export function claimGroupOfMarket(code: string): ClaimMarketGroup | undefined {
  const c = code.trim().toUpperCase()
  if (c === 'US') return 'us'
  if (c === 'CA') return 'ca'
  if (c === 'AU') return 'au'
  if (EU_UK.has(c)) return 'eu_uk'
  return undefined
}

/** 目标市场 → 该开的市场组（通用组永远在）。 */
export function claimGroupsForMarkets(markets: readonly string[]): ClaimMarketGroup[] {
  const on = new Set<ClaimMarketGroup>(['global'])
  for (const m of markets) {
    const g = claimGroupOfMarket(m)
    if (g !== undefined) on.add(g)
  }
  return CLAIM_MARKET_GROUPS.filter((g) => on.has(g))
}

/** 自带的一条（一定有市场组与出处）。 */
export interface MarketClaimRule extends ContentClaimRule {
  market: ClaimMarketGroup
  source_title: string
  source_url: string
}

/** 知识库里的一张规则卡（服务端投影出来的最小形状）。 */
export interface ClaimRuleCardLike {
  id: string
  subject: { type: string; key: string }
  statement: string
  structured?: Record<string, unknown>
}

/**
 * WP404（docs/107 §3）：**规则表是数据**（`claim-rules.content.json`，每条带稳定 id、市场组、出处、一句人话、
 * 给人看的写法）。原来写在这里的出处表、`rule()` 拼法、给人看的写法原样挪进了那份数据，判法留在这里。
 * 按品牌可覆盖：`resolveClaimRules({ brand })` 经 `readContentTable` 拿表；没登记覆盖源就是这一份。
 */
const CLAIM_RULES_TABLE = builtinContentTable<MarketClaimRule>(CLAIM_RULES_FILE)

const isMarketClaimRule = (r: unknown): r is MarketClaimRule => {
  const x = r as MarketClaimRule
  return (
    typeof x.pattern === 'string' &&
    typeof x.reason === 'string' &&
    isGroup(x.market) &&
    typeof x.source_title === 'string' &&
    typeof x.source_url === 'string'
  )
}

/** 自带的规则表（按市场分组；顺序即知识库里的展示顺序）。 */
export const MARKET_CLAIM_RULES: readonly MarketClaimRule[] = CLAIM_RULES_TABLE.rows

/** 这一次用哪张表（按品牌可覆盖）。 */
function claimRulesFor(brand: string | undefined): readonly MarketClaimRule[] {
  return readContentTable(CLAIM_RULES_TABLE, { brand, accepts: isMarketClaimRule })
}

const BUILTIN = new Map(MARKET_CLAIM_RULES.map((r) => [r.id, r]))

const CATEGORIES = new Set<ContentClaimRule['category']>([
  'absolute',
  'medical',
  'other',
  'green',
  'origin',
  'endorsement',
  'comparison',
  'performance',
])
const isGroup = (v: unknown): v is ClaimMarketGroup =>
  typeof v === 'string' && (CLAIM_MARKET_GROUPS as readonly string[]).includes(v)

/** 一张卡盖在自带那条（或什么都没有）上面 → 表里的一行。卡的形状不对（没有 pattern）→ `undefined`。 */
function rowOf(
  card: ClaimRuleCardLike,
  base: MarketClaimRule | undefined,
): ClaimRuleRow | undefined {
  const s = card.structured ?? {}
  const pattern =
    typeof s.pattern === 'string' && s.pattern.trim() !== ''
      ? s.pattern
      : (base?.pattern ?? card.subject.key)
  if (pattern.trim() === '') return undefined
  const category = CATEGORIES.has(s.category as ContentClaimRule['category'])
    ? (s.category as ContentClaimRule['category'])
    : (base?.category ?? 'other')
  const regex = typeof s.regex === 'boolean' ? s.regex : base?.regex === true
  const reason =
    typeof s.reason === 'string' && s.reason.trim() !== ''
      ? s.reason
      : (base?.reason ?? card.statement)
  const source_title = typeof s.source_title === 'string' ? s.source_title : base?.source_title
  const source_url = typeof s.source_url === 'string' ? s.source_url : base?.source_url
  // 人改了要拦的字，自带那句写法就不对了
  const label = base?.label !== undefined && pattern === base.pattern ? base.label : undefined
  return {
    id: base?.id ?? card.id,
    pattern,
    ...(regex ? { regex: true } : {}),
    category,
    reason,
    market: base?.market ?? (isGroup(s.market) ? s.market : 'global'),
    ...(source_title === undefined ? {} : { source_title }),
    ...(source_url === undefined ? {} : { source_url }),
    ...(label === undefined ? {} : { label }),
    enabled: s.enabled !== false,
    origin: base === undefined ? 'custom' : 'edited',
  }
}

export interface ResolvedClaimRules {
  /** 这一次质检真用的规则（开着的组里、开着的那几条）。 */
  rules: ContentClaimRule[]
  groups: ClaimMarketGroupView[]
  /** 知识库那张表（全部行，含关掉的与没开的组里的）。 */
  rows: ClaimRuleRow[]
}

/**
 * 知识库里的规则卡 + 目标市场 + 人拨过的组开关 → 这一次用哪些规则、表里画什么。
 *
 * 同一个 key 有好几张卡时**后面的赢**（调用方按更新时间排好）。
 */
export function resolveClaimRules(input: {
  markets: readonly string[]
  cards: readonly ClaimRuleCardLike[]
  /** 人在知识库里拨过的组开关（没拨过的按市场自动）。 */
  group_overrides?: Partial<Record<ClaimMarketGroup, boolean>>
  /** WP404：这次在哪个品牌里（规则表按品牌可覆盖；不给 = 随软件带的那一份）。 */
  brand?: string
}): ResolvedClaimRules {
  const table = claimRulesFor(input.brand)
  const builtin = table === MARKET_CLAIM_RULES ? BUILTIN : new Map(table.map((r) => [r.id, r]))
  const auto = new Set(claimGroupsForMarkets(input.markets))
  const groups: ClaimMarketGroupView[] = CLAIM_MARKET_GROUPS.map((id) => {
    const manual = id === 'global' ? undefined : input.group_overrides?.[id]
    return {
      id,
      label: CLAIM_GROUP_LABEL[id],
      enabled: id === 'global' ? true : (manual ?? auto.has(id)),
      why: id === 'global' ? 'always' : manual === undefined ? 'market' : 'manual',
    }
  })
  const byKey = new Map<string, ClaimRuleCardLike>()
  for (const c of input.cards) if (c.subject.type === 'content_rule') byKey.set(c.subject.key, c)
  const rows: ClaimRuleRow[] = []
  for (const base of table) {
    const card = byKey.get(base.id)
    const row = card === undefined ? undefined : rowOf(card, base)
    rows.push(row ?? { ...base, enabled: true, origin: 'builtin' })
  }
  for (const [key, card] of byKey) {
    if (builtin.has(key)) continue
    const row = rowOf(card, undefined)
    if (row !== undefined) rows.push(row)
  }
  const on = new Set(groups.filter((g) => g.enabled).map((g) => g.id))
  const rules = rows
    .filter((r) => r.enabled && on.has(r.market))
    .map(({ enabled: _e, origin: _o, ...rule }) => rule)
  return { rules, groups, rows }
}

/** 自带规则的 id（知识库卡的 `subject.key` 用它盖过自带那条）。 */
export function isBuiltinClaimRule(id: string): boolean {
  return BUILTIN.has(id)
}

/** 自带的那一条（改卡时拿它当底）。 */
export function builtinClaimRule(id: string): MarketClaimRule | undefined {
  return BUILTIN.get(id)
}
