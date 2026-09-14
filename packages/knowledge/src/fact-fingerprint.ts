/**
 * Extracted from KefuAgent `src/lib/support/knowledge/fact-fingerprint.ts`
 * （词表 / 单位表 / 闭集关键词 / 数值区间 / 归一化规则 / 集合比较代数），
 * rewritten for agentsws contracts（48 §4 #6）。
 *
 * **源页改了，要不要惊动人**——这是唯一的判据。
 *
 * 一篇帮助中心的文章今天换了个标题、加了段 SEO 文案、把"14 天"排版成 `**14 天**`，
 * 内容 hash 天天在变；真正该让人复核的只有**受管辖数值**变了那一次。所以先从正文里
 * 抽出五类数值做成"事实指纹"，源变了先比指纹：指纹一样就自动回鲜，只记一笔"源动过"；
 * 指纹不一样才把派生卡标成 `stale` 并开一张复核卡。
 *
 * 三条纪律照抄上游：
 * - **模型不参与这个判断**：纯函数，零 IO、零模型，同输入同输出，可零桩单测；
 * - **词表是冻结常量**：改词表必须同时 +1 `FACT_FINGERPRINT_VERSION`，
 *   否则升版会把全库刷成 stale；
 * - **宁可漏判也不误判**：闭集之外的措辞不产生指纹项 → 不触发复核，
 *   由 `stale` 标注与承诺类人审门兜底。误判的代价是改错口径，漏判只是少问一次。
 */

/** 词表 / 单位表 / 区间 / 归一化规则任何变更都必须 +1。 */
export const FACT_FINGERPRINT_VERSION = 1

/** 指纹里记版本的那个键（`FactCard.fact_fingerprint` 是一张扁平表）。 */
export const FINGERPRINT_VERSION_KEY = 'version'

export type FactCategory = 'duration' | 'money' | 'percent' | 'currency' | 'responsibility'

/** 类别枚举序：`categories` 恒按此序输出，保证确定性。 */
export const FACT_CATEGORIES: readonly FactCategory[] = [
  'duration',
  'money',
  'percent',
  'currency',
  'responsibility',
]

export type ResponsibilityFlag =
  | 'payer_customer'
  | 'payer_merchant'
  | 'payer_by_reason'
  | 'duty_ddp'
  | 'duty_customer'
  | 'non_refundable'
  | 'no_warranty'
  | 'restocking_fee'

export type FactItem =
  | { c: 'duration'; unit: 'day' | 'month' | 'year'; n: number }
  | { c: 'money'; currency: string; amount: number }
  | { c: 'percent'; n: number }
  | { c: 'currency'; currency: string }
  | { c: 'responsibility'; flag: ResponsibilityFlag }

/**
 * 落在 `FactCard.fact_fingerprint` 里的形态：`键 → 值` 的扁平表。
 *
 * 键是**归一化后的项**（`duration:day:30` / `money:USD:15` /
 * `responsibility:payer_customer`），值是好读的那一面（`30` / `15` / `payer_customer`）。
 * 比对只看键的集合——值只是给人看的。
 */
export type FactFingerprint = Record<string, string | number>

/**
 * `¥` / `￥` 歧义哨兵：正文里既没有 CNY / RMB / 人民币，也没有 JPY / 日元 的词面时，
 * 只记"出现了未定币种"，**不产生 money 项**——宁可少一项，也不误判币种
 * （误判会造出一个假的"币种变了"）。
 */
export const AMBIGUOUS_YEN_CURRENCY = 'YEN_AMBIGUOUS'

/* ------------------------------------------------------------------ */
/* 冻结词表与区间                                                       */
/* ------------------------------------------------------------------ */

/** 数值区间：超出即丢弃该项。噪声防线——`2026 年` 被 `year ≤ 10` 丢掉。 */
const DURATION_RANGE: Record<'day' | 'month' | 'year', number> = { day: 3650, month: 120, year: 10 }

