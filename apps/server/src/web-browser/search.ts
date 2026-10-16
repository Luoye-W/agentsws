/**
 * WP353（Luoye 10-16，决策 912）：联网搜索的**后端**——工坊内置浏览器搜 Google（官方 `web_search` /
 * `web_fetch` 工具面一个字不改，只换后端；接在 dsh-adapter 的 `agentsws-browser` 那个口上）。
 *
 * 一次搜索怎么走（每一步不行就照实记一句、换下一路；最后结果照实标「来自哪一路」）：
 *
 * 1. 7 天缓存（同一句话、同一市场语言）；
 * 2. **内置浏览器开 Google**（桌面壳那个隐藏视图；带品牌主市场的 `gl` / `hl`）——打不开（超时 / 断网）换 Bing；
 *    进了 `/sorry/` 或人机验证页：**记一次暂停**；同一天**第二次**被拦，就把那一页亮给人（第三栏「浏览器」），
 *    在结果里说一句「需要你在那页点一下验证」——**人自己点，AI 不碰验证码**；人点过之后暂停自动解除；
 * 3. **内置浏览器开 Bing**（同一个浏览器）；
 * 4. **云端 Google**（`/v1/search-data/serp`，官方按积分或用户自带 key）——只有接了才走；
 * 5. **公开搜索服务**（社区插件 `@240xu/dsh-websearch` 的两家免 key 匿名口，见 dsh-adapter `keyless-search.ts`）。
 *
 * 节流：同一时刻只开一页（全进程一条队，多个品牌也排一条）；两次之间随机隔 2–4 秒；每小时上限，
 * 超了这一小时不再开内置浏览器（往后几路照走），不失败。
 *
 * `web_fetch`：Reddit / LinkedIn / Quora 这类匿名抓取常被拒的站，用同一个内置浏览器打开、只读取正文；
 * 别的站照旧官方匿名抓取（分流在 dsh-adapter 里，按 {@link BrowserWebSearch.fetchHosts}）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SerpQuery, SerpResult } from '@agentsws/contracts'
import type { OpenResult, SearchBrowserChannel } from './channel.js'
import { blockOf } from './detect.js'
import {
  bingSearchUrl,
  googleSearchUrl,
  type LocaleProfile,
  type SearchLocale,
  searchLocaleOf,
} from './locale.js'

export interface SearchSource {
  url: string
  title?: string
  snippet?: string
}

/** 结果来自哪一路（审计 / 界面照实标）。 */
export type SearchVia = 'google' | 'bing' | 'cloud_google' | 'public'

export interface BrowserSearchResult {
  sources: SearchSource[]
  /** 给模型的那几句（来自哪一路、前面几路为什么没用上、要不要人点验证）。 */
  content: string
  truncated: boolean
  via?: SearchVia
  cached?: boolean
  /** 这次把一页亮给人了（第三栏「浏览器」）。 */
  handover?: boolean
  locale: SearchLocale
}

export interface FetchedPage {
  url: string
  statusCode: number
  body: { kind: 'text'; content: string }
  truncated: boolean
}

/** 内置浏览器读正文的那几家站（`hostAllowed` 写法）。 */
export const BROWSER_FETCH_HOSTS: readonly string[] = [
  '*.reddit.com',
  '*.linkedin.com',
  '*.quora.com',
]

/** 7 天缓存。 */
export const SEARCH_CACHE_TTL_MS = 7 * 86_400_000
const CACHE_MAX = 300
/** 第一次被拦停多久；第二次（亮给人之后）停多久（人点过就提前解除）。 */
export const FIRST_BLOCK_PAUSE_MS = 30 * 60_000
export const HANDOVER_PAUSE_MS = 6 * 3_600_000
const DAY = 86_400_000
const HOUR = 3_600_000

/** Google 加载等多久算「打不开」；Bing 同。 */
export const ENGINE_TIMEOUT_MS = 8_000

export const HANDOVER_MESSAGE =
  'Google 要人机验证：那一页已经放在右边「浏览器」里，需要你在那页点一下验证（AI 不碰验证码）。'

const webError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code })

// ── 节流（全进程一份）─────────────────────────────────────────────────────

export interface SearchThrottle {
  /** 排队跑一个「开一页」：等到轮到、隔够随机间隔才开；这一小时满了回 `undefined`（不开）。 */
  run<T>(task: () => Promise<T>): Promise<T | undefined>
  /** 这一小时已经开了几页。 */
  usedThisHour(): number
  readonly maxPerHour: number
}

