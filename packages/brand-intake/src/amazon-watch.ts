/**
 * WP394（docs/104 一期 B，C4 / C6；docs/106 §13 A9）：**读 Amazon 对标款的那一轮**（纯逻辑，不开页面）。
 *
 * 一条 `amazon_asin` 监控源（一家竞品在一个站点上的几款）读一次：
 *
 * 1. 先用**工坊内置浏览器**一页一页读商品页（免费；谁去开页面、带 `Agent/AgentsWorkshop`、配送邮编在服务端读页那一块）；
 * 2. **碰到验证页就停**：这一轮不再碰 Amazon、不重试、不绕，剩下的（含这一个）转**工坊云端数据**（按个扣积分）；
 *    没有桌面壳（没有内置浏览器）也走云端；
 * 3. 内置浏览器这一小时额度满了：剩下的这一次不读（不转云端、不花钱），照实标「没读全」，下一拍先读它们；
 * 4. 配送地址重设过一次还不对（币种对不上 / 写着不能配送）：这一个作废、照实说，不拿来比；
 * 5. 云端那一路没有划线价和优惠券：这两格照实空着（`fields_unread`），对比时不当「打折结束」。
 *
 * 服务端适配器和模拟世界都用这一份（模拟世界里读页 / 云端是替身）。
 */
import type {
  AmazonImportanceRules,
  CatalogReadResult,
  CatalogSnapshotRow,
  CompetitorChange,
  CompetitorWatchSource,
  Iso8601,
} from '@agentsws/contracts'
import {
  type AmazonProductFacts,
  type AmazonSearchCard,
  amazonMarketCurrency,
  amazonProductUrlOf,
} from './amazon.js'

/** 读一页商品页的结局（读页那一块交回来的）。 */
export type AmazonPageOutcome =
  | { status: 'ok'; facts: AmazonProductFacts }
  /** 验证页：这一轮不再碰 Amazon。 */
  | { status: 'blocked'; message?: string }
  /** 内置浏览器这一小时的额度满了。 */
  | { status: 'quota'; message?: string }
  /** 重设过一次配送地址还是不对。 */
  | { status: 'wrong_region'; message: string }
  /** 找不到这一页（下架 / 写错）。 */
  | { status: 'missing'; message?: string }
  | { status: 'failed'; message: string }

/** 云端那一路一个 ASIN 交回的（规范化之后的那几格；没有划线价、优惠券）。 */
export interface AmazonCloudItem {
  asin: string
  title?: string
  price?: number
  currency?: string
  rating?: number
  reviews_count?: number
  /** 大类名次（云端只给第一档）。 */
  bsr?: number
  /** 类目面包屑（`Sports & Outdoors › Cycling › …`）。 */
  category?: string
  url?: string
  image?: string
  in_stock?: boolean
}

export type AmazonCloudRead = { items: AmazonCloudItem[]; credits: number } | { error: string }

export interface AmazonAsinReadDeps {
  /** 内置浏览器读一页；没有（没有桌面壳）= 不给。 */
  browser?: (input: { marketplace: string; asin: string }) => Promise<AmazonPageOutcome>
  /** 云端兜底（一次一批）；没接上（没关联账号）= 不给。 */
  cloud?: (input: { marketplace: string; asins: string[] }) => Promise<AmazonCloudRead>
  now: Iso8601
  /** 先读哪几个（上次读得最早的在前）；不给按源里的顺序。 */
  order?: readonly string[]
}

/** 这一轮读完多交回的几样（连接卡 / 对话里说一句用）。 */
export interface AmazonAsinReadResult extends CatalogReadResult {
  /** 这一轮内置浏览器被拦了（之后这一轮不再碰 Amazon）。 */
  blocked?: boolean
  /** 走云端的那几个。 */
  cloud_asins?: string[]
  /** 这一次没读的（额度满了 / 作废 / 读不到）。 */
  unread?: string[]
}