/** 时间单位词面（小写匹配，长词面优先）。周 / week 归一化成 day（×7）。 */
const DURATION_UNITS: readonly { pattern: string; unit: 'day' | 'month' | 'year'; mul: number }[] =
  [
    { pattern: 'calendar days', unit: 'day', mul: 1 },
    { pattern: 'calendar day', unit: 'day', mul: 1 },
    { pattern: 'business days', unit: 'day', mul: 1 },
    { pattern: 'business day', unit: 'day', mul: 1 },
    { pattern: 'working days', unit: 'day', mul: 1 },
    { pattern: 'working day', unit: 'day', mul: 1 },
    { pattern: 'days', unit: 'day', mul: 1 },
    { pattern: 'day', unit: 'day', mul: 1 },
    { pattern: '个工作日', unit: 'day', mul: 1 },
    { pattern: '工作日', unit: 'day', mul: 1 },
    { pattern: '天', unit: 'day', mul: 1 },
    { pattern: 'weeks', unit: 'day', mul: 7 },
    { pattern: 'week', unit: 'day', mul: 7 },
    { pattern: '周', unit: 'day', mul: 7 },
    { pattern: '星期', unit: 'day', mul: 7 },
    { pattern: 'months', unit: 'month', mul: 1 },
    { pattern: 'month', unit: 'month', mul: 1 },
    { pattern: '个月', unit: 'month', mul: 1 },
    { pattern: 'years', unit: 'year', mul: 1 },
    { pattern: 'year', unit: 'year', mul: 1 },
  ]

/** `日` / `月` / `年` 单独作单位有歧义（日元 / 7月1日 / 2026年）：日期戳已在归一化里剔除。 */
const DURATION_CJK_LOOSE: readonly { pattern: string; unit: 'day' | 'month' | 'year' }[] = [
  { pattern: '日', unit: 'day' },
  { pattern: '月', unit: 'month' },
  { pattern: '年', unit: 'year' },
]

/** 币种码白名单：表外的三字母大写串不当币种（避免 FOR / NEW 误命中）。 */
const CURRENCY_CODES: readonly string[] = [
  'USD',
  'CAD',
  'AUD',
  'EUR',
  'GBP',
  'JPY',
  'CNY',
  'HKD',
  'SGD',
  'NZD',
  'CHF',
  'SEK',
  'MXN',
  'BRL',
  'INR',
  'KRW',
  'AED',
]

/** 符号 → 币种码（长符号优先；`¥` 走歧义规则）。 */
const CURRENCY_SYMBOLS: readonly { symbol: string; code: string }[] = [
  { symbol: 'us$', code: 'USD' },
  { symbol: 'ca$', code: 'CAD' },
  { symbol: 'a$', code: 'AUD' },
  { symbol: 'nz$', code: 'NZD' },
  { symbol: 'hk$', code: 'HKD' },
  { symbol: '$', code: 'USD' },
  { symbol: '€', code: 'EUR' },
  { symbol: '£', code: 'GBP' },
  { symbol: '¥', code: AMBIGUOUS_YEN_CURRENCY },
  { symbol: '₹', code: 'INR' },
]

/** 闭集责任方词表：表外措辞不产生任何项——漏判是设计。 */
const RESPONSIBILITY_KEYWORDS: readonly { flag: ResponsibilityFlag; words: readonly string[] }[] = [
  {
    flag: 'payer_customer',
    words: [
      'customer pays',
      'buyer pays',
      'at your own expense',
      "at the customer's expense",
      '客户自付',
      '买家自付',
      '由客户承担',
      '由买家承担',
      '运费自理',
      '自行承担',
    ],
  },
  {
    flag: 'payer_merchant',
    words: [
      'we pay',
      'we cover',
      'prepaid label',
      'free return',
      'free returns',
      'return shipping is free',
      '我们承担',
      '我们出',
      '包邮退',
      '免费退货',
      '预付标签',
    ],
  },
  {
    flag: 'payer_by_reason',
    words: [
      'depends on the reason',
      'defective items only',
      '质量问题我们',
      '视原因',
      '按原因',
      '非质量问题',
    ],
  },
  { flag: 'duty_ddp', words: ['ddp', 'duties included', 'duties paid', '关税已含', '包关税'] },
  {
    flag: 'duty_customer',
    words: ['duties are the responsibility', 'customs fees are', '关税由客户', '清关费由'],
  },
  {
    flag: 'non_refundable',
    words: ['non-refundable', 'non refundable', 'not refundable', '不可退款', '不退款', '概不退款'],
  },
  { flag: 'no_warranty', words: ['no warranty', 'without warranty', '不提供保修', '无保修'] },
  {
    flag: 'restocking_fee',
    words: ['restocking fee', 'restocking charge', '重新入库费', '手续费'],
  },
]