export function createSearchThrottle(o: {
  now(): number
  random(): number
  sleep(ms: number): Promise<void>
  maxPerHour?: number
  minGapMs?: number
  maxGapMs?: number
}): SearchThrottle {
  const maxPerHour = o.maxPerHour ?? 60
  const minGap = o.minGapMs ?? 2_000
  const maxGap = o.maxGapMs ?? 4_000
  let queue: Promise<unknown> = Promise.resolve()
  let last: number | undefined
  let opened: number[] = []
  const prune = (): void => {
    const now = o.now()
    opened = opened.filter((t) => t > now - HOUR)
  }
  return {
    maxPerHour,
    usedThisHour() {
      prune()
      return opened.length
    },
    run(task) {
      const next = queue.then(async () => {
        prune()
        if (opened.length >= maxPerHour) return undefined
        if (last !== undefined) {
          const gap = minGap + Math.floor(o.random() * (maxGap - minGap))
          const wait = last + gap - o.now()
          if (wait > 0) await o.sleep(wait)
        }
        last = o.now()
        opened.push(last)
        try {
          return await task()
        } finally {
          last = o.now()
        }
      })
      queue = next.catch(() => undefined)
      return next
    },
  }
}

// ── 状态（暂停 / 缓存）落盘 ───────────────────────────────────────────────

interface EngineState {
  /** 最近 24 小时被拦的时刻。 */
  hits: number[]
  pause?: { at: number; until: number; handover: boolean }
}

interface StateFile {
  version: 1
  engines: Partial<Record<'google' | 'bing', EngineState>>
  cache: Record<string, { at: number; via: SearchVia; sources: SearchSource[] }>
}

function loadState(file: string | undefined): StateFile {
  const empty: StateFile = { version: 1, engines: {}, cache: {} }
  if (file === undefined || !existsSync(file)) return empty
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<StateFile>
    return {
      version: 1,
      engines: raw.engines ?? {},
      cache: raw.cache ?? {},
    }
  } catch {
    return empty
  }
}

// ── 搜索后端 ───────────────────────────────────────────────────────────

export interface BrowserWebSearchOptions {
  workspace_id: string
  /** 状态文件放哪（品牌目录下）；不给 = 只在内存里。 */
  dir?: string
  /** 桌面壳的内置浏览器；没有 = 这台没有桌面壳（CI、云端值守、纯服务进程）。 */
  channel?: SearchBrowserChannel | undefined
  throttle: SearchThrottle
  /** 品牌档案里的市场与语言（每次现取）。 */
  profile(): LocaleProfile | undefined
  /** 云端 Google（搜索数据接口）。没接 / 没配好 = `available()` 回 false。 */
  cloud?: { available(): Promise<boolean>; serp(q: SerpQuery): Promise<SerpResult> } | undefined
  /** 公开搜索服务（免 key 匿名口）。没有 = 不走这一路。 */
  keyless?: (() => KeylessSearch | undefined) | undefined
  now(): number
  log?(line: string): void
}

export interface KeylessSearch {
  search(
    request: { query: string; maxResults?: number },
    signal?: AbortSignal,
  ): Promise<{ sources: readonly SearchSource[] }>
}

export interface BrowserWebSearch {
  /** 有没有任何一路能搜。 */
  available(): boolean
  search(query: string, maxResults?: number): Promise<BrowserSearchResult>
  fetch(url: string): Promise<FetchedPage>
  /** 交给内置浏览器抓的站（没有桌面壳 = 空，全走官方匿名抓取）。 */
  readonly fetchHosts: readonly string[]
}

const ENGINE_NAME = { google: 'Google', bing: 'Bing' } as const

/** 查询里 `site:xxx` 限定的站（只认第一个）。 */
function siteOf(query: string): string | undefined {
  return /(?:^|\s)site:([^\s/]+)/iu
    .exec(query)?.[1]
    ?.toLowerCase()
    .replace(/^www\./, '')
}

function onSite(url: string, site: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase()
    return h === site || h.endsWith(`.${site}`)
  } catch {
    return false
  }
}

