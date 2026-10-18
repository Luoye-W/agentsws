/**
 * WP394（docs/104 一期 B，docs/106 §13 A9）：**用工坊内置浏览器读 Amazon 前台**的那一块——竞品对标款（本单）、
 * 自家 Listing 体检（WP396，接 `ServerOptions.amazonListingReader`）、词库联想词（WP398）都用它。
 *
 * 硬规矩（Amazon Agent Policy）：
 * - 每个请求的 User-Agent 末尾自报 `Agent/AgentsWorkshop`（桌面壳的会话统一加，见 `apps/desktop/src/search-browser.ts`）；
 * - 不模仿人：不点、不填、不滚动；页与页之间**固定间隔**（节流队的 `steady`），不加随机停顿；
 * - **碰到验证页就停**：记一次暂停（{@link AMAZON_BLOCK_PAUSE_MS}），暂停期间这个品牌一页 Amazon 都不开、不重试、不绕，
 *   调用方转工坊云端数据、在对话里说一句；人机验证 AI 不碰；
 * - 每开一页算进内置浏览器每小时 ≤60 页的额度（决策 914，和搜索共用一条队）；满了回 `quota`。
 *
 * 配送地址（docs/104 §2.3）：每个品牌的内置浏览器 partition 里，按站点把「配送到」设成一个邮编（美国站 `10001`；
 * 不登录，只是 Amazon 的地址 cookie）。读到的币种和站点不符、或页面写「不能配送到你选的地址」：这次读数作废、
 * 重设一次再读一次，再不对就回 `wrong_region` 照实说。
 */
import {
  type AmazonPageOutcome,
  type AmazonSearchCard,
  amazonHostOfMarket,
  amazonMarketCurrency,
  amazonProductUrlOf,
  amazonSearchCards,
  amazonSearchUrlOf,
  isAmazonChallenge,
  isAmazonHost,
  isAmazonMissingPage,
  parseAmazonProduct,
  storefrontCards,
} from '@agentsws/brand-intake'
import { AMAZON_DELIVERY_ZIPS } from '@agentsws/contracts'
import type { SearchBrowserChannel } from '../web-browser/channel.js'
import type { AmazonBlockPort } from './block.js'

/**
 * 被拦之后多久不再碰 Amazon（这一轮剩下的走云端；人机验证 AI 不碰）。和 WP398 联想词那一路同一个长度
 * （24 小时，决策 1117）。
 */
export const AMAZON_BLOCK_PAUSE_MS = 24 * 3_600_000
/** 配送地址设过之后多久内信它（过了再设一次）。 */
export const AMAZON_DELIVERY_FRESH_MS = 7 * 86_400_000
/** 一页最多等多久。 */
export const AMAZON_PAGE_TIMEOUT_MS = 20_000

/** 读一页原文的结局（和 WP396 `ListingPageRead` 同形状：那边直接接这一口）。 */
export type AmazonRawRead =
  | { status: 'ok'; url: string; html: string }
  | { status: 'blocked'; url: string; message?: string }
  | { status: 'quota'; message?: string }
  | { status: 'failed'; url: string; message: string }

export type AmazonCardsRead =
  | { status: 'ok'; cards: AmazonSearchCard[] }
  | { status: 'blocked' | 'quota'; message?: string }
  | { status: 'failed'; message: string }

/** 这个品牌的几样状态（存在竞品监控库的杂项里；重启不丢）。 */
export interface AmazonFrontState {
  blocked_until?: number
  blocked_at?: number
  /** 站点 → 上次设的邮编与时刻。 */
  delivery?: Record<string, { zip: string; at: number; deliver_to?: string }>
}

