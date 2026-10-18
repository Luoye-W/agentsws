/**
 * WP398（docs/106 §5.6 / §13 A8）：一个品牌的 **Amazon 词库**。
 *
 * 一次刷新：
 * 1. 拆 Listing 文本：竞品（WP392 快照 / WP394 读的页）+ 自家（WP396 体检读的页、品牌档案里从 Amazon 读到的商品），
 *    标题 / 五点拆成词组进词库，品牌名去掉；
 * 2. 读前台联想词（内置浏览器，自报 Agent 身份）：种子词来自用户 / AI 给的、自家商品标题的核心词；
 *    每次最多一批（种子词本身 + a–z），**被拦就停**（这一轮停、之后 24 小时不再去读），额度满了就停，读不到照实说；
 * 3. 算差距：每个自家 ASIN「竞品标题 / 五点里出现、你这里缺词」的词组，按出现在几家竞品里排（没有搜索量）。
 *
 * 只出建议，不写 Amazon；数字格一期一律空着。词库按品牌存本机。
 */

import {
  amazonAutocompletePrefixes,
  amazonAutocompleteSupported,
  type BatchStep,
  readBatchChain,
} from '@agentsws/brand-intake'
import {
  AMAZON_KEYWORD_SORT_NOTE_EN,
  AMAZON_KEYWORD_SORT_NOTE_ZH,
  AMAZON_KEYWORD_SOURCES,
  type AmazonAutocompleteStatus,
  type AmazonKeyword,
  type AmazonKeywordBankView,
  type AmazonKeywordGap,
  type AmazonKeywordMarkPatch,
  type AmazonKeywordPage,
  type AmazonKeywordQuery,
  type AmazonKeywordRefresh,
  type AmazonKeywordSource,
  type AmazonListingText,
  type Iso8601,
} from '@agentsws/contracts'
import {
  amazonLanguageOf,
  amazonMarketOf,
  applyMarks,
  commonGapCount,
  computeKeywordGaps,
  keywordRows,
  mergeSightings,
  normalizeKeyword,
  seedFromTitle,
  sightingsFromListing,
  sightingsFromSuggestions,
} from '@agentsws/seo-core'
import type { AmazonBlockPort } from '../amazon-front/block.js'
import type { AmazonAutocompleteReader, AutocompleteRead } from './reader.js'
import { createKeywordStore, type KeywordStateFile } from './store.js'

/** 被拦之后多久不再去读联想词。 */
export const AUTOCOMPLETE_BLOCK_PAUSE_MS = 24 * 3_600_000
/** 一批里连着几页没读成就停。 */
const MAX_FAILS_IN_A_ROW = 3

export interface KeywordBrandInfo {
  /** 自家品牌名（联想词里出现不算他牌名）。 */
  name?: string
  /** 品牌档案的目标市场（国家码）。 */
  markets: string[]
  /** 关注设置里的竞品（名字当他牌名认）。 */
  competitors: { id: string; name: string }[]
  /** 品牌档案里的品类 / 品类词（拉丁字母写的才拿来当种子词）。 */
  seed_hints?: string[]
}

export interface AmazonKeywordBankOptions {
  workspace_id: string
  dir?: string
  now(): Iso8601
  newId(prefix: string): string
  /** 内置浏览器读联想词（没有桌面壳 = `undefined`）。 */
  reader(): AmazonAutocompleteReader | undefined
  brand(): Promise<KeywordBrandInfo>
  /** 自家 Listing 文本（WP396 体检读到的、品牌档案里的 Amazon 商品）。 */
  ownListings?(): Promise<AmazonListingText[]>
  /** 竞品 Listing 文本（WP392 快照 / WP394 读的页）。 */
  competitorListings?(): Promise<AmazonListingText[]>
  emit?(type: string, payload: Record<string, unknown>): void
  /**
   * WP402（决策 1146）：品牌级「被 Amazon 拦了」（和竞品读页共用一份）：任一边被拦，这边也不再用内置浏览器读、
   * 直接换下一条路。不给 = 只看词库自己记的那一份（测试 / 老装配）。
   */
  block?: AmazonBlockPort
  /** WP402：第 3 条路——通过插件在用户自己的浏览器里读联想词（要同意、每天至多一批；没装插件 = 不给）。 */
  ownBrowser?(): OwnBrowserKeywords | undefined
  /** WP402：取数链说「要问一句同意」。 */
  onNeedsConsent?(): void
}