/* ------------------------------------------------------------------ */
/* 归一化                                                              */
/* ------------------------------------------------------------------ */

const escapeRegExp = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 日期戳整段剔除：`Last updated 2026-07-25` / `2026年7月1日` 之类一律不得产生
 * duration 项。年份本身另有 `year ≤ 10` 兜底，但 `7月1日` 的月 / 日必须靠这一步。
 */
function stripDateStamps(text: string): string {
  return text
    .replace(/\d{4}\s*年\s*\d{1,2}\s*月(\s*\d{1,2}\s*日)?/g, ' ')
    .replace(/\d{4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}/g, ' ')
    .replace(/\d{1,2}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{4}/g, ' ')
    .replace(/\d{4}\s*年/g, ' ')
}

/**
 * 文本归一化（冻结）：NFKC → 去 HTML / markdown 标记 → 去链接 → 去日期戳 →
 * 折叠空白 → 小写。**措辞、排版、大小写、链接、SEO 文案一律不产生指纹项。**
 */
export function normalizeFactText(input: string): string {
  let text = (input ?? '').normalize('NFKC')
  text = text.replace(/<[^>]*>/g, ' ').replace(/&[a-z]{2,10};/gi, ' ')
  text = text.replace(/\]\([^)\s]*\)/g, '] ')
  text = text.replace(/https?:\/\/\S+/gi, ' ')
  text = text.replace(/\bwww\.\S+/gi, ' ')
  text = text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ')
  text = text.replace(/[*_#>|`~]+/g, ' ')
  text = stripDateStamps(text)
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function parseAmount(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const n = Number.parseFloat(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/* ------------------------------------------------------------------ */
/* 抽取                                                                */
/* ------------------------------------------------------------------ */

interface Span {
  start: number
  end: number
}

function extractDurations(text: string): FactItem[] {
  const items: FactItem[] = []
  const alternation = [
    ...DURATION_UNITS.map((u) => escapeRegExp(u.pattern)),
    ...DURATION_CJK_LOOSE.map((u) => escapeRegExp(u.pattern)),
  ].join('|')
  const re = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)[ -]?(${alternation})`, 'g')
  for (const match of text.matchAll(re)) {
    const amount = parseAmount(match[1])
    const word = match[2]
    if (amount === null || word === undefined) continue
    // `30日元` / `30月元` 是币种词面，不是期限
    const after = text.slice((match.index ?? 0) + match[0].length)
    if ((word === '日' || word === '月') && after.startsWith('元')) continue
    const strict = DURATION_UNITS.find((u) => u.pattern === word)
    const loose = DURATION_CJK_LOOSE.find((u) => u.pattern === word)
    const unit = strict?.unit ?? loose?.unit
    if (unit === undefined) continue
    const n = Math.round(amount * (strict?.mul ?? 1) * 100) / 100
    if (n <= 0 || n > DURATION_RANGE[unit]) continue
    items.push({ c: 'duration', unit, n })
  }
  return items
}

const currencyWordFor = (text: string): 'CNY' | 'JPY' | null => {
  if (/\bcny\b|\brmb\b|人民币/.test(text)) return 'CNY'
  if (/\bjpy\b|日元/.test(text)) return 'JPY'
  return null
}

function extractMoney(text: string): { items: FactItem[]; spans: Span[]; ambiguousYen: boolean } {
  const items: FactItem[] = []
  const spans: Span[] = []
  let ambiguousYen = false
  const yen = currencyWordFor(text)
  const codes = CURRENCY_CODES.map((c) => c.toLowerCase()).join('|')

  const symbolRe = new RegExp(
    `(${CURRENCY_SYMBOLS.map((s) => escapeRegExp(s.symbol)).join('|')})\\s?(\\d[\\d,]*(?:\\.\\d+)?)`,
    'g',
  )
  for (const match of text.matchAll(symbolRe)) {
    const entry = CURRENCY_SYMBOLS.find((s) => s.symbol === match[1])
    const amount = parseAmount(match[2])
    if (entry === undefined || amount === null) continue
    const start = match.index ?? 0
    spans.push({ start, end: start + match[0].length })
    if (entry.code === AMBIGUOUS_YEN_CURRENCY) {
      if (yen === null) {
        ambiguousYen = true
        continue
      }
      items.push({ c: 'money', currency: yen, amount })
      continue
    }
    items.push({ c: 'money', currency: entry.code, amount })
  }

  for (const match of text.matchAll(new RegExp(`\\b(${codes})\\s?(\\d[\\d,]*(?:\\.\\d+)?)`, 'g'))) {
    const amount = parseAmount(match[2])
    if (amount === null || match[1] === undefined) continue
    const start = match.index ?? 0
    spans.push({ start, end: start + match[0].length })
    items.push({ c: 'money', currency: match[1].toUpperCase(), amount })
  }
  for (const match of text.matchAll(new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s?(${codes})\\b`, 'g'))) {
    const amount = parseAmount(match[1])
    if (amount === null || match[2] === undefined) continue
    const start = match.index ?? 0
    spans.push({ start, end: start + match[0].length })
    items.push({ c: 'money', currency: match[2].toUpperCase(), amount })
  }
  return { items, spans, ambiguousYen }
}

