/**
 * WP398（docs/106 §5.6 / §13 A8）：Amazon 词库的纯逻辑——拆词、归一化、认他牌名、并进词库、算差距。
 *
 * - **拆词**：标题 / 五点按标点切段，停用词、品牌名、数字开头的规格（`750w`、`48v`）当断点，
 *   段里取 2–3 个词的词组；整段只有一个词的也留（`adults`）。
 * - **归一化**：小写、去连字符（`e-bike` → `ebike`）、英文单复数（`batteries` → `battery`）、去停用词；
 *   键是归一化后的词，显示用第一次见到的写法。非英文站只做小写 / 切词（一期按英文站调）。
 * - **他牌名**：竞品名、Listing 上读到的品牌名都算；拆 Listing 时当断点去掉，联想词里出现了就标出来
 *   （{@link AmazonKeyword.other_brand}：不能填进后台关键词）。
 * - **差距**：Amazon 按词收录——竞品的一个词组，自家标题 / 五点里**缺任何一个词**就算「你没有」。
 *   按出现在几家竞品里排（一期唯一的排序：没有搜索量）；同一串词只留覆盖最多、最长的那一个。
 *
 * 一期不估任何数字：`metrics` 一律不填。
 */
import type {
  AmazonKeyword,
  AmazonKeywordGap,
  AmazonKeywordGapTerm,
  AmazonKeywordMark,
  AmazonKeywordRow,
  AmazonKeywordSeen,
  AmazonKeywordSource,
  AmazonListingText,
  Iso8601,
} from '@agentsws/contracts'
import { AMAZON_KEYWORD_SOURCES } from '@agentsws/contracts'
import { builtinContentTable, readContentTable } from '@agentsws/core'
import LEXICON_FILE from './amazon-keywords.content.json' with { type: 'json' }

/* ── 站点与语言 ───────────────────────────────────────────────────── */

const LANG: Readonly<Record<string, string>> = {
  US: 'en',
  CA: 'en',
  GB: 'en',
  UK: 'en',
  AU: 'en',
  IN: 'en',
  SG: 'en',
  AE: 'en',
  DE: 'de',
  FR: 'fr',
  BE: 'fr',
  IT: 'it',
  ES: 'es',
  MX: 'es',
  NL: 'nl',
  SE: 'sv',
  PL: 'pl',
  TR: 'tr',
  BR: 'pt',
  JP: 'ja',
  SA: 'ar',
  EG: 'ar',
}

/** 站点 → 语言（认不出当英文）。 */
export function amazonLanguageOf(marketplace: string): string {
  return LANG[marketplace.trim().toUpperCase()] ?? 'en'
}

/** 站点写法统一（`uk` → `GB`）。 */
export function amazonMarketOf(marketplace: string): string {
  const m = marketplace.trim().toUpperCase()
  return m === 'UK' ? 'GB' : m
}

/* ── 切词与归一化 ─────────────────────────────────────────────────── */

/**
 * WP404（docs/107 §3）：两张英文词表是数据（`amazon-keywords.content.json`：`stop_en` 停用词——当断点、
 * 不进键；`keep_s` 结尾是 s 但不是复数的词），这里只管用。按品牌可覆盖：`readContentTable`。
 */
interface LexiconRow {
  id: string
  list: 'stop_en' | 'keep_s'
  word: string
}

const LEXICON_TABLE = builtinContentTable<LexiconRow>(LEXICON_FILE)

const isLexiconRow = (r: unknown): r is LexiconRow =>
  ((r as LexiconRow).list === 'stop_en' || (r as LexiconRow).list === 'keep_s') &&
  typeof (r as LexiconRow).word === 'string'

interface Lexicon {
  stop: ReadonlySet<string>
  keepS: ReadonlySet<string>
}

const lexiconCache = new WeakMap<readonly LexiconRow[], Lexicon>()

/** 这一次用的两张词表（同一份行只建一次 Set）。 */
function lexicon(brand?: string): Lexicon {
  const rows = readContentTable(LEXICON_TABLE, { brand, accepts: isLexiconRow })
  let hit = lexiconCache.get(rows)
  if (hit === undefined) {
    hit = {
      stop: new Set(rows.filter((r) => r.list === 'stop_en').map((r) => r.word)),
      keepS: new Set(rows.filter((r) => r.list === 'keep_s').map((r) => r.word)),
    }
    lexiconCache.set(rows, hit)
  }
  return hit
}