/** WP402：用户自己的浏览器读联想词的那一口（`amazon-front/own-browser.ts` 给）。 */
export interface OwnBrowserKeywords {
  gate: 'ok' | 'needs_consent' | 'limited'
  suggest(input: { marketplace: string; prefix: string }): Promise<AutocompleteRead>
  used(): void
}

export interface RefreshInput {
  trigger: AmazonKeywordRefresh['trigger']
  /** 这次用的种子词（也记下来，下次接着用）。 */
  seeds?: string[]
  marketplace?: string
  /** `false` = 只拆 Listing、不读联想词。 */
  autocomplete?: boolean
}

export interface AmazonKeywordBank {
  view(): AmazonKeywordBankView
  list(q?: AmazonKeywordQuery): AmazonKeywordPage
  refresh(
    input: RefreshInput,
  ): Promise<{ refresh: AmazonKeywordRefresh; view: AmazonKeywordBankView }>
  /** 读页的那几单（WP394 / WP396）读到一条 Listing 就交进来；下次刷新拆词。 */
  ingestListings(texts: readonly AmazonListingText[]): void
  mark(
    patch: AmazonKeywordMarkPatch,
  ): { ok: true; keyword: AmazonKeyword } | { ok: false; message: string }
  gapFor(asin: string): AmazonKeywordGap | undefined
  readerReady(): boolean
}

const listingKey = (t: AmazonListingText): string =>
  `${t.side}:${amazonMarketOf(t.marketplace)}:${t.asin.toUpperCase()}`

/** 同一条 Listing 只留最新那份。 */
export function latestListings(texts: readonly AmazonListingText[]): AmazonListingText[] {
  const by = new Map<string, AmazonListingText>()
  for (const t of texts) {
    if (t.title.trim() === '' && (t.bullets ?? []).length === 0) continue
    const k = listingKey(t)
    const old = by.get(k)
    if (old === undefined || old.read_at <= t.read_at)
      by.set(k, { ...t, asin: t.asin.toUpperCase() })
  }
  return [...by.values()]
}