function extractPercent(text: string): FactItem[] {
  const items: FactItem[] = []
  const push = (raw: number): void => {
    const n = Math.round(raw * 10) / 10
    if (n <= 0 || n > 100) return
    items.push({ c: 'percent', n })
  }
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s?%/g)) {
    const a = parseAmount(m[1])
    if (a !== null) push(a)
  }
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s?percent\b/g)) {
    const a = parseAmount(m[1])
    if (a !== null) push(a)
  }
  return items
}

/** 独立出现的币种声明（不挨着金额的那些）。 */
function extractStandaloneCurrency(
  text: string,
  moneySpans: readonly Span[],
  ambiguousYen: boolean,
): FactItem[] {
  const items: FactItem[] = []
  if (ambiguousYen) items.push({ c: 'currency', currency: AMBIGUOUS_YEN_CURRENCY })
  const codes = CURRENCY_CODES.map((c) => c.toLowerCase()).join('|')
  for (const m of text.matchAll(new RegExp(`\\b(${codes})\\b`, 'g'))) {
    const start = m.index ?? 0
    const inside = moneySpans.some((s) => start >= s.start && start < s.end)
    if (inside || m[1] === undefined) continue
    items.push({ c: 'currency', currency: m[1].toUpperCase() })
  }
  return items
}

function extractResponsibility(text: string): FactItem[] {
  const items: FactItem[] = []
  for (const entry of RESPONSIBILITY_KEYWORDS) {
    if (entry.words.some((w) => text.includes(w.toLowerCase())))
      items.push({ c: 'responsibility', flag: entry.flag })
  }
  return items
}

/* ------------------------------------------------------------------ */
/* 指纹                                                                */
/* ------------------------------------------------------------------ */

/** 稳定键：同一组事实的指纹逐字节稳定（集合语义就靠它）。 */
export function factItemKey(item: FactItem): string {
  if (item.c === 'duration') return `duration:${item.unit}:${item.n}`
  if (item.c === 'money') return `money:${item.currency}:${item.amount}`
  if (item.c === 'percent') return `percent:${item.n}`
  if (item.c === 'currency') return `currency:${item.currency}`
  return `responsibility:${item.flag}`
}

const factItemValue = (item: FactItem): string | number => {
  if (item.c === 'duration') return item.n
  if (item.c === 'money') return item.amount
  if (item.c === 'percent') return item.n
  if (item.c === 'currency') return item.currency
  return item.flag
}

/** 键前缀就是类别。 */
export function categoryOfKey(key: string): FactCategory | undefined {
  const head = key.split(':')[0]
  return FACT_CATEGORIES.find((c) => c === head)
}

/**
 * 从一段正文抽出事实指纹。
 *
 * 只对**提取结果的文本**算（卡片的 statement / 源的正文），不要对整页原始 HTML 算
 * ——那是噪声源。
 */