const clock = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function createBrowserWebSearch(o: BrowserWebSearchOptions): BrowserWebSearch {
  const file = o.dir === undefined ? undefined : join(o.dir, 'web-search.json')
  const state = loadState(file)
  const flush = (): void => {
    if (file === undefined) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(`${file}.tmp`, JSON.stringify(state))
      renameSync(`${file}.tmp`, file)
    } catch {
      // 落不了盘只影响缓存与暂停记忆，不影响搜索
    }
  }
  const engine = (e: 'google' | 'bing'): EngineState => {
    let s = state.engines[e]
    if (s === undefined) {
      s = { hits: [] }
      state.engines[e] = s
    }
    return s
  }

  /** 这家现在停着没有（人点过验证就提前解除）。 */
  async function paused(e: 'google' | 'bing'): Promise<{ until: number } | undefined> {
    const s = engine(e)
    const p = s.pause
    if (p === undefined) return undefined
    const now = o.now()
    if (p.until <= now) {
      delete s.pause
      flush()
      return undefined
    }
    const st = await o.channel?.status(o.workspace_id)
    if (st?.verified_at !== undefined && st.verified_at > p.at) {
      delete s.pause
      s.hits = []
      flush()
      o.log?.(`web-search: ${e} 人已经过了验证，解除暂停`)
      return undefined
    }
    return { until: p.until }
  }

  /** 内置浏览器开一个搜索结果页。回：结果 / 一句为什么没用上 / 亮给人了。 */
  async function viaBrowser(
    e: 'google' | 'bing',
    query: string,
    locale: SearchLocale,
  ): Promise<{ sources?: SearchSource[]; note?: string; handover?: boolean }> {
    const channel = o.channel
    if (channel === undefined) return {}
    const p = await paused(e)
    if (p !== undefined)
      return { note: `${ENGINE_NAME[e]} 之前被人机验证拦过，暂停到 ${clock(p.until)}` }
    const url = e === 'google' ? googleSearchUrl(query, locale) : bingSearchUrl(query, locale)
    const got: OpenResult | undefined = await o.throttle.run(() =>
      channel.open({
        workspace_id: o.workspace_id,
        url,
        kind: e,
        timeout_ms: ENGINE_TIMEOUT_MS,
        settle_ms: 1_500,
      }),
    )
    if (got === undefined)
      return {
        note: `这一小时内置浏览器已经开了 ${o.throttle.maxPerHour} 页（上限），${ENGINE_NAME[e]} 这次没开`,
      }
    if (!got.ok) return { note: `${ENGINE_NAME[e]} 这次没打开（${got.message}）` }
    const block = blockOf(got)
    if (block !== undefined) {
      const s = engine(e)
      const now = o.now()
      s.hits = [...s.hits.filter((t) => t > now - DAY), now]
      const human =
        e === 'google' && (block.kind === 'captcha' || block.kind === 'login') && s.hits.length >= 2
      if (human) {
        s.pause = { at: now, until: now + HANDOVER_PAUSE_MS, handover: true }
        flush()
        const shown = await channel.reveal({
          workspace_id: o.workspace_id,
          url,
          reason: block.kind === 'login' ? 'login' : 'captcha',
          message: '需要你在这页点一下验证（AI 不碰验证码）；点过之后搜索会自动接着用 Google。',
        })
        return shown
          ? { note: HANDOVER_MESSAGE, handover: true }
          : {
              note: `${ENGINE_NAME[e]} ${block.message}，已暂停到 ${clock(now + HANDOVER_PAUSE_MS)}`,
            }
      }
      s.pause = { at: now, until: now + FIRST_BLOCK_PAUSE_MS, handover: false }
      flush()
      return {
        note: `${ENGINE_NAME[e]} ${block.message}，先暂停到 ${clock(now + FIRST_BLOCK_PAUSE_MS)}（不绕过）`,
      }
    }
    return { sources: got.serp?.items ?? [] }
  }

  async function viaCloud(
    query: string,
    locale: SearchLocale,
  ): Promise<{ sources?: SearchSource[]; note?: string }> {
    const cloud = o.cloud
    if (cloud === undefined) return {}
    if (!(await cloud.available().catch(() => false))) return {}
    try {
      const r = await cloud.serp({
        query,
        engine: 'google',
        country: (locale.market ?? 'US').toLowerCase(),
        language: locale.language.toLowerCase(),
      })
      return {
        sources: r.items.map((i) => ({
          url: i.url,
          title: i.title,
          ...(i.snippet === undefined ? {} : { snippet: i.snippet }),
        })),
      }
    } catch (err) {
      return {
        note: `云端 Google 这次没搜成（${err instanceof Error ? err.message : String(err)}）`,
      }
    }
  }

  async function viaPublic(
    query: string,
    maxResults: number,
  ): Promise<{ sources?: SearchSource[]; note?: string }> {
    const provider = o.keyless?.()
    if (provider === undefined) return {}
    try {
      const r = await provider.search({ query, maxResults }, AbortSignal.timeout(45_000))
      return { sources: [...r.sources] }
    } catch (err) {
      return {
        note: `公开搜索服务这次没搜成（${err instanceof Error ? err.message : String(err)}）`,
      }
    }
  }

  const VIA_LINE: Record<SearchVia, string> = {
    google: '这次的结果来自 Google（工坊内置浏览器）',
    bing: '这次的结果来自 Bing（工坊内置浏览器）',
    cloud_google: '这次的结果来自云端 Google 搜索',
    public: '这次的结果来自公开搜索服务',
  }

  return {
    fetchHosts: o.channel === undefined ? [] : BROWSER_FETCH_HOSTS,
    available: () => o.channel !== undefined || o.cloud !== undefined || o.keyless !== undefined,

    async search(query, maxResults = 10) {
      const locale = searchLocaleOf(o.profile(), query)
      const key = `${locale.language}|${locale.market ?? ''}|${query.trim().toLowerCase()}`
      const now = o.now()
      const hit = state.cache[key]
      if (hit !== undefined && hit.at > now - SEARCH_CACHE_TTL_MS) {
        return {
          sources: hit.sources.slice(0, maxResults),
          content: `${VIA_LINE[hit.via]}（7 天内搜过同一句，用的是上次的结果）。`,
          truncated: false,
          via: hit.via,
          cached: true,
          locale,
        }
      }
      const site = siteOf(query)
      const notes: string[] = []
      let handover = false
      let anyLoaded = false
      const steps: [
        SearchVia,
        () => Promise<{ sources?: SearchSource[]; note?: string; handover?: boolean }>,
      ][] = [
        ['google', () => viaBrowser('google', query, locale)],
        ['bing', () => viaBrowser('bing', query, locale)],
        ['cloud_google', () => viaCloud(query, locale)],
        ['public', () => viaPublic(query, maxResults)],
      ]
      for (const [via, step] of steps) {
        const got = await step()
        if (got.handover === true) handover = true
        if (got.note !== undefined) notes.push(got.note)
        if (got.sources === undefined) continue
        anyLoaded = true
        // `site:` 限定：不在那个站上的不算（有的引擎会无视限定、回一堆无关站）
        const sources = (
          site === undefined ? got.sources : got.sources.filter((s) => onSite(s.url, site))
        )
          .filter((s) => /^https?:\/\//.test(s.url))
          .slice(0, maxResults)
        if (sources.length === 0) {
          notes.push(
            `${via === 'public' ? '公开搜索服务' : via === 'cloud_google' ? '云端 Google' : ENGINE_NAME[via]} 没搜到相关结果`,
          )
          continue
        }
        state.cache[key] = { at: o.now(), via, sources }
        const keys = Object.keys(state.cache)
        if (keys.length > CACHE_MAX) {
          for (const k of keys
            .sort((a, b) => (state.cache[a]?.at ?? 0) - (state.cache[b]?.at ?? 0))
            .slice(0, keys.length - CACHE_MAX))
            delete state.cache[k]
        }
        flush()
        const before = notes.length === 0 ? '' : `前面没用上的：${notes.join('；')}。`
        return {
          sources,
          content: `${VIA_LINE[via]}。${before}`,
          truncated: false,
          via,
          ...(handover ? { handover: true } : {}),
          locale,
        }
      }
      if (!anyLoaded && notes.length === 0)
        throw webError(
          'WEB_PROVIDER_UNAVAILABLE',
          '这里没有内置浏览器，也没接云端搜索，联网搜索用不了。',
        )
      if (!anyLoaded) throw webError('WEB_PROVIDER_ERROR', `这次没搜成：${notes.join('；')}。`)
      return {
        sources: [],
        content: `没搜到相关结果：${notes.join('；')}。`,
        truncated: false,
        ...(handover ? { handover: true } : {}),
        locale,
      }
    },

    async fetch(url) {
      const channel = o.channel
      if (channel === undefined)
        throw webError('WEB_PROVIDER_UNAVAILABLE', '这里没有内置浏览器，读不了这一页。')
      const got = await o.throttle.run(() =>
        channel.open({
          workspace_id: o.workspace_id,
          url,
          kind: 'page',
          timeout_ms: 20_000,
          settle_ms: 800,
          max_chars: 60_000,
        }),
      )
      if (got === undefined)
        throw webError(
          'WEB_PROVIDER_ERROR',
          `这一小时内置浏览器已经开了 ${o.throttle.maxPerHour} 页（上限），过一会儿再读。`,
        )
      if (!got.ok) throw webError('WEB_PROVIDER_ERROR', `这一页没打开：${got.message}`)
      const block = blockOf(got)
      if (block !== undefined)
        throw webError(
          'WEB_FETCH_BLOCKED',
          block.kind === 'login'
            ? '这一页要登录才能看（工坊内置浏览器没有登录这个站），没读到正文。'
            : `这个站${block.message}，没读到正文（不绕过）。`,
        )
      const page = got.page
      const title = page?.signals.title ?? ''
      return {
        url: got.final_url,
        statusCode: got.status === 0 ? 200 : got.status,
        body: { kind: 'text', content: `${title}\n\n${page?.text ?? ''}`.trim() },
        truncated: page?.truncated ?? false,
      }
    },
  }
}