const rowBase = (src: Pick<CompetitorWatchSource, 'id' | 'competitor_id'>) => ({
  source_id: src.id,
  competitor_id: src.competitor_id,
})

/** 商品页读到的 → 快照一行。 */
export function amazonFactsToRow(
  src: Pick<CompetitorWatchSource, 'id' | 'competitor_id'>,
  facts: AmazonProductFacts,
  marketplace: string,
  now: Iso8601,
): CatalogSnapshotRow {
  const url = facts.url ?? amazonProductUrlOf(marketplace, facts.asin)
  return {
    ...rowBase(src),
    product_key: facts.asin,
    title: facts.title ?? facts.asin,
    ...(url === undefined ? {} : { url }),
    ...(facts.image === undefined ? {} : { image: facts.image }),
    ...(facts.price === undefined ? {} : { price: facts.price }),
    ...(facts.list_price === undefined ? {} : { compare_at_price: facts.list_price }),
    ...(facts.currency === undefined ? {} : { currency: facts.currency }),
    ...(facts.available === undefined ? {} : { available: facts.available }),
    ...(facts.rating === undefined ? {} : { rating: facts.rating }),
    ...(facts.reviews === undefined ? {} : { reviews: facts.reviews }),
    ...(facts.bsr.length === 0 ? {} : { bsr: facts.bsr }),
    ...(facts.coupon === undefined ? {} : { coupon: facts.coupon }),
    ...(facts.bullets.length === 0 ? {} : { bullets: facts.bullets }),
    read_at: now,
  }
}

/** 云端读到的 → 快照一行（划线价、优惠券照实空着：标在 `fields_unread`）。 */
export function amazonCloudToRow(
  src: Pick<CompetitorWatchSource, 'id' | 'competitor_id'>,
  item: AmazonCloudItem,
  marketplace: string,
  now: Iso8601,
): CatalogSnapshotRow {
  const asin = item.asin.trim().toUpperCase()
  const url = item.url ?? amazonProductUrlOf(marketplace, asin)
  const top = item.category?.split(/\s*[›>]\s*/u)[0]?.trim()
  return {
    ...rowBase(src),
    product_key: asin,
    title: item.title ?? asin,
    ...(url === undefined ? {} : { url }),
    ...(item.image === undefined ? {} : { image: item.image }),
    ...(item.price === undefined ? {} : { price: item.price }),
    ...(item.currency === undefined ? {} : { currency: item.currency }),
    ...(item.in_stock === undefined ? {} : { available: item.in_stock }),
    ...(item.rating === undefined ? {} : { rating: item.rating }),
    ...(item.reviews_count === undefined ? {} : { reviews: item.reviews_count }),
    ...(item.bsr === undefined || top === undefined || top === ''
      ? {}
      : { bsr: [{ rank: item.bsr, category: top }] }),
    fields_unread: ['compare_at_price', 'coupon'],
    read_at: now,
  }
}

/** 云端那一路对用户说的名字（不提任何数据供应商）。 */
export const AMAZON_CLOUD_LABEL = '工坊云端数据'

const fmtCredits = (n: number): string => String(Math.round(n * 100) / 100)

/**
 * 读一条 `amazon_asin` 源的那几个 ASIN（见文件头的五条）。读不到别抛：回 `{ rows: [], complete: false, error }`。
 */