export function extractFactFingerprint(input: string): FactFingerprint {
  const text = normalizeFactText(input)
  const out: FactFingerprint = { [FINGERPRINT_VERSION_KEY]: FACT_FINGERPRINT_VERSION }
  if (text === '') return out
  const money = extractMoney(text)
  const items = [
    ...extractDurations(text),
    ...money.items,
    ...extractPercent(text),
    ...extractStandaloneCurrency(text, money.spans, money.ambiguousYen),
    ...extractResponsibility(text),
  ]
  for (const item of items) out[factItemKey(item)] = factItemValue(item)
  return out
}

export const emptyFactFingerprint = (): FactFingerprint => ({
  [FINGERPRINT_VERSION_KEY]: FACT_FINGERPRINT_VERSION,
})

export const fingerprintVersionOf = (fp: FactFingerprint | undefined): number => {
  const v = fp?.[FINGERPRINT_VERSION_KEY]
  return typeof v === 'number' ? v : 0
}

const itemKeys = (fp: FactFingerprint): string[] =>
  Object.keys(fp).filter((k) => k !== FINGERPRINT_VERSION_KEY)

export interface MaterialChangeVerdict {
  /** 受管辖数值真的变了。 */
  material: boolean
  /** 命中的类别（恒按 `FACT_CATEGORIES` 序）。 */
  categories: FactCategory[]
  added: string[]
  removed: string[]
  /** 词表升版了：一律判非实质，避免升版引发全库复核风暴。 */
  version_mismatch: boolean
}

/**
 * 类型化集合比较：
 * 1. 版本不一致 → 非实质；
 * 2. 逐类别集合差异非空 → 实质；
 * 3. 两侧皆空 → 非实质；
 * 4. 任一侧为空（改版后抽不出事实 / 历史卡没有左值）→ 非实质，只标 stale。
 */
export interface DiffOptions {
  /**
   * 只比**左值已经有的那几类**。
   *
   * 源页新加了一段"满 $50 包邮"，不该把一条只讲退货天数的卡标成过时——它讲的那件事
   * 页面上一个字没改。只有卡自己关心的类别变了才算数。
   */
  restrict_to_before_categories?: boolean
}

export function diffFactFingerprints(
  before: FactFingerprint | undefined,
  after: FactFingerprint | undefined,
  options: DiffOptions = {},
): MaterialChangeVerdict {
  const empty: MaterialChangeVerdict = {
    material: false,
    categories: [],
    added: [],
    removed: [],
    version_mismatch: false,
  }
  if (before === undefined || after === undefined) return empty
  if (fingerprintVersionOf(before) !== fingerprintVersionOf(after))
    return { ...empty, version_mismatch: true }

  const beforeKeys = itemKeys(before)
  const afterKeys = itemKeys(after)
  if (beforeKeys.length === 0 || afterKeys.length === 0) return empty

  const beforeCategories = new Set(beforeKeys.map(categoryOfKey))
  const categories: FactCategory[] = []
  const added: string[] = []
  const removed: string[] = []
  for (const category of FACT_CATEGORIES) {
    if (options.restrict_to_before_categories === true && !beforeCategories.has(category)) continue
    const b = beforeKeys.filter((k) => categoryOfKey(k) === category)
    const a = afterKeys.filter((k) => categoryOfKey(k) === category)
    const catAdded = a.filter((k) => !b.includes(k))
    const catRemoved = b.filter((k) => !a.includes(k))
    if (catAdded.length === 0 && catRemoved.length === 0) continue
    categories.push(category)
    added.push(...catAdded)
    removed.push(...catRemoved)
  }
  return { material: categories.length > 0, categories, added, removed, version_mismatch: false }
}

/** 给复核卡写人话用。 */
export function describeFactCategoryZh(category: FactCategory): string {
  switch (category) {
    case 'duration':
      return '期限'
    case 'money':
      return '金额'
    case 'percent':
      return '比例'
    case 'currency':
      return '币种'
    default:
      return '责任方'
  }
}

/** `duration:day:14` → `期限 14 天`。给人看的那一面。 */
export function describeFactKeyZh(key: string): string {
  const [c, a, b] = key.split(':')
  if (c === 'duration') {
    const unit = a === 'day' ? '天' : a === 'month' ? '个月' : '年'
    return `期限 ${b}${unit}`
  }
  if (c === 'money') return `金额 ${a} ${b}`
  if (c === 'percent') return `比例 ${a}%`
  if (c === 'currency') return `币种 ${a}`
  if (c === 'responsibility') return `责任方 ${a}`
  return key
}
