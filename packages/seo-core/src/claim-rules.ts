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

/** 官方出处（WP159 调研时逐条打开核过；标题写成人能认出来的样子）。 */
const SRC = {
  cn_ad_law: [
    '中华人民共和国广告法（第九条、第十七条）',
    'https://www.gov.cn/guoqing/2021-10/29/content_5647620.htm',
  ],
  ftc_subst: [
    'FTC：广告证实政策声明',
    'https://www.ftc.gov/legal-library/browse/ftc-policy-statement-regarding-advertising-substantiation',
  ],
  ftc_health: [
    'FTC：健康产品合规指南',
    'https://www.ftc.gov/business-guidance/resources/health-products-compliance-guidance',
  ],
  ftc_usa: [
    'FTC：Made in USA 标准',
    'https://www.ftc.gov/business-guidance/resources/complying-made-usa-standard',
  ],
  ftc_endorse: [
    'FTC：代言指南问答',
    'https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking',
  ],
  ftc_reviews: [
    'FTC：消费者评价与推荐规则（16 CFR 465）',
    'https://www.ecfr.gov/current/title-16/chapter-I/subchapter-D/part-465',
  ],
  ftc_green: [
    'FTC：绿色指南（16 CFR 260）',
    'https://www.ecfr.gov/current/title-16/chapter-I/subchapter-B/part-260',
  ],
  eu_ucpd: ['欧盟不公平商业行为指令 2005/29/EC', 'https://eur-lex.europa.eu/eli/dir/2005/29/oj'],
  eu_green: ['欧盟绿色转型指令 (EU) 2024/825', 'https://eur-lex.europa.eu/eli/dir/2024/825/oj'],
  eu_compare: [
    '欧盟误导与比较广告指令 2006/114/EC',
    'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32006L0114',
  ],
  cap3: [
    '英国 CAP 守则第 3 节：误导性广告',
    'https://www.asa.org.uk/type/non_broadcast/code_section/03.html',
  ],
  cap12: [
    '英国 CAP 守则第 12 节：健康类宣称',
    'https://www.asa.org.uk/type/non_broadcast/code_section/12.html',
  ],
  cma_green: [
    '英国 CMA 绿色宣称准则',
    'https://www.gov.uk/government/publications/green-claims-code-making-environmental-claims',
  ],
  ca_green: [
    '加拿大竞争局：环保宣称指引',
    'https://competition-bureau.canada.ca/en/deceptive-marketing-practices/greenwashing-guidance-businesses',
  ],
  ca_origin: [
    '加拿大竞争局：Product of / Made in Canada',
    'https://competition-bureau.canada.ca/en/how-we-foster-competition/education-and-outreach/publications/product-canada-and-made-canada-claims',
  ],
  ca_perf: [
    '加拿大竞争局：性能宣称要事先测试',
    'https://competition-bureau.canada.ca/en/deceptive-marketing-practices/types-deceptive-marketing-practices/performance-claims-not-based-adequate-and-proper-test',
  ],
  au_green: [
    'ACCC：企业环保宣称指南',
    'https://www.accc.gov.au/about-us/publications/a-guide-to-making-environmental-claims-for-business',
  ],
  au_origin: [
    'ACCC：产地宣称',
    'https://www.accc.gov.au/business/advertising-and-promotions/country-of-origin-claims',
  ],
  au_reviews: [
    'ACCC：网上评价',
    'https://www.accc.gov.au/business/advertising-and-promotions/online-reviews-for-product-and-services',
  ],
  tga: [
    'TGA：治疗用品广告守则',
    'https://www.tga.gov.au/resources/guidance/applying-advertising-code-rules-general-requirements',
  ],
} as const satisfies Record<string, readonly [string, string]>

type Src = keyof typeof SRC