export interface AmazonFrontReaderDeps {
  workspace_id: string
  /** 桌面壳的内置浏览器（没有 = 这台没有桌面壳）。 */
  channel(): SearchBrowserChannel | undefined
  /** 排进内置浏览器那条节流队（固定间隔）；这一小时满了回 `undefined`。 */
  page<T>(task: () => Promise<T>): Promise<T | undefined>
  nowMs(): number
  state(): AmazonFrontState
  saveState(next: AmazonFrontState): void
  /** 站点的配送邮编（不给用 `AMAZON_DELIVERY_ZIPS`）。 */
  zipOf?(marketplace: string): string | undefined
  /**
   * WP402（决策 1146）：品牌级「被 Amazon 拦了」（和联想词那一边共用一份）。给了就按它停、按它记；
   * 不给 = 只看自己这一份 `blocked_until`（测试 / 老装配）。
   */
  block?: AmazonBlockPort
  log?(message: string, fields?: Record<string, unknown>): void
}

export interface AmazonFrontReader {
  /** 这台能读 Amazon 前台吗（有桌面壳、没在被拦后的暂停里）。 */
  ready(): boolean
  /** 被拦后的暂停到几点（毫秒；没在暂停回 `undefined`）。 */
  pausedUntil(): number | undefined
  /** 读一页商品页 `/dp/{ASIN}` 的原文（WP396 用；配送地址照样先设好、不符重设一次）。 */
  readProduct(input: { marketplace: string; asin: string }): Promise<AmazonRawRead>
  /** 搜一页 `/s?k=` 的原文（WP396 用）。 */
  search(input: { marketplace: string; query: string }): Promise<AmazonRawRead>
  /** 读一页商品页、解析好（竞品对标款这一路）。 */
  readFacts(input: { marketplace: string; asin: string }): Promise<AmazonPageOutcome>
  /** 搜一页、交回卡片（挑对标款）。 */
  searchCards(input: { marketplace: string; query: string }): Promise<AmazonCardsRead>
  /** 读一页店铺页（自家 ASIN 读不到时，用户贴的店铺链接）：交回卡片上的 ASIN 与标题。 */
  readStorefront(url: string): Promise<AmazonStorefrontRead>
}

export type AmazonStorefrontRead =
  | { status: 'ok'; items: { asin: string; title: string }[] }
  | { status: 'blocked' | 'quota'; message?: string }
  | { status: 'failed'; message: string }

const BLOCKED_MSG = 'Amazon 要人机验证：内置浏览器先不读 Amazon，不绕、不重试（AI 不碰验证码）'
const NO_BROWSER = '这台电脑没有工坊内置浏览器'
const QUOTA_MSG = '内置浏览器这一小时的额度用完了'

interface Opened {
  raw: AmazonRawRead
  http?: number
}