export async function readAmazonAsins(
  src: Pick<CompetitorWatchSource, 'id' | 'competitor_id' | 'label' | 'marketplace' | 'asins'>,
  deps: AmazonAsinReadDeps,
): Promise<AmazonAsinReadResult> {
  const marketplace = (src.marketplace ?? 'US').trim().toUpperCase()
  const wanted = [...new Set((src.asins ?? []).map((a) => a.trim().toUpperCase()))].filter(
    (a) => a !== '',
  )
  if (wanted.length === 0) return { rows: [], complete: true, notes: [] }
  const rank = new Map((deps.order ?? []).map((a, i) => [a.trim().toUpperCase(), i]))
  const queue = [...wanted].sort(
    (a, b) => (rank.get(a) ?? wanted.indexOf(a) + 1e6) - (rank.get(b) ?? wanted.indexOf(b) + 1e6),
  )
  const expected = amazonMarketCurrency(marketplace)
  const rows: CatalogSnapshotRow[] = []
  const notes: string[] = []
  const unread: string[] = []
  const toCloud: string[] = []
  let complete = true
  let blocked = false
  let quotaHit = false
  let browserRows = 0

  if (deps.browser === undefined) toCloud.push(...queue)
  else
    for (let i = 0; i < queue.length; i += 1) {
      const asin = queue[i] as string
      if (quotaHit) {
        unread.push(asin)
        continue
      }
      const got = await deps.browser({ marketplace, asin })
      if (got.status === 'blocked') {
        // 被拦就停：这一轮不再碰 Amazon、不重试、不绕；剩下的（含这一个）转云端
        blocked = true
        toCloud.push(...queue.slice(i))
        notes.push('Amazon 要人机验证，内置浏览器这一轮不再读、不绕，剩下的改走工坊云端数据')
        break
      }
      if (got.status === 'quota') {
        quotaHit = true
        complete = false
        unread.push(asin)
        continue
      }
      if (got.status === 'missing') continue // 找不到这一页：不在这次读到的里面（连两次 = 下架）
      if (got.status === 'wrong_region' || got.status === 'failed') {
        complete = false
        unread.push(asin)
        notes.push(`${asin}：${got.message}`)
        continue
      }
      const f = got.facts
      if (
        f.undeliverable ||
        (expected !== undefined && f.currency !== undefined && f.currency !== expected)
      ) {
        complete = false
        unread.push(asin)
        notes.push(`${asin}：读到的价格不是这个站的币种（配送地址不对），这次作废`)
        continue
      }
      rows.push(amazonFactsToRow(src, f, marketplace, deps.now))
      browserRows += 1
    }
  if (quotaHit)
    notes.push(
      `内置浏览器这一小时的额度满了：读了 ${browserRows} 个，还有 ${unread.length} 个下一拍先读`,
    )

  let credits: number | undefined
  if (toCloud.length > 0) {
    if (deps.cloud === undefined) {
      complete = false
      unread.push(...toCloud)
      notes.push(
        deps.browser === undefined
          ? '这台电脑没有工坊内置浏览器，工坊云端数据也还没接上（先关联账号），这次没读'
          : '工坊云端数据还没接上（先关联账号），剩下的这次没读',
      )
    } else {
      const got = await deps.cloud({ marketplace, asins: toCloud }).catch((e: unknown) => ({
        error: e instanceof Error ? e.message : String(e),
      }))
      if ('error' in got) {
        complete = false
        unread.push(...toCloud)
        notes.push(`工坊云端数据这次没读到：${got.error}`)
      } else {
        credits = got.credits
        const byAsin = new Map(got.items.map((it) => [it.asin.trim().toUpperCase(), it]))
        let n = 0
        for (const asin of toCloud) {
          const it = byAsin.get(asin)
          if (it === undefined) {
            complete = false
            unread.push(asin)
            continue
          }
          if (expected !== undefined && it.currency !== undefined && it.currency !== expected) {
            complete = false
            unread.push(asin)
            continue
          }
          rows.push(amazonCloudToRow(src, it, marketplace, deps.now))
          n += 1
        }
        notes.push(
          `${n} 个走了工坊云端数据，扣了 ${fmtCredits(got.credits)} 积分（云端读不到划线价和优惠券，这两格空着）`,
        )
      }
    }
  }

  const via =
    toCloud.length > 0 && credits !== undefined ? ('cloud' as const) : ('browser' as const)
  const base: AmazonAsinReadResult = {
    rows,
    complete,
    notes,
    ...(rows.length > 0 || credits !== undefined ? { via } : {}),
    ...(credits === undefined ? {} : { credits }),
    ...(blocked ? { blocked: true } : {}),
    ...(toCloud.length === 0 ? {} : { cloud_asins: toCloud }),
    ...(unread.length === 0 ? {} : { unread }),
  }
  if (rows.length === 0 && wanted.length > 0 && !(complete && unread.length === 0))
    return {
      ...base,
      complete: false,
      error: `${src.label} 这次没读到：${notes.join('；') || '没读到'}`,
    }
  return base
}

