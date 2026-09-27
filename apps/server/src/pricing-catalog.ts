/**
 * WP165（docs/83 §2「价目表只放云上」）：本机手上那一份价目。
 *
 * 以前价目表与充值档位是 `@agentsws/metering` 里内置的两份 json，本机直接读。价格是生意，
 * 不进开源仓，所以现在：
 *
 * 1. **从云上取**：`GET /v1/pricing`（公开、不要令牌），一次给齐价目表 + 充值档位；
 * 2. **本机落一份缓存**（数据目录下 `pricing-cache.json`），断网时离线显示；
 * 3. **取不到用上一份**（`source: 'cache'`）；**从没取到过**就说「价目暂时拿不到」
 *    （`source: 'unavailable'`，列表是空的）——**一个数都不编**。
 *
 * 什么时候打云：只在有人要看价目的时候（`pricing()` / `topupTiers()` / `priceOf()`）按需取，
 * 外加生产入口起来后顺手取一次（`refresh()`）。同步读的那几处（生图一张几积分、看一次邮箱几积分）
 * 只读手上这一份，**从不因为同步读而打网**——测试与合成世界因此一个字节都不出机器。
 * 一台机器一份（价目不分品牌）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  Clock,
  Iso8601,
  LocalPricing,
  LocalTopupTiers,
  PricingCatalog,
} from '@agentsws/contracts'
import {
  catalogCreditsFor,
  isPricingCatalog,
  PRICING_CATALOG_PATH,
  unavailablePricing,
  unavailableTopupTiers,
} from '@agentsws/contracts'
import type { CloudFetch } from './cloud.js'

/** 缓存文件名（数据目录下）。 */
export const PRICING_CACHE_FILE = 'pricing-cache.json'

/** 刚取到过就不再打云（与云上给的 `max-age` 同一个量级）。 */
export const PRICING_FRESH_MS = 5 * 60_000

/** 上一次没取到，隔多久再试（别让每次点开设置页都卡一个超时）。 */
export const PRICING_RETRY_MS = 60_000

/** 打云最多等多久。 */
export const PRICING_TIMEOUT_MS = 8_000

interface CacheFile {
  version: 1
  fetched_at: Iso8601
  catalog: PricingCatalog
}

export interface PricingCatalogSource {
  /** 手上这一份（同步、不打网）；从没取到过回 `undefined`。 */
  current(): PricingCatalog | undefined
  /** 一项能力多少积分（同步、只读手上这一份）；价目里没有 / 手上没有回 `undefined`。 */
  creditsFor(capability: string, quantity?: number): number | undefined
  /** 按需刷新（刚取过、刚失败过都不打）。回刷新之后手上那一份。 */
  refresh(options?: { force?: boolean }): Promise<PricingCatalog | undefined>
  /** 界面看的价目表：先按需刷新，再带上出处。 */
  pricing(): Promise<LocalPricing>
  /** 界面看的充值档位（同上）。 */
  topupTiers(): Promise<LocalTopupTiers>
}

export interface PricingCatalogOptions {
  clock: Clock
  /** 云的地址（`cloudBaseUrl(env)`）。 */
  baseUrl: string
  /** 测试 / demo 注入；不给就用全局 `fetch`。 */
  fetch?: CloudFetch
  /** 缓存文件所在目录；不给就只在内存里（测试与一次性任务）。 */
  dir?: string
}

function readCache(file: string | undefined): CacheFile | undefined {
  if (file === undefined) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CacheFile>
    if (typeof parsed.fetched_at !== 'string' || !isPricingCatalog(parsed.catalog)) return undefined
    return { version: 1, fetched_at: parsed.fetched_at, catalog: parsed.catalog }
  } catch {
    // 第一次跑、文件坏了：当成从没取到过
    return undefined
  }
}

export function createPricingCatalog(options: PricingCatalogOptions): PricingCatalogSource {
  const { clock } = options
  const file = options.dir === undefined ? undefined : join(options.dir, PRICING_CACHE_FILE)
  const doFetch: CloudFetch =
    options.fetch ??
    ((input, init) =>
      globalThis.fetch(input, init as RequestInit) as unknown as ReturnType<CloudFetch>)

  let held: CacheFile | undefined = readCache(file)
  /** 这一次进程里最近一次从云上取到的时刻（毫秒）；缓存文件读来的不算「刚取到」。 */
  let freshAt: number | undefined
  let failedAt: number | undefined
  let inflight: Promise<PricingCatalog | undefined> | undefined

  const fetchOnce = async (): Promise<PricingCatalog | undefined> => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, PRICING_TIMEOUT_MS)
    try {
      // 公开的那条：**不带令牌**（没关联账号也要看得到价钱）
      const res = await doFetch(`${options.baseUrl}${PRICING_CATALOG_PATH}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      if (!res.ok) return undefined
      const envelope = (await res.json()) as { data?: unknown }
      return isPricingCatalog(envelope.data) ? envelope.data : undefined
    } catch {
      // 云连不上不是本地的错：用上一份，或者说「暂时拿不到」
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  const refresh = async (opts: { force?: boolean } = {}): Promise<PricingCatalog | undefined> => {
    const nowMs = Date.parse(clock.now())
    if (opts.force !== true) {
      if (freshAt !== undefined && nowMs - freshAt < PRICING_FRESH_MS) return held?.catalog
      if (failedAt !== undefined && nowMs - failedAt < PRICING_RETRY_MS) return held?.catalog
    }
    inflight ??= (async () => {
      const got = await fetchOnce()
      if (got === undefined) {
        failedAt = nowMs
        return held?.catalog
      }
      held = { version: 1, fetched_at: clock.now(), catalog: got }
      freshAt = nowMs
      failedAt = undefined
      if (file !== undefined) {
        try {
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, `${JSON.stringify(held, null, 2)}\n`, 'utf8')
        } catch {
          // 存不下只是下次离线看不到；这一次照样显示
        }
      }
      return got
    })().finally(() => {
      inflight = undefined
    })
    return inflight
  }

  /** 手上这一份是这一次取到的，还是上一份存下来的。 */
  const origin = (): { source: 'cloud' | 'cache'; fetched_at: Iso8601 } | undefined =>
    held === undefined
      ? undefined
      : {
          // 这一次进程里取到过、而且之后没再失败过，才算「云上的」；否则是存下来的那一份
          source: freshAt === undefined || failedAt !== undefined ? 'cache' : 'cloud',
          fetched_at: held.fetched_at,
        }

  return {
    current: () => held?.catalog,
    creditsFor: (capability, quantity = 1) =>
      catalogCreditsFor(held?.catalog.pricing, capability, quantity),
    refresh,
    async pricing() {
      await refresh()
      const o = origin()
      if (held === undefined || o === undefined) return unavailablePricing()
      return { ...held.catalog.pricing, ...o }
    },
    async topupTiers() {
      await refresh()
      const o = origin()
      if (held === undefined || o === undefined) return unavailableTopupTiers()
      return { ...held.catalog.topup_tiers, ...o }
    },
  }
}