export function createAmazonFrontReader(deps: AmazonFrontReaderDeps): AmazonFrontReader {
  const ws = deps.workspace_id
  const zipOf = deps.zipOf ?? ((mk: string) => AMAZON_DELIVERY_ZIPS[mk.trim().toUpperCase()])

  const pausedUntil = (): number | undefined => {
    if (deps.block !== undefined) return deps.block.pausedUntil()
    const until = deps.state().blocked_until
    return until !== undefined && until > deps.nowMs() ? until : undefined
  }

  const markBlocked = (url: string): void => {
    const now = deps.nowMs()
    if (deps.block !== undefined) deps.block.block('competitor')
    else
      deps.saveState({
        ...deps.state(),
        blocked_at: now,
        blocked_until: now + AMAZON_BLOCK_PAUSE_MS,
      })
    deps.log?.('Amazon 要人机验证：暂停读 Amazon', { workspace_id: ws, host: hostOf(url) })
  }

  /** 开一页原文（一页一个额度）；验证页记一次暂停。 */
  async function open(url: string): Promise<Opened> {
    const ch = deps.channel()
    if (ch === undefined) return { raw: { status: 'failed', url, message: NO_BROWSER } }
    if (pausedUntil() !== undefined)
      return { raw: { status: 'blocked', url, message: BLOCKED_MSG } }
    const got = await deps.page(() =>
      ch.open({
        workspace_id: ws,
        url,
        kind: 'html',
        timeout_ms: AMAZON_PAGE_TIMEOUT_MS,
        settle_ms: 1_000,
      }),
    )
    if (got === undefined) return { raw: { status: 'quota', message: QUOTA_MSG } }
    if (!got.ok) return { raw: { status: 'failed', url, message: got.message } }
    const html = got.page?.text ?? ''
    if (got.page?.signals.captcha === true || isAmazonChallenge(html)) {
      markBlocked(url)
      return { raw: { status: 'blocked', url, message: BLOCKED_MSG } }
    }
    return { raw: { status: 'ok', url, html }, http: got.status }
  }

  type Delivery =
    | { ok: true }
    | { ok: false; status: 'blocked' | 'quota' | 'failed'; message: string }

  /** 把这个站的「配送到」设好（设过、一周内、邮编没变就不再设）。设不了不拦着读：读完靠币种核对。 */
  async function ensureDelivery(mk: string, force: boolean): Promise<Delivery> {
    const zip = zipOf(mk)
    const host = amazonHostOfMarket(mk)
    if (zip === undefined || host === undefined) return { ok: true }
    const st = deps.state().delivery?.[mk]
    if (
      !force &&
      st !== undefined &&
      st.zip === zip &&
      deps.nowMs() - st.at < AMAZON_DELIVERY_FRESH_MS
    )
      return { ok: true }
    const ch = deps.channel()
    if (ch === undefined) return { ok: false, status: 'failed', message: NO_BROWSER }
    if (pausedUntil() !== undefined) return { ok: false, status: 'blocked', message: BLOCKED_MSG }
    if (ch.amazonDelivery === undefined)
      return { ok: false, status: 'failed', message: '这一版内置浏览器不会设配送地址' }
    const set = ch.amazonDelivery.bind(ch)
    const r = await deps.page(() =>
      set({ workspace_id: ws, url: `https://${host}`, zip, timeout_ms: AMAZON_PAGE_TIMEOUT_MS }),
    )
    if (r === undefined) return { ok: false, status: 'quota', message: QUOTA_MSG }
    if (!r.ok) {
      if (r.reason === 'blocked') {
        markBlocked(`https://${host}`)
        return { ok: false, status: 'blocked', message: BLOCKED_MSG }
      }
      return { ok: false, status: 'failed', message: `配送地址没设上：${r.message}` }
    }
    const cur = deps.state()
    deps.saveState({
      ...cur,
      delivery: {
        ...(cur.delivery ?? {}),
        [mk]: {
          zip,
          at: deps.nowMs(),
          ...(r.deliver_to === undefined ? {} : { deliver_to: r.deliver_to }),
        },
      },
    })
    deps.log?.('Amazon 配送地址设好了', { workspace_id: ws, marketplace: mk })
    return { ok: true }
  }

  /** 读到的币种和站点不符、或写着不能配送 = 配送地址不对。 */
  const wrongRegion = (
    mk: string,
    html: string,
  ): { currency?: string; to?: string } | undefined => {
    const f = parseAmazonProduct(html, { asin: 'X' })
    if (f === undefined) return undefined
    const want = amazonMarketCurrency(mk)
    const off =
      f.undeliverable || (want !== undefined && f.currency !== undefined && f.currency !== want)
    if (!off) return undefined
    return {
      ...(f.currency === undefined ? {} : { currency: f.currency }),
      ...(f.deliver_to === undefined ? {} : { to: f.deliver_to }),
    }
  }

  /** 开一页要比价的前台页：先设好地址；不符就重设一次、再读一次。 */
  async function openPriced(
    mk: string,
    url: string,
  ): Promise<{ opened: Opened; wrong?: { currency?: string; to?: string } }> {
    const d = await ensureDelivery(mk, false)
    if (!d.ok && d.status !== 'failed')
      return {
        opened: {
          raw:
            d.status === 'quota'
              ? { status: 'quota', message: d.message }
              : { status: 'blocked', url, message: d.message },
        },
      }
    const first = await open(url)
    if (first.raw.status !== 'ok') return { opened: first }
    const off = wrongRegion(mk, first.raw.html)
    if (off === undefined) return { opened: first }
    // 这次读数作废：重设一次配送地址，再读一次
    const again = await ensureDelivery(mk, true)
    if (!again.ok && again.status !== 'failed')
      return {
        opened: {
          raw:
            again.status === 'quota'
              ? { status: 'quota', message: again.message }
              : { status: 'blocked', url, message: again.message },
        },
      }
    const second = await open(url)
    if (second.raw.status !== 'ok') return { opened: second }
    const still = wrongRegion(mk, second.raw.html)
    return still === undefined ? { opened: second } : { opened: second, wrong: still }
  }

  const missing = (o: Opened): boolean =>
    o.http === 404 || (o.raw.status === 'ok' && isAmazonMissingPage(o.raw.html))

  const reader: AmazonFrontReader = {
    ready: () => deps.channel() !== undefined && pausedUntil() === undefined,
    pausedUntil,
    async readProduct({ marketplace, asin }) {
      const mk = marketplace.trim().toUpperCase()
      const url = amazonProductUrlOf(mk, asin)
      if (url === undefined)
        return { status: 'failed', url: '', message: `认不出站点 ${marketplace}` }
      const { opened } = await openPriced(mk, url)
      if (missing(opened))
        return { status: 'failed', url, message: '找不到这一页（下架了或 ASIN 不对）' }
      return opened.raw
    },
    async search({ marketplace, query }) {
      const mk = marketplace.trim().toUpperCase()
      const url = amazonSearchUrlOf(mk, query)
      if (url === undefined)
        return { status: 'failed', url: '', message: `认不出站点 ${marketplace}` }
      return (await openPriced(mk, url)).opened.raw
    },
    async readFacts({ marketplace, asin }) {
      const mk = marketplace.trim().toUpperCase()
      const url = amazonProductUrlOf(mk, asin)
      if (url === undefined) return { status: 'failed', message: `认不出站点 ${marketplace}` }
      const { opened, wrong } = await openPriced(mk, url)
      const raw = opened.raw
      if (raw.status === 'blocked')
        return { status: 'blocked', message: raw.message ?? BLOCKED_MSG }
      if (raw.status === 'quota') return { status: 'quota', message: raw.message ?? QUOTA_MSG }
      if (raw.status === 'failed') return { status: 'failed', message: raw.message }
      if (missing(opened)) return { status: 'missing', message: '找不到这一页' }
      if (wrong !== undefined)
        return {
          status: 'wrong_region',
          message: `配送地址设不到这个站（页面显示配送到「${wrong.to ?? '别处'}」${
            wrong.currency === undefined ? '' : `、价格是 ${wrong.currency}`
          }），这次作废`,
        }
      const facts = parseAmazonProduct(raw.html, { asin, url })
      return facts === undefined
        ? { status: 'failed', message: '读不出这一页' }
        : { status: 'ok', facts }
    },
    async searchCards({ marketplace, query }) {
      const raw = await reader.search({ marketplace, query })
      if (raw.status === 'ok') return { status: 'ok', cards: amazonSearchCards(raw.html) }
      if (raw.status === 'failed') return { status: 'failed', message: raw.message }
      return { status: raw.status, ...(raw.message === undefined ? {} : { message: raw.message }) }
    },
    async readStorefront(url) {
      let host = ''
      try {
        host = new URL(url).hostname
      } catch {
        return { status: 'failed', message: '这不是一个网址' }
      }
      if (!isAmazonHost(host)) return { status: 'failed', message: '只读 Amazon 的店铺链接' }
      const { raw } = await open(url)
      if (raw.status === 'failed') return { status: 'failed', message: raw.message }
      if (raw.status !== 'ok')
        return {
          status: raw.status,
          ...(raw.message === undefined ? {} : { message: raw.message }),
        }
      const items = storefrontCards(raw.html, url)
        .filter((p) => p.asin !== undefined)
        .map((p) => ({ asin: (p.asin as string).toUpperCase(), title: p.title }))
      return { status: 'ok', items }
    },
  }
  return reader
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}