/** 英文复数 → 单数（只管常见规则；键用的，不用于显示）。 */
export function singularEn(word: string): string {
  return singularWith(word, lexicon().keepS)
}

function singularWith(word: string, keepS: ReadonlySet<string>): string {
  const w = word
  if (w.length <= 3 || keepS.has(w)) return w
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`
  if (w.endsWith('sses')) return w.slice(0, -2)
  if (/(ches|shes|xes|zes)$/.test(w)) return w.slice(0, -2)
  if (/(ss|us|is)$/.test(w)) return w
  if (w.endsWith('s')) return w.slice(0, -1)
  return w
}

/** 一个词的小写写法（去连字符、去两头的引号）；空的回 `''`。 */
function cleanWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[’'`]s$/u, '')
    .replace(/^[’'"`]+|[’'"`]+$/gu, '')
    .replace(/(\p{L})-(?=\p{L})/gu, '$1')
}

/** 切段的标点（逗号、竖线、分号、冒号、括号、斜杠、破折号、项目符号、感叹 / 问号、句号后空格）。 */
const SEGMENT_RE = /[,|;:()[\]{}/\\!?•·–—]+|\s-\s|\.\s|\.$|\n/u

/** 一段字 → 原样的词（只留字母 / 数字 / 连字符 / 撇号；去两头的引号与连字符），显示用。 */
function rawWordsOf(segment: string): string[] {
  return segment
    .split(/[^\p{L}\p{N}'’-]+/u)
    .map((w) => w.replace(/^[’'"`-]+|[’'"`-]+$/gu, '').toLowerCase())
    .filter((w) => cleanWord(w) !== '')
}

/** 一段字 → 小写、去连字符的词（键用）。 */
function wordsOf(segment: string): string[] {
  return rawWordsOf(segment).map(cleanWord)
}

const isSpecToken = (w: string): boolean => /^\p{N}/u.test(w)

export interface KeywordContext {
  language: string
  /** 品牌名（这条文本自己的 + 已知的别家），拆词时当断点去掉。 */
  brands: readonly string[]
  /** WP404：这次在哪个品牌里（词表按品牌可覆盖；不给 = 随软件带的那一份）。 */
  brand?: string
}

/** 品牌名 → 归一化后的词序列（`Rad Power Bikes` → `rad power bike`）。 */
export function brandTokens(names: readonly string[], language = 'en'): string[][] {
  const out: string[][] = []
  for (const n of names) {
    const ws = wordsOf(n).map((w) => (language === 'en' ? singularEn(w) : w))
    if (ws.length > 0 && !out.some((o) => o.join(' ') === ws.join(' '))) out.push(ws)
  }
  // 长的先认（`rad power bike` 先于 `rad`）
  return out.sort((a, b) => b.length - a.length)
}

/** 一个词的键（英文按单复数归一）。 */
export function keyWord(word: string, language: string): string {
  const w = cleanWord(word)
  return language === 'en' ? singularEn(w) : w
}

/** 一串字的归一化键（停用词不进键）。联想词整句当一个词时用。 */
export function normalizeKeyword(text: string, language = 'en'): string {
  const stop = language === 'en' ? lexicon().stop : undefined
  return wordsOf(text)
    .map((w) => (language === 'en' ? singularEn(w) : w))
    .filter((w) => stop === undefined || !stop.has(w))
    .join(' ')
}

/** 这串归一化的词里，从 `i` 起是不是某个品牌；是的话回那个品牌占几个词。 */
function brandAt(keys: readonly string[], i: number, brands: readonly string[][]): number {
  for (const b of brands) {
    if (b.length === 0 || i + b.length > keys.length) continue
    let hit = true
    for (let j = 0; j < b.length; j++)
      if (keys[i + j] !== b[j]) {
        hit = false
        break
      }
    if (hit) return b.length
  }
  return 0
}

/** 拆出来的一个词组。 */
export interface ExtractedPhrase {
  norm: string
  term: string
}

type Run = { raw: string; key: string }[]

/** 一段字按断点（停用词、品牌名、数字开头的规格、太短的词）切成几串。 */
function runsOf(segment: string, ctx: KeywordContext, brands: readonly string[][]): Run[] {
  const en = ctx.language === 'en'
  const lex = lexicon(ctx.brand)
  const raw = rawWordsOf(segment)
  const keys = raw.map((w) => (en ? singularWith(cleanWord(w), lex.keepS) : cleanWord(w)))
  const runs: Run[] = []
  let cur: Run = []
  const cut = (): void => {
    if (cur.length > 0) runs.push(cur)
    cur = []
  }
  for (let i = 0; i < keys.length; ) {
    const b = brandAt(keys, i, brands)
    if (b > 0) {
      cut()
      i += b
      continue
    }
    const k = keys[i] ?? ''
    if ((en && lex.stop.has(k)) || isSpecToken(k) || k.length < 2) cut()
    else cur.push({ raw: raw[i] ?? '', key: k })
    i += 1
  }
  cut()
  return runs
}

/**
 * 一段文本 → 词组（2–3 个词；整段只有一个词的也留）。停用词、品牌名、数字开头的规格当断点。
 */
export function extractPhrases(text: string, ctx: KeywordContext): ExtractedPhrase[] {
  const brands = brandTokens(ctx.brands, ctx.language)
  const out = new Map<string, string>()
  for (const segment of text.split(SEGMENT_RE))
    for (const run of runsOf(segment, ctx, brands)) {
      if (run.length === 1) {
        const only = run[0]
        if (only !== undefined && only.key.length >= 3 && !out.has(only.key))
          out.set(only.key, only.raw)
        continue
      }
      for (let n = 2; n <= 3; n++)
        for (let i = 0; i + n <= run.length; i++) {
          const part = run.slice(i, i + n)
          // WP420（自查 B10）：同一个词在词组里出现两次的不要（「power station power」是标题里同一个词组重复拼出来的）
          if (new Set(part.map((p) => p.key)).size < part.length) continue
          const norm = part.map((p) => p.key).join(' ')
          if (!out.has(norm)) out.set(norm, part.map((p) => p.raw).join(' '))
        }
    }
  return [...out].map(([norm, term]) => ({ norm, term }))
}

/**
 * 自家商品标题 → 联想词的种子词：标题第一段（逗号 / 破折号前）里最长的一串，取最后 3 个词
 * （英文中心词在后：`Nordvolt Portable Power Station 1000W` → `portable power station`）。认不出回 `undefined`。
 */
export function seedFromTitle(title: string, ctx: KeywordContext): string | undefined {
  const brands = brandTokens(ctx.brands, ctx.language)
  const first = title.split(SEGMENT_RE).find((seg) => seg.trim() !== '') ?? ''
  const runs = runsOf(first, ctx, brands)
  let best: Run | undefined
  for (const r of runs) if (best === undefined || r.length > best.length) best = r
  if (best === undefined) return undefined
  const words = best.slice(-3).map((w) => w.raw)
  const seed = words.join(' ').trim()
  return seed.length >= 3 ? seed : undefined
}

/** 归一化后，这个词里是不是含了某个别家品牌；含的话回品牌原名。 */
export function otherBrandIn(
  norm: string,
  others: readonly string[],
  language = 'en',
): string | undefined {
  const keys = norm.split(' ')
  for (const name of others) {
    const [b] = brandTokens([name], language)
    if (b === undefined) continue
    for (let i = 0; i + b.length <= keys.length; i++)
      if (b.every((w, j) => keys[i + j] === w)) return name.trim()
  }
  return undefined
}

/* ── 进词库 ───────────────────────────────────────────────────────── */

/** 见到一次（一条联想词 / 从一条 Listing 里拆出的一个词组）。 */
export interface KeywordSighting {
  norm: string
  term: string
  marketplace: string
  source: AmazonKeywordSource
  competitor_id?: string
  competitor?: string
  asin?: string
  prefix?: string
  field?: 'title' | 'bullets'
  other_brand?: string
}

/** 一条 Listing 文本 → 拆出来的词组（标题、五点分开记；品牌名都去掉）。 */
export function sightingsFromListing(
  text: AmazonListingText,
  knownBrands: readonly string[],
): KeywordSighting[] {
  const marketplace = amazonMarketOf(text.marketplace)
  const language = amazonLanguageOf(marketplace)
  const brands = [
    ...knownBrands,
    ...(text.brand === undefined ? [] : [text.brand]),
    ...(text.competitor === undefined ? [] : [text.competitor]),
  ]
  const source: AmazonKeywordSource = text.side === 'own' ? 'own_listing' : 'competitor_listing'
  const base = {
    marketplace,
    source,
    asin: text.asin,
    ...(text.competitor_id === undefined ? {} : { competitor_id: text.competitor_id }),
    ...(text.competitor === undefined ? {} : { competitor: text.competitor }),
  }
  const out: KeywordSighting[] = []
  const seen = new Set<string>()
  const fields: ['title' | 'bullets', string][] = [
    ['title', text.title],
    ['bullets', (text.bullets ?? []).join('\n')],
  ]
  for (const [field, body] of fields)
    for (const p of extractPhrases(body, { language, brands })) {
      if (seen.has(p.norm)) continue
      seen.add(p.norm)
      out.push({ ...base, norm: p.norm, term: p.term, field })
    }
  return out
}

/** 联想词 → 词（整句当一个词；含别家品牌的标出来，自家品牌不算）。 */
export function sightingsFromSuggestions(
  suggestions: readonly string[],
  ctx: { marketplace: string; prefix: string; ownBrand?: string; otherBrands: readonly string[] },
): KeywordSighting[] {
  const marketplace = amazonMarketOf(ctx.marketplace)
  const language = amazonLanguageOf(marketplace)
  const own = ctx.ownBrand === undefined ? undefined : normalizeKeyword(ctx.ownBrand, language)
  const others = ctx.otherBrands.filter(
    (b) => own === undefined || normalizeKeyword(b, language) !== own,
  )
  const out: KeywordSighting[] = []
  for (const s of suggestions) {
    const norm = normalizeKeyword(s, language)
    if (norm === '' || out.some((o) => o.norm === norm)) continue
    const other = otherBrandIn(norm, others, language)
    out.push({
      norm,
      term: s.replace(/\s+/g, ' ').trim().toLowerCase(),
      marketplace,
      source: 'autocomplete',
      prefix: ctx.prefix,
      ...(other === undefined ? {} : { other_brand: other }),
    })
  }
  return out
}

/** 每个词最多记几处出处（联想词前缀多的，旧的挤掉）。 */
export const KEYWORD_SEEN_MAX = 20

const seenKey = (s: {
  source: string
  competitor_id?: string | undefined
  asin?: string | undefined
  prefix?: string | undefined
  field?: string | undefined
}): string =>
  [s.source, s.competitor_id ?? '', s.asin ?? '', s.prefix ?? '', s.field ?? ''].join('|')

const sortSources = (xs: Iterable<AmazonKeywordSource>): AmazonKeywordSource[] => {
  const set = new Set(xs)
  return AMAZON_KEYWORD_SOURCES.filter((s) => set.has(s))
}

/** 把这一批见到的并进词库（同 id 的更新时间与出处；新词进库）。回新词库与新进了几个。 */
export function mergeSightings(
  bank: readonly AmazonKeyword[],
  sightings: readonly KeywordSighting[],
  now: Iso8601,
): { bank: AmazonKeyword[]; added: number } {
  const byId = new Map(bank.map((k) => [k.id, { ...k, seen: [...k.seen] }]))
  let added = 0
  for (const s of sightings) {
    const id = `${s.marketplace}:${s.norm}`
    let k = byId.get(id)
    if (k === undefined) {
      k = {
        id,
        term: s.term,
        norm: s.norm,
        marketplace: s.marketplace,
        language: amazonLanguageOf(s.marketplace),
        sources: [],
        seen: [],
        first_seen_at: now,
        last_seen_at: now,
        marks: [],
      }
      byId.set(id, k)
      added += 1
    }
    k.sources = sortSources([...k.sources, s.source])
    k.last_seen_at = now
    if (s.other_brand !== undefined) k.other_brand = s.other_brand
    const entry: AmazonKeywordSeen = {
      source: s.source,
      ...(s.competitor_id === undefined ? {} : { competitor_id: s.competitor_id }),
      ...(s.competitor === undefined ? {} : { competitor: s.competitor }),
      ...(s.asin === undefined ? {} : { asin: s.asin }),
      ...(s.prefix === undefined ? {} : { prefix: s.prefix }),
      ...(s.field === undefined ? {} : { field: s.field }),
      first_seen_at: now,
      last_seen_at: now,
    }
    const key = seenKey(entry)
    const old = k.seen.find((x) => seenKey(x) === key)
    if (old !== undefined) old.last_seen_at = now
    else k.seen = [...k.seen, entry].slice(-KEYWORD_SEEN_MAX)
  }
  return { bank: [...byId.values()], added }
}

/** 改标记：加 / 去（`core` 与 `exclude` 互斥：标了一个就去掉另一个）。 */
export function applyMarks(
  k: AmazonKeyword,
  add: readonly AmazonKeywordMark[],
  remove: readonly AmazonKeywordMark[],
  now: Iso8601,
): AmazonKeyword {
  let marks = k.marks.filter((m) => !remove.includes(m))
  for (const m of add) {
    if (m === 'core') marks = marks.filter((x) => x !== 'exclude')
    if (m === 'exclude') marks = marks.filter((x) => x !== 'core')
    if (!marks.includes(m)) marks.push(m)
  }
  return { ...k, marks, marked_at: now }
}

/* ── 差距：竞品有、你没有 ─────────────────────────────────────────── */

/** 一条 Listing 文本里出现过的所有词（归一化后；品牌名也在——它只是不进键，不影响「写没写」）。 */
export function wordsInListing(text: AmazonListingText): Set<string> {
  const language = amazonLanguageOf(amazonMarketOf(text.marketplace))
  const all = [text.title, ...(text.bullets ?? [])].join(' ')
  return new Set(wordsOf(all).map((w) => (language === 'en' ? singularEn(w) : w)))
}

/** 竞品是谁（同一家的几个 ASIN 只算一家）。 */
const competitorKey = (t: AmazonListingText): string => t.competitor_id ?? `asin:${t.asin}`

interface CompetitorPhrase {
  norm: string
  term: string
  competitors: Set<string>
  names: Set<string>
  asins: Set<string>
}

/** 每个站点：竞品文本里拆出的词组 → 出现在哪几家。 */
export function competitorPhrases(
  competitors: readonly AmazonListingText[],
  knownBrands: readonly string[],
): Map<string, Map<string, CompetitorPhrase>> {
  const byMarket = new Map<string, Map<string, CompetitorPhrase>>()
  for (const t of competitors) {
    const m = amazonMarketOf(t.marketplace)
    let map = byMarket.get(m)
    if (map === undefined) {
      map = new Map()
      byMarket.set(m, map)
    }
    for (const s of sightingsFromListing(t, knownBrands)) {
      let p = map.get(s.norm)
      if (p === undefined) {
        p = {
          norm: s.norm,
          term: s.term,
          competitors: new Set(),
          names: new Set(),
          asins: new Set(),
        }
        map.set(s.norm, p)
      }
      p.competitors.add(competitorKey(t))
      if (t.competitor !== undefined) p.names.add(t.competitor)
      p.asins.add(t.asin)
    }
  }
  return byMarket
}

/** 每个自家 ASIN 最多列几个差距词。 */
export const GAP_TERMS_MAX = 100

/** a 的词是不是连续地出现在 b 里。 */
const within = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length > b.length) return false
  for (let i = 0; i + a.length <= b.length; i++) if (a.every((w, j) => b[i + j] === w)) return true
  return false
}

/**
 * 每个自家 ASIN：竞品标题 / 五点里出现、自家标题 / 五点里缺词的词组，按出现在几家竞品里从多到少。
 * 同一串词只留一个（覆盖最多、同数取最长的）。只和同一站点的竞品比。
 */
export function computeKeywordGaps(input: {
  own: readonly AmazonListingText[]
  competitors: readonly AmazonListingText[]
  knownBrands: readonly string[]
  now: Iso8601
}): AmazonKeywordGap[] {
  const phrases = competitorPhrases(input.competitors, input.knownBrands)
  const out: AmazonKeywordGap[] = []
  for (const own of input.own) {
    const m = amazonMarketOf(own.marketplace)
    const comps = new Set(
      input.competitors.filter((c) => amazonMarketOf(c.marketplace) === m).map(competitorKey),
    )
    const have = wordsInListing(own)
    const candidates = [...(phrases.get(m)?.values() ?? [])]
      .map((p) => ({ p, missing: p.norm.split(' ').filter((w) => !have.has(w)) }))
      .filter((x) => x.missing.length > 0)
      .sort(
        (a, b) =>
          b.p.competitors.size - a.p.competitors.size ||
          b.p.norm.split(' ').length - a.p.norm.split(' ').length ||
          a.p.norm.localeCompare(b.p.norm),
      )
    const kept: { words: string[]; term: AmazonKeywordGapTerm }[] = []
    for (const { p, missing } of candidates) {
      if (kept.length >= GAP_TERMS_MAX) break
      const words = p.norm.split(' ')
      // 同一串词只留一个；缺的词前面都已经列过了的也不再列（每一条都要带出至少一个新的缺词）
      if (kept.some((k) => within(words, k.words) || within(k.words, words))) continue
      if (missing.every((w) => kept.some((k) => k.term.missing_words.includes(w)))) continue
      kept.push({
        words,
        term: {
          id: `${m}:${p.norm}`,
          term: p.term.toLowerCase(),
          norm: p.norm,
          competitors: p.competitors.size,
          competitor_names: [...p.names].sort(),
          asins: [...p.asins].sort(),
          missing_words: missing,
        },
      })
    }
    const terms = kept.map((k) => k.term)
    out.push({
      asin: own.asin,
      marketplace: m,
      ...(own.title === '' ? {} : { title: own.title }),
      terms,
      competitors_compared: comps.size,
      common: commonGapCount({ terms, competitors_compared: comps.size }),
      computed_at: input.now,
    })
  }
  return out
}

/**
 * 体检卡那一行的数：「有 N 个竞品常用词你没写进标题 / 五点」。
 * 「常用」= 不止一家竞品在用（只和一家比时就是那一家用的全部）。
 */
export function commonGapCount(
  gap: Pick<AmazonKeywordGap, 'terms' | 'competitors_compared'>,
): number {
  if (gap.competitors_compared < 2) return gap.terms.length
  return gap.terms.filter((t) => t.competitors >= 2).length
}

/* ── 词表的一行 ───────────────────────────────────────────────────── */

/**
 * 词库 → 词表的行：每个词出现在几家竞品里（竞品文本里**词都有**就算，和 Amazon 按词收录一个道理）、
 * 自家写进去了没有、是不是差距词。排序：竞品数多的在前，同数按来源多少、再按词。
 */
export function keywordRows(input: {
  bank: readonly AmazonKeyword[]
  own: readonly AmazonListingText[]
  competitors: readonly AmazonListingText[]
  gaps: readonly AmazonKeywordGap[]
}): AmazonKeywordRow[] {
  const comp = input.competitors.map((t) => ({
    m: amazonMarketOf(t.marketplace),
    key: competitorKey(t),
    words: wordsInListing(t),
  }))
  const own = input.own.map((t) => ({ m: amazonMarketOf(t.marketplace), words: wordsInListing(t) }))
  const gapIds = new Set(input.gaps.flatMap((g) => g.terms.map((t) => t.id)))
  // WP420（自查 B10 / U22）：差距按 ASIN 说——哪几个自家 ASIN 没写（「✓你已写进」和「差距词」不再同时出现）
  const gapAsinsOf = (id: string): string[] =>
    input.gaps.filter((g) => g.terms.some((t) => t.id === id)).map((g) => g.asin)
  const rows = input.bank.map((k): AmazonKeywordRow => {
    const words = k.norm.split(' ')
    const hits = new Set(
      comp
        .filter((c) => c.m === k.marketplace && words.every((w) => c.words.has(w)))
        .map((c) => c.key),
    )
    return {
      ...k,
      competitors: hits.size,
      in_own_text: own.some((o) => o.m === k.marketplace && words.every((w) => o.words.has(w))),
      gap: gapIds.has(k.id),
      ...(gapIds.has(k.id) ? { gap_asins: gapAsinsOf(k.id) } : {}),
    }
  })
  return rows.sort(
    (a, b) =>
      b.competitors - a.competitors ||
      b.sources.length - a.sources.length ||
      a.term.localeCompare(b.term),
  )
}