/* ── 挑对标款（C6，规则脑；服务端可再让模型润色理由）──────────────────────────── */

/** 自家的一款（对标谁用）。 */
export interface AmazonOwnItem {
  asin: string
  title?: string
  price?: number
}

/** 建议盯的一款。 */
export interface AmazonBenchmarkPick {
  asin: string
  title: string
  reviews?: number
  price?: number
  currency?: string
  /** 对标自家哪一款（自家 ASIN）；没有自家清单时不给。 */
  vs_own?: string
  /** 一句为什么（卡上那一行）。 */
  why: string
}

const STOP = new Set(
  'the a an and or for with of to in on by from new 2024 2025 2026 pack set pcs inch in. w/ ' +
    'adults adult men women kids black white grey gray blue red green large small medium'.split(
      ' ',
    ),
)

/** 标题拆词（小写、去品牌名、去停用词、单复数粗归一）。 */
export function titleTokens(title: string, drop: readonly string[] = []): Set<string> {
  const dropped = new Set(
    drop.flatMap((d) =>
      d
        .toLowerCase()
        .split(/[^a-z0-9]+/u)
        .filter((x) => x !== ''),
    ),
  )
  const out = new Set<string>()
  for (const w of title.toLowerCase().split(/[^a-z0-9一-鿿]+/u)) {
    if (w.length < 3 || STOP.has(w) || dropped.has(w) || /^\d+$/u.test(w)) continue
    out.add(w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)
  }
  return out
}

const overlap = (a: Set<string>, b: Set<string>): number => {
  let n = 0
  for (const x of a) if (b.has(x)) n += 1
  return n
}

const norm = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/gu, ' ')
    .trim()

/** 这张卡是不是这家竞品的（标题以品牌名 / 别名起头，或整词含它）。 */
export function cardIsBrand(title: string, names: readonly string[]): boolean {
  const t = ` ${norm(title)} `
  return names
    .map(norm)
    .filter((n) => n.length >= 2)
    .some((n) => t.startsWith(` ${n} `) || t.includes(` ${n} `))
}

/**
 * 从一页搜索结果里给一家竞品挑对标款：**品牌对得上**、和自家商品**同类**（标题有共同的词；没有自家清单就不看这条）、
 * **评论多**的在前；广告位够数时不要。最多 `max` 个（默认 5，C6 不定死）。每个配一款自家的（标题最像、价最近）。
 */