/** 拉丁字母写的才当英文站的种子词（品牌档案的品类常是中文）。 */
const latin = (s: string): boolean => /^[\p{Script=Latin}\p{N}\s&'’-]+$/u.test(s.trim())

const hhmm = (iso: Iso8601): string => {
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

interface AutocompleteOutcome {
  part: AmazonKeywordRefresh['autocomplete']
  suggestions: { prefix: string; values: string[] }[]
  marketplace: string
}

export function createAmazonKeywordBank(o: AmazonKeywordBankOptions): AmazonKeywordBank {
  const store = createKeywordStore(o.dir)
  const st = (): KeywordStateFile => store.state()
  const own = (): AmazonListingText[] => st().listings.filter((l) => l.side === 'own')
  const comp = (): AmazonListingText[] => st().listings.filter((l) => l.side === 'competitor')
  const excluded = (): Set<string> =>
    new Set(
      st()
        .keywords.filter((k) => k.marks.includes('exclude'))
        .map((k) => k.id),
    )
  /** 差距词去掉用户标了「不要」的。 */
  const gaps = (): AmazonKeywordGap[] => {
    const ex = excluded()
    return st().gaps.map((g) => {
      const terms = g.terms.filter((t) => !ex.has(t.id))
      return {
        ...g,
        terms,
        common: commonGapCount({ terms, competitors_compared: g.competitors_compared }),
      }
    })
  }

  /** 认得出的品牌名：关注设置里的竞品、Listing 上读到的品牌、自家品牌（拆词都去掉）。 */
  const brandsOf = (brand: KeywordBrandInfo): string[] => {
    const set = new Set<string>()
    if (brand.name !== undefined) set.add(brand.name)
    for (const c of brand.competitors) set.add(c.name)
    for (const l of st().listings) {
      if (l.brand !== undefined) set.add(l.brand)
      if (l.competitor !== undefined) set.add(l.competitor)
    }
    return [...set].map((b) => b.trim()).filter((b) => b.length >= 2)
  }

  const view = (): AmazonKeywordBankView => {
    const s = st()
    const active = s.keywords.filter((k) => !k.marks.includes('exclude'))
    const by_source: Partial<Record<AmazonKeywordSource, number>> = {}
    for (const k of active) for (const src of k.sources) by_source[src] = (by_source[src] ?? 0) + 1
    const g = gaps()
    const last = s.refreshes[s.refreshes.length - 1]
    return {
      total: active.length,
      gap_terms: new Set(g.flatMap((x) => x.terms.map((t) => t.id))).size,
      other_brand_terms: active.filter((k) => k.other_brand !== undefined).length,
      by_source,
      ...(s.updated_at === undefined ? {} : { updated_at: s.updated_at }),
      ...(last === undefined ? {} : { last_refresh: last }),
      gaps: g,
      listings: { own: own().length, competitor: comp().length },
      reader_ready: o.reader() !== undefined,
      sort_note: { zh: AMAZON_KEYWORD_SORT_NOTE_ZH, en: AMAZON_KEYWORD_SORT_NOTE_EN },
    }
  }

  const list = (q: AmazonKeywordQuery = {}): AmazonKeywordPage => {
    const rows = keywordRows({ bank: st().keywords, own: own(), competitors: comp(), gaps: gaps() })
    const text = q.q?.trim().toLowerCase()
    const showExcluded = q.include_excluded === true || q.mark === 'exclude'
    const hit = rows.filter(
      (r) =>
        (showExcluded || !r.marks.includes('exclude')) &&
        (q.source === undefined || r.sources.includes(q.source)) &&
        (q.mark === undefined || r.marks.includes(q.mark)) &&
        (q.gap !== true || r.gap) &&
        (q.other_brand !== true || r.other_brand !== undefined) &&
        (q.marketplace === undefined || r.marketplace === amazonMarketOf(q.marketplace)) &&
        (text === undefined || text === '' || r.term.includes(text) || r.norm.includes(text)),
    )
    const offset = Math.max(0, Math.floor(q.offset ?? 0))
    const limit = Math.min(500, Math.max(1, Math.floor(q.limit ?? 200)))
    return {
      items: hit.slice(offset, offset + limit),
      total: hit.length,
      sort_note: { zh: AMAZON_KEYWORD_SORT_NOTE_ZH, en: AMAZON_KEYWORD_SORT_NOTE_EN },
    }
  }

  /** 读一批联想词（种子词本身 + a–z）；被拦 / 额度满就停，读不到照实说。 */
  const readAutocomplete = async (
    brand: KeywordBrandInfo,
    input: RefreshInput,
    brands: readonly string[],
  ): Promise<AutocompleteOutcome> => {
    const market = amazonMarketOf(
      input.marketplace ??
        own()[0]?.marketplace ??
        brand.markets.find((m) => amazonAutocompleteSupported(m)) ??
        'US',
    )
    const language = amazonLanguageOf(market)
    const given = (input.seeds ?? [])
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.length >= 2)
    if (given.length > 0)
      store.update((s) => {
        s.seeds = [...new Set([...given, ...s.seeds])].slice(0, 20)
      })
    const derived = [
      ...own()
        .filter((t) => amazonMarketOf(t.marketplace) === market)
        .map((t) => seedFromTitle(t.title, { language, brands })),
      ...(brand.seed_hints ?? []).filter(latin),
    ].filter((x): x is string => x !== undefined && x.trim() !== '')
    const seeds = [...new Set([...st().seeds, ...derived.map((x) => x.toLowerCase())])]
    const base = { marketplace: market, planned: 0, read: 0, suggestions: 0, added: 0 }
    const out = (status: AmazonAutocompleteStatus, message?: string): AutocompleteOutcome => ({
      part: { ...base, status, ...(message === undefined ? {} : { message }) },
      suggestions: [],
      marketplace: market,
    })
    if (seeds.length === 0)
      return out(
        'no_seeds',
        '没有种子词：说一个英文品类词（比如 portable power station），或者先读到自家商品标题',
      )
    if (!amazonAutocompleteSupported(market)) return out('failed', `${market} 站点的联想词还读不了`)
    const reader = o.reader()
    const pausedUntil = (): string | undefined => {
      if (o.block !== undefined) {
        const t = o.block.pausedUntil()
        return t === undefined ? undefined : new Date(t).toISOString()
      }
      const until = st().blocked_until
      return until !== undefined && until > o.now() ? until : undefined
    }
    const seed = given[0] ?? seeds[st().seed_cursor % seeds.length] ?? seeds[0] ?? ''
    const prefixes = amazonAutocompletePrefixes(seed)
    let status: AmazonAutocompleteStatus | undefined
    let message: string | undefined
    const mine = o.ownBrowser?.()

    /** 一页一页读（内置浏览器 / 你自己的浏览器同一个读法）；被拦就停这条路、剩下的往下传。 */
    const pageByPage = async (
      keys: string[],
      suggest: (i: { marketplace: string; prefix: string }) => Promise<AutocompleteRead>,
      who: 'browser' | 'extension',
    ): Promise<BatchStep<string, string[]>> => {
      const step: BatchStep<string, string[]> = { got: [], next: [], stop: [] }
      let fails = 0
      for (let i = 0; i < keys.length; i += 1) {
        const prefix = keys[i] as string
        const r = await suggest({ marketplace: market, prefix })
        if (r.status === 'ok') {
          fails = 0
          step.got.push({ key: prefix, value: r.suggestions })
          continue
        }
        if (r.status === 'blocked') {
          if (who === 'browser') {
            const until =
              o.block !== undefined
                ? new Date(o.block.block('keywords')).toISOString()
                : new Date(Date.parse(o.now()) + AUTOCOMPLETE_BLOCK_PAUSE_MS).toISOString()
            if (o.block === undefined)
              store.update((st0) => {
                st0.blocked_until = until
              })
            message = `${r.message ?? 'Amazon 出了验证页'}，联想词这一轮停了（读了 ${step.got.length} 页）；${hhmm(until)} 前不再用内置浏览器去读，不绕、不重试`
          } else message = `${r.message ?? '你自己的浏览器里 Amazon 也要验证'}，这一批先不读了`
          status = 'blocked'
          step.next = keys.slice(i)
          step.outcome = 'blocked'
          return step
        }
        if (r.status === 'quota') {
          status = 'quota'
          message = `${r.message ?? '内置浏览器这一小时的额度满了'}（这一批读了 ${step.got.length} / ${prefixes.length} 页）`
          step.stop = keys.slice(i).map((key) => ({ key, kind: 'quota' as const }))
          step.outcome = step.got.length > 0 ? 'ok' : 'quota'
          return step
        }
        fails += 1
        message = `有几页没读成：${r.message}`
        if (fails >= MAX_FAILS_IN_A_ROW) {
          step.stop = keys.slice(i + 1).map((key) => ({ key, kind: 'failed' as const }))
          break
        }
        step.stop?.push({ key: prefix, kind: 'failed' })
      }
      return step
    }

    const chain = await readBatchChain<string, string[]>(prefixes, [
      {
        route: 'browser',
        async read(keys) {
          if (reader === undefined)
            return { got: [], next: keys, outcome: 'unavailable', reason: '没有内置浏览器' }
          const until = pausedUntil()
          if (until !== undefined) {
            status = 'blocked'
            message = `Amazon 之前出过验证页，内置浏览器停到 ${hhmm(until)} 再读联想词（不绕、不重试）`
            return { got: [], next: keys, outcome: 'blocked', reason: message }
          }
          return pageByPage(keys, (i) => reader.suggest(i), 'browser')
        },
      },
      {
        route: 'cloud',
        read: async (keys) => ({
          got: [],
          next: keys,
          outcome: 'unavailable',
          reason: '工坊云端没有联想词这一项',
        }),
      },
      {
        route: 'extension',
        async read(keys) {
          if (mine === undefined)
            return { got: [], next: keys, outcome: 'unavailable', reason: '没装 Agents 工坊插件' }
          if (mine.gate === 'needs_consent') {
            o.onNeedsConsent?.()
            message = `${message ?? '内置浏览器读不了联想词'}；要不要用你自己的浏览器读，得先问你一句（卡上点同意才读）`
            return { got: [], next: keys, outcome: 'needs_consent' }
          }
          if (mine.gate === 'limited') {
            message = `${message ?? '内置浏览器读不了联想词'}；今天已经用你自己的浏览器读过一批了，明天再试`
            return { got: [], next: keys, outcome: 'limited' }
          }
          mine.used()
          status = undefined
          const before = message
          const step = await pageByPage(keys, (i) => mine.suggest(i), 'extension')
          if (step.got.length > 0 && status === undefined) message = before
          return step
        },
      },
    ])
    const got = prefixes
      .map((prefix) => {
        const g = chain.got.find((x) => x.key === prefix)
        return g === undefined ? undefined : { prefix, values: g.value }
      })
      .filter((x): x is { prefix: string; values: string[] } => x !== undefined)
    const via =
      chain.via === 'extension'
        ? ('extension' as const)
        : chain.via === 'browser'
          ? ('browser' as const)
          : undefined
    if (got.length === 0 && reader === undefined && mine === undefined)
      return out('unavailable', '这里没有工坊的内置浏览器（桌面版才有），联想词这次没读')
    if (got.length === 0 && status === undefined && reader === undefined) {
      status = 'unavailable'
      message ??= '这里没有工坊的内置浏览器（桌面版才有），联想词这次没读'
    }
    status ??= got.length === prefixes.length ? 'ok' : got.length > 0 ? 'partial' : 'failed'
    if (status === 'ok' && given.length === 0)
      store.update((s) => {
        s.seed_cursor = (s.seed_cursor + 1) % Math.max(1, seeds.length)
      })
    const unique = new Set(got.flatMap((g) => g.values))
    return {
      part: {
        status,
        marketplace: market,
        seed,
        planned: prefixes.length,
        read: got.length,
        suggestions: unique.size,
        added: 0,
        ...(message === undefined || status === 'ok' ? {} : { message }),
        ...(via === undefined ? {} : { via }),
        attempts: chain.attempts,
      },
      suggestions: got,
      marketplace: market,
    }
  }

  return {
    view,
    list,
    readerReady: () => o.reader() !== undefined,
    gapFor: (asin) => gaps().find((g) => g.asin === asin.trim().toUpperCase()),
    ingestListings(texts) {
      if (texts.length === 0) return
      store.update((s) => {
        s.listings = latestListings([...s.listings, ...texts])
      })
    },
    async refresh(input) {
      const started_at = o.now()
      const brand = await o.brand()
      const pulled = [
        ...((await o.ownListings?.().catch(() => [])) ?? []),
        ...((await o.competitorListings?.().catch(() => [])) ?? []),
      ]
      store.update((s) => {
        s.listings = latestListings([...s.listings, ...pulled])
      })
      const brands = brandsOf(brand)
      const listingSightings = st().listings.flatMap((l) => sightingsFromListing(l, brands))
      const first = mergeSightings(st().keywords, listingSightings, o.now())
      const ac =
        input.autocomplete === false ? undefined : await readAutocomplete(brand, input, brands)
      const others = brands.filter(
        (b) => brand.name === undefined || normalizeKeyword(b) !== normalizeKeyword(brand.name),
      )
      const acSightings = (ac?.suggestions ?? []).flatMap((g) =>
        sightingsFromSuggestions(g.values, {
          marketplace: ac?.marketplace ?? 'US',
          prefix: g.prefix,
          ...(brand.name === undefined ? {} : { ownBrand: brand.name }),
          otherBrands: others,
        }),
      )
      const now = o.now()
      const second = mergeSightings(first.bank, acSightings, now)
      const nextGaps = computeKeywordGaps({
        own: own(),
        competitors: comp(),
        knownBrands: brands,
        now,
      })
      const refresh: AmazonKeywordRefresh = {
        id: o.newId('kwr'),
        started_at,
        finished_at: now,
        trigger: input.trigger,
        autocomplete:
          ac === undefined
            ? {
                status: 'ok',
                planned: 0,
                read: 0,
                suggestions: 0,
                added: 0,
                message: '这次没读联想词',
              }
            : { ...ac.part, added: second.added },
        listings: { own: own().length, competitor: comp().length },
        added: first.added + second.added,
        gap_terms: new Set(nextGaps.flatMap((g) => g.terms.map((t) => t.id))).size,
      }
      store.update((s) => {
        s.keywords = second.bank
        s.gaps = nextGaps
        s.refreshes = [...s.refreshes, refresh]
        s.updated_at = now
      })
      o.emit?.('amazon_keywords.refreshed', {
        refresh_id: refresh.id,
        trigger: refresh.trigger,
        autocomplete: refresh.autocomplete.status,
        pages: refresh.autocomplete.read,
        added: refresh.added,
        gap_terms: refresh.gap_terms,
      })
      return { refresh, view: view() }
    },
    mark(patch) {
      const add = (patch.add ?? []).filter((m) => ['core', 'exclude', 'in_listing'].includes(m))
      const remove = (patch.remove ?? []).filter((m) =>
        ['core', 'exclude', 'in_listing'].includes(m),
      )
      const now = o.now()
      let id = patch.id
      if (id === undefined) {
        const term = patch.term?.trim().toLowerCase() ?? ''
        const market = amazonMarketOf(patch.marketplace ?? own()[0]?.marketplace ?? 'US')
        const norm = normalizeKeyword(term, amazonLanguageOf(market))
        if (norm === '') return { ok: false, message: '要给一个词（id 或 term）' }
        id = `${market}:${norm}`
        // 用户点名的词记一笔「自己加的」（已经在词库里的也记，来源里看得出是人挑的）
        const merged = mergeSightings(
          st().keywords,
          [{ norm, term, marketplace: market, source: 'user' }],
          now,
        )
        store.update((s) => {
          s.keywords = merged.bank
        })
      }
      const k = st().keywords.find((x) => x.id === id)
      if (k === undefined) return { ok: false, message: `词库里没有这个词：${id}` }
      const next = applyMarks(k, add, remove, now)
      store.update((s) => {
        s.keywords = s.keywords.map((x) => (x.id === next.id ? next : x))
        s.updated_at = now
      })
      return { ok: true, keyword: next }
    },
  }
}

/** 契约里的来源顺序（工具 / 路由校验用）。 */
export const KEYWORD_SOURCES: readonly AmazonKeywordSource[] = AMAZON_KEYWORD_SOURCES