function rule(
  id: string,
  market: ClaimMarketGroup,
  category: ContentClaimRule['category'],
  pattern: string,
  reason: string,
  src: Src,
  regex = true,
): MarketClaimRule {
  const [source_title, source_url] = SRC[src]
  return {
    id,
    market,
    category,
    pattern,
    ...(regex ? { regex: true } : {}),
    reason,
    source_title,
    source_url,
  }
}

const ZH_ABS = '广告里不能用「最好 / 第一 / 顶级」这类绝对化用语。'
const EN_ABS = '「#1 / guaranteed / best in the world」这类说法要先有证据，拿不出就是误导。'
const ZH_MED = '普通商品不能说治疗、预防疾病。'
const GREEN_GENERIC =
  '笼统的环保说法（eco-friendly、环保）要改成具体、能证明的（比如「包装可回收」）。'

/** 自带的规则表（按市场分组；顺序即知识库里的展示顺序）。 */
export const MARKET_CLAIM_RULES: readonly MarketClaimRule[] = [
  // ── 通用：原 WP154 默认表，补出处 ──
  rule('abs_zh_best', 'global', 'absolute', '最好', ZH_ABS, 'cn_ad_law', false),
  rule('abs_zh_first', 'global', 'absolute', '第一品牌', ZH_ABS, 'cn_ad_law', false),
  rule('abs_zh_only', 'global', 'absolute', '唯一', ZH_ABS, 'cn_ad_law', false),
  rule('abs_zh_top', 'global', 'absolute', '顶级', ZH_ABS, 'cn_ad_law', false),
  rule('abs_zh_lowest', 'global', 'absolute', '全网最低', ZH_ABS, 'cn_ad_law', false),
  rule('abs_zh_never', 'global', 'absolute', '永不', ZH_ABS, 'cn_ad_law', false),
  rule(
    'abs_zh_100',
    'global',
    'absolute',
    '100%',
    '「100%」是绝对化说法，要有证据才能写。',
    'cn_ad_law',
    false,
  ),
  rule('abs_en_best', 'global', 'absolute', '\\bbest in the world\\b', EN_ABS, 'ftc_subst'),
  rule('abs_en_no1', 'global', 'absolute', '#1', EN_ABS, 'ftc_subst', false),
  rule('abs_en_guarantee', 'global', 'absolute', '\\bguarantee(d)?\\b', EN_ABS, 'ftc_subst'),
  rule('abs_en_never', 'global', 'absolute', '\\bnever (fails|breaks)\\b', EN_ABS, 'ftc_subst'),
  rule('med_zh_cure', 'global', 'medical', '治愈', ZH_MED, 'cn_ad_law', false),
  rule('med_zh_treat', 'global', 'medical', '治疗', ZH_MED, 'cn_ad_law', false),
  rule('med_zh_prevent', 'global', 'medical', '预防疾病', ZH_MED, 'cn_ad_law', false),
  rule('med_zh_cancer', 'global', 'medical', '抗癌', ZH_MED, 'cn_ad_law', false),
  rule(
    'med_en_cure',
    'global',
    'medical',
    '\\b(cures?|heals?|treats?) (disease|cancer|diabetes|anxiety|insomnia)\\b',
    '普通商品不能说能治病（cure / treat …），健康功效要有人体试验级别的证据。',
    'ftc_health',
  ),
  rule(
    'med_en_fda',
    'global',
    'medical',
    '\\bfda[- ]approved\\b',
    '「FDA approved」要真有批文；大多数商品根本不经 FDA 审批。',
    'ftc_health',
  ),
  // ── 美国（FTC）──
  rule(
    'us.unproven_efficacy',
    'us',
    'medical',
    '\\b(clinically|scientifically|doctor)[- ](proven|tested|recommended)\\b',
    '说「临床证明 / 医生推荐」要有像样的人体临床试验撑着。',
    'ftc_health',
  ),
  rule(
    'us.made_in_usa',
    'us',
    'origin',
    '\\bmade in (the )?(usa|u\\.s\\.a\\.?|u\\.s\\.|america|united states)\\b',
    '写「Made in USA」要几乎全部在美国生产（最后组装和主要加工都在美国），否则要加限定说明。',
    'ftc_usa',
  ),
  rule(
    'us.endorsement',
    'us',
    'endorsement',
    '\\b(as seen on|featured in|recommended by|customers (say|love)|reviewers? (say|love))\\b',
    '引用评价、红人或媒体背书：要是真实的；有利益关系（送货、付费、亲友）要清楚披露。',
    'ftc_endorse',
  ),
  rule(
    'us.fake_reviews',
    'us',
    'endorsement',
    '\\b(5[- ]star|five[- ]star) reviews?\\b',
    '不能自己写、买或挑着放评价；星级与评价要照实。',
    'ftc_reviews',
  ),
  rule(
    'us.green_generic',
    'us',
    'green',
    '\\b(eco[- ]friendly|environmentally friendly|earth[- ]friendly|planet[- ]friendly)\\b',
    GREEN_GENERIC,
    'ftc_green',
  ),
  // ── 欧盟 / 英国 ──
  rule(
    'eu.green_generic',
    'eu_uk',
    'green',
    '\\b(eco[- ]friendly|environmentally friendly|climate[- ]friendly|planet[- ]friendly|earth[- ]friendly|good for the planet)\\b',
    '欧盟 2026-09-27 起禁止笼统的环保宣称（eco-friendly 等），除非有公认的卓越环保表现证明。',
    'eu_green',
  ),
  rule(
    'eu.offset_neutral',
    'eu_uk',
    'green',
    '\\b(carbon[- ]neutral|climate[- ]neutral|co2[- ]neutral|net[- ]zero|climate[- ]positive|carbon[- ]positive)\\b',
    '靠抵消（买碳汇）说「碳中和 / 气候中和」在欧盟一律禁止。',
    'eu_green',
  ),
  rule(
    'uk.green_claims',
    'eu_uk',
    'green',
    '\\b(sustainable|biodegradable|compostable|100% recyclable)\\b',
    '英国：环保宣称要具体、准确、考虑整个生命周期，并且拿得出证据。',
    'cma_green',
  ),
  rule(
    'eu.comparison',
    'eu_uk',
    'comparison',
    '\\b(better|faster|cheaper|stronger|longer[- ]lasting) than (any|all|other|competitors?|the competition|leading brands?)\\b',
    '和竞品比，要比同类商品、比能核实的具体指标，不能贬低对方。',
    'eu_compare',
  ),
  rule(
    'eu.superlative',
    'eu_uk',
    'absolute',
    "\\b(number one|no\\. ?1|world'?s best|unbeatable|best on the market)\\b",
    '「第一 / 无敌 / 市面最好」要先有文件证据，否则算误导消费者。',
    'cap3',
  ),
  rule(
    'uk.health',
    'eu_uk',
    'medical',
    '\\b(boosts? (your )?immun(e|ity)|detox(ifies)?|anti[- ]ageing)\\b',
    '只有持证药品或医疗器械能说治疗或预防；「增强免疫、排毒」这类健康说法要有证据。',
    'cap12',
  ),
  rule(
    'eu.misleading',
    'eu_uk',
    'other',
    '\\b(limited time only|only \\d+ left|last chance)\\b',
    '「限时 / 仅剩几件」要是真的，编出来的紧迫感在欧盟属于不公平商业行为。',
    'eu_ucpd',
  ),
  // ── 加拿大 ──
  rule(
    'ca.made_in_canada',
    'ca',
    'origin',
    '\\b(made in canada|product of canada)\\b',
    '「Product of Canada」要 98% 以上成本在加拿大；「Made in Canada」要 51% 以上，并加「含进口零件」这类说明。',
    'ca_origin',
  ),
  rule(
    'ca.performance',
    'ca',
    'performance',
    '\\b(lasts? (up to )?\\d+|\\d+x (faster|longer|stronger)|lab[- ]tested|tested to)\\b',
    '说性能、寿命、效果（「续航 10 小时」「快 3 倍」）要在说之前做过充分、恰当的测试。',
    'ca_perf',
  ),
  rule(
    'ca.green',
    'ca',
    'green',
    '\\b(eco[- ]friendly|environmentally friendly|carbon[- ]neutral|net[- ]zero|sustainable)\\b',
    '加拿大 2024 年起：环保宣称要有充分恰当的测试或按国际公认方法证明。',
    'ca_green',
  ),
  // ── 澳大利亚 ──
  rule(
    'au.made_in_australia',
    'au',
    'origin',
    '\\b(made in australia|australian[- ]made|product of australia)\\b',
    '「Made in Australia」要在澳洲完成最后一道实质性加工，简单包装不算。',
    'au_origin',
  ),
  rule(
    'au.green',
    'au',
    'green',
    '\\b(eco[- ]friendly|environmentally friendly|carbon[- ]neutral|sustainable|biodegradable|compostable)\\b',
    '环保宣称要真实、准确、有合理依据，别用笼统说法。',
    'au_green',
  ),
  rule(
    'au.reviews',
    'au',
    'endorsement',
    '\\b(5[- ]star|five[- ]star|customers love|reviewers? (say|love))\\b',
    '不能造假评价、压差评；拿好处换来的评价要披露。',
    'au_reviews',
  ),
  rule(
    'au.therapeutic',
    'au',
    'medical',
    '\\b(relieves?|soothes?) (pain|arthritis|headaches?|inflammation)\\b',
    '说缓解疼痛这类治疗性功效，要按药械广告规则来，普通商品不能说。',
    'tga',
  ),
]