export function suggestAmazonBenchmarks(input: {
  competitor: { name: string; aliases?: readonly string[] }
  cards: readonly AmazonSearchCard[]
  own: readonly AmazonOwnItem[]
  own_brand?: string
  max?: number
}): AmazonBenchmarkPick[] {
  const names = [input.competitor.name, ...(input.competitor.aliases ?? [])]
  const drop = [...names, ...(input.own_brand === undefined ? [] : [input.own_brand])]
  const ownTok = input.own.map((o) => ({ o, tok: titleTokens(o.title ?? '', drop) }))
  const ownAll = new Set(ownTok.flatMap((x) => [...x.tok]))
  const mine = new Set(input.own.map((o) => o.asin.toUpperCase()))
  const scored = input.cards
    .filter((c) => !mine.has(c.asin) && cardIsBrand(c.title, names))
    .map((c) => ({ c, tok: titleTokens(c.title, drop) }))
    // 同类：和自家标题至少两个共同的词（只一个「bike」的头盔、配件不算）；没有自家清单就不看这条
    .filter((x) => ownAll.size === 0 || overlap(x.tok, ownAll) >= Math.min(2, ownAll.size))
  const organic = scored.filter((x) => !x.c.sponsored)
  const pool = organic.length >= 3 ? organic : scored
  const max = Math.max(1, Math.min(input.max ?? 5, 20))
  return [...pool]
    .sort((a, b) => (b.c.reviews ?? -1) - (a.c.reviews ?? -1) || a.c.position - b.c.position)
    .slice(0, max)
    .map(({ c, tok }) => {
      let best: { o: AmazonOwnItem; score: number; gap: number } | undefined
      for (const { o, tok: ot } of ownTok) {
        const score = overlap(tok, ot)
        const gap =
          c.price !== undefined && o.price !== undefined ? Math.abs(c.price - o.price) : 1e12
        if (best === undefined || score > best.score || (score === best.score && gap < best.gap))
          best = { o, score, gap }
      }
      const reviews = c.reviews === undefined ? '' : `，${c.reviews.toLocaleString('en-US')} 条评论`
      return {
        asin: c.asin,
        title: c.title,
        ...(c.reviews === undefined ? {} : { reviews: c.reviews }),
        ...(c.price === undefined ? {} : { price: c.price }),
        ...(c.currency === undefined ? {} : { currency: c.currency }),
        ...(best === undefined ? {} : { vs_own: best.o.asin }),
        why: `${input.competitor.name} 自家的${c.sponsored ? '（广告位）' : ''}${reviews}${
          best === undefined ? '' : `；对标你的 ${best.o.title?.slice(0, 40) ?? best.o.asin}`
        }`,
      }
    })
}

/* ── 什么算重要（C5：只按用户在方案卡上确认过的规则；没确认过 = 一条都不算）────────── */

/** 这一条变化按用户确认过的规则算不算重要。 */
export function isImportantAmazonChange(
  c: Pick<CompetitorChange, 'kind' | 'pct' | 'before' | 'after' | 'vs_own'>,
  rules: AmazonImportanceRules | undefined,
): boolean {
  if (rules === undefined) return false
  switch (c.kind) {
    case 'price': {
      const drop = c.pct !== undefined && c.pct < 0
      if (rules.price_drop_pct !== undefined && drop && -(c.pct as number) >= rules.price_drop_pct)
        return true
      return rules.cheaper_than_own === true && drop && c.vs_own !== undefined && c.vs_own.diff < 0
    }
    case 'discount_start':
    case 'discount_end':
      return rules.discounts === true
    case 'out_of_stock':
    case 'back_in_stock':
      return rules.stock === true
    case 'rating':
      return (
        rules.rating_below !== undefined &&
        typeof c.after === 'number' &&
        c.after < rules.rating_below &&
        (typeof c.before !== 'number' || c.before >= rules.rating_below)
      )
    case 'bsr':
      return (
        rules.bsr_move_pct !== undefined &&
        c.pct !== undefined &&
        Math.abs(c.pct) >= rules.bsr_move_pct
      )
    default:
      return false
  }
}

/**
 * 规则版建议（模型不在 / 没回时用）：按品类给一份起步值，卡上用户能改（C5 不预设：只是建议）。
 * 大件（车、家具、家电）价位高，降价门槛低一点；其余按 10%。
 */
export function suggestAmazonRules(category: string | undefined): {
  rules: AmazonImportanceRules
  why: string
} {
  const big =
    /bike|bicycle|scooter|电动|自行车|滑板|furniture|家具|sofa|mattress|床垫|appliance|家电|grill|treadmill|跑步机/iu.test(
      category ?? '',
    )
  return {
    rules: {
      price_drop_pct: big ? 8 : 10,
      cheaper_than_own: true,
      discounts: true,
      stock: false,
      rating_below: 4,
    },
    why: big
      ? `${category ?? '这类'}单价高，对标款降 8% 以上、或降到比你便宜就值得说；评分跌破 4 星也说`
      : '对标款降 10% 以上、或降到比你便宜就值得说；评分跌破 4 星也说',
  }
}