/** 正则规则给人看的写法（界面不露正则）。 */
const LABELS: Readonly<Record<string, string>> = {
  abs_en_best: 'best in the world',
  abs_en_guarantee: 'guarantee、guaranteed',
  abs_en_never: 'never fails、never breaks',
  med_en_cure: 'cures / heals / treats + 疾病（disease、cancer…）',
  med_en_fda: 'FDA approved',
  'us.unproven_efficacy': 'clinically proven、scientifically tested、doctor recommended…',
  'us.made_in_usa': 'Made in USA、Made in America…',
  'us.endorsement': 'as seen on、featured in、customers love…',
  'us.fake_reviews': '5-star reviews、five-star reviews',
  'us.green_generic': 'eco-friendly、environmentally friendly…',
  'eu.green_generic': 'eco-friendly、climate-friendly、good for the planet…',
  'eu.offset_neutral': 'carbon neutral、climate neutral、net zero…',
  'uk.green_claims': 'sustainable、biodegradable、compostable、100% recyclable',
  'eu.comparison': 'better / cheaper … than competitors',
  'eu.superlative': 'number one、world’s best、unbeatable…',
  'uk.health': 'boosts immunity、detox、anti-ageing',
  'eu.misleading': 'limited time only、only 3 left、last chance',
  'ca.made_in_canada': 'Made in Canada、Product of Canada',
  'ca.performance': 'lasts up to 10…、3x faster、lab-tested',
  'ca.green': 'eco-friendly、carbon neutral、sustainable…',
  'au.made_in_australia': 'Made in Australia、Australian made',
  'au.green': 'eco-friendly、carbon neutral、biodegradable…',
  'au.reviews': '5-star、customers love…',
  'au.therapeutic': 'relieves pain、soothes arthritis…',
}
for (const r of MARKET_CLAIM_RULES) {
  const label = LABELS[r.id]
  if (label !== undefined) r.label = label
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
}): ResolvedClaimRules {
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
  for (const base of MARKET_CLAIM_RULES) {
    const card = byKey.get(base.id)
    const row = card === undefined ? undefined : rowOf(card, base)
    rows.push(row ?? { ...base, enabled: true, origin: 'builtin' })
  }
  for (const [key, card] of byKey) {
    if (BUILTIN.has(key)) continue
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
