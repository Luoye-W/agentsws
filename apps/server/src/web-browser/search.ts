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
 * 2½. WP455：**你的 Chrome 搜 Google**（通过插件，后台窗口、读完自动关；只在上一步没拿到结果时走，
 *    每小时最多 20 次、被 Google 拦了停到北京时间第二天零点，见 `own-chrome.ts`）；
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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SerpQuery, SerpResult } from '@agentsws/contracts'
import type { OpenResult, SearchBrowserChannel } from './channel.js'
import { type Block, blockOf } from './detect.js'
import {
  bingSearchUrl,
  googleSearchUrl,
  type LocaleProfile,
  type SearchLocale,
  searchLocaleOf,
} from './locale.js'
import {
  NATIVE_SEARCH_LABEL,
  type NativeSearchPort,
  type NativeSearchSource,
  nativeSearchSourceOf,
  type SearchWho,
} from './native.js'
import type { OwnChromeSearch } from './own-chrome.js'
import { openResultOfHtml } from './serp-html.js'

export interface SearchSource {
  url: string
  title?: string
  snippet?: string
}

/**
 * 结果来自哪一路（审计 / 界面照实标）。WP355：`native` = 名单里那家模型自带的搜索。
 * WP455：`own_chrome` = 通过插件在你自己的 Chrome 里搜的 Google。
 */
export type SearchVia = 'google' | 'own_chrome' | 'bing' | 'cloud_google' | 'public' | 'native'

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
  /** WP355：`via: 'native'` 时是哪家（`openai-codex`）。 */
  native_source?: NativeSearchSource
  /** WP355：自带搜索这一次用的模型与 token（订阅不按 token 收钱；宿主照 `cost_base: 0` 记一笔用量）。 */
  native_usage?: {
    model: string
    input_tokens: number
    output_tokens: number
    cached_tokens: number
  }
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
/**
 * WP455（docs/110 §3.1 第 6 条）：「用你的 Chrome 搜 Google」每小时最多几次（整台机一份，`own-chrome.ts`）；
 * 同时照样计入上面那道每小时 60 页的总上限。
 */
export const OWN_CHROME_MAX_PER_HOUR = 20
/** WP455：每个品牌第一次走这一路时，在那条搜索结果说明里加的那一句（之后不再说）。 */
export const OWN_CHROME_TELL_LINE = '这次用了你的 Chrome 搜 Google（后台窗口，读完自动关）'
/** WP455：在你的 Chrome 里被 Google 拦过之后，这一步记 `skipped` 的原因（停到北京时间第二天零点）。 */
export const OWN_CHROME_PAUSED_WHY = '今天在你的 Chrome 里被 Google 拦过'
const DAY = 86_400_000
const HOUR = 3_600_000

/**
 * Google 加载等多久算「打不开」；Bing 同。WP454：8 秒 → 15 秒（走代理时偏紧）；壳那边 `dom-ready` 之后
 * 还会再等最多 8 秒等过渡页跳到真结果页（不算在这里面）。读正文那一路不动。
 */
export const ENGINE_TIMEOUT_MS = 15_000

/** WP454：热身开的那一页。 */
export const GOOGLE_HOME = 'https://www.google.com/'

/** WP454：第三栏那一句（Google 的 cookie 同意页）。 */
export const CONSENT_HANDOVER_LINE =
  'Google 要你选一次 cookie 设置：在这页上自己选（AI 不点）；选完之后搜索会自动接着用 Google。'
export const CONSENT_MESSAGE =
  'Google 要你选一次 cookie 设置：那一页已经放在右边「浏览器」里，需要你在那页自己选一次（AI 不点）。'

/** WP454：每个品牌留多少次搜索的留痕。 */
export const SEARCH_TRACE_MAX = 50

/**
 * WP454：一次搜索里每一步的结果。`failed` 是派工单那 7 种之外补的一种：打开时出错但不是超时（断网、壳回错）。
 */
export type SearchStepResult =
  | 'ok'
  | 'blocked'
  | 'interstitial'
  | 'consent'
  | 'timeout'
  | 'empty'
  | 'skipped'
  | 'failed'

export interface SearchTraceStep {
  /** 哪一步；`google_warmup` = 第一次搜 Google 前开一次首页。 */
  via: SearchVia | 'google_warmup'
  result: SearchStepResult
  /** 这一步花了多久（毫秒，含排队与节流间隔）。 */
  ms: number
  /** 为什么没用上（人话一句）。 */
  why?: string
}

/** WP454：一次搜索的留痕（只在本机 `web-search.json`，不上云；查询只存哈希）。 */
export interface SearchTraceEntry {
  at: number
  /** 查询（含市场语言）的 sha256 前 16 位——不存原文。 */
  query_hash: string
  /** 最后用上的那一路；都没用上 = 没有。 */
  via?: SearchVia
  cached?: boolean
  ms: number
  steps: SearchTraceStep[]
}

/** 一步走完回什么（`result` 不给 = 由主循环按有没有结果定）。 */
interface StepOutcome {
  sources?: SearchSource[]
  note?: string
  handover?: boolean
  result?: SearchStepResult
  why?: string
  /** WP455：这一步第一次用了你的 Chrome（结果说明里加那一句）。 */
  tell?: boolean
}

export const HANDOVER_MESSAGE =
  'Google 要人机验证：那一页已经放在右边「浏览器」里，需要你在那页点一下验证（AI 不碰验证码）。'

const webError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code })

// ── 节流（全进程一份）─────────────────────────────────────────────────────

export interface SearchThrottle {
  /**
   * 排队跑一个「开一页」：等到轮到、隔够随机间隔才开；这一小时满了回 `undefined`（不开）。
   * WP398：`steady` = 固定间隔（取最短那一档），**不加随机停顿**——读 Amazon 用（docs/106 §2.1：不模仿人的节奏；
   * 固定间隔是防误操作，可以留）。照样算进这一小时的额度。
   */
  run<T>(task: () => Promise<T>, opts?: { steady?: boolean }): Promise<T | undefined>
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
    run(task, opts) {
      const next = queue.then(async () => {
        prune()
        if (opened.length >= maxPerHour) return undefined
        if (last !== undefined) {
          const gap =
            opts?.steady === true ? minGap : minGap + Math.floor(o.random() * (maxGap - minGap))
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
  cache: Record<
    string,
    { at: number; via: SearchVia; native?: NativeSearchSource; sources: SearchSource[] }
  >
  /** WP454：最近 {@link SEARCH_TRACE_MAX} 次搜索每一步的结果（新的在后）。 */
  trace?: SearchTraceEntry[]
  /** WP454：最近一次 Google 那一步没用上：什么时候、结果、为什么（一眼看出来用）。 */
  google_last_miss?: { at: number; result: SearchStepResult; why?: string }
  /** WP455：这个品牌第一次用你的 Chrome 搜 Google 是什么时候（说过那一句就不再说）。 */
  own_chrome_told_at?: number
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
      ...(Array.isArray(raw.trace) ? { trace: raw.trace.slice(-SEARCH_TRACE_MAX) } : {}),
      ...(raw.google_last_miss === undefined ? {} : { google_last_miss: raw.google_last_miss }),
      ...(typeof raw.own_chrome_told_at === 'number'
        ? { own_chrome_told_at: raw.own_chrome_told_at }
        : {}),
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
  /**
   * WP355（决策 937）：名单里的模型来源自带的联网搜索（产品里接订阅登录那棵树）。
   * 不给 = 名单里的来源也照旧走 WP353 的链。
   */
  native?: NativeSearchPort | undefined
  /** WP355：自带搜索的节流（全进程一份；同一时刻只搜一次、每小时上限）。不给 = 不另节流。 */
  nativeThrottle?: SearchThrottle | undefined
  /**
   * WP455（决策 1434）：内置浏览器 Google 没拿到结果时，通过插件在你自己的 Chrome 里搜一次 Google。
   * 不给 / `reader()` 回 `undefined`（没选「用你正在用的浏览器」、插件没装好、托管实例）= 这一步记 `skipped`。
   */
  ownChrome?: OwnChromeSearch | undefined
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
  /** WP355：`who` = 这次是谁、用的哪个模型来源（名单里的来源先走它自带的搜索）。 */
  search(query: string, maxResults?: number, who?: SearchWho): Promise<BrowserSearchResult>
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

  /** WP454：这个品牌第一次搜 Google 之前要不要先热身（本进程里试过一次就不再试）。 */
  let warmed = false
  let warming: Promise<StepOutcome | undefined> | undefined

  /** 被拦 / 过渡页 / 同意页怎么处理（搜索那一页、热身那一页共用）。 */
  async function onBlock(
    e: 'google' | 'bing',
    block: Block,
    url: string,
  ): Promise<{ note: string; handover?: boolean; result: SearchStepResult }> {
    const channel = o.channel
    const now = o.now()
    // WP454：过渡页只记一句、换下一路——不计被拦次数、不暂停、不亮给人
    if (block.kind === 'interstitial')
      return {
        note: `${ENGINE_NAME[e]} 没出结果（过渡页，等了 8 秒还没跳到结果页）`,
        result: 'interstitial',
      }
    const s = engine(e)
    // WP454：cookie 同意页——不算被拦，但要人选一次（AI 不点）；人选过照 verified_at 解除
    if (block.kind === 'consent') {
      const shown =
        channel === undefined
          ? false
          : await channel.reveal({
              workspace_id: o.workspace_id,
              url,
              reason: 'consent',
              message: CONSENT_HANDOVER_LINE,
            })
      const until = now + (shown ? HANDOVER_PAUSE_MS : FIRST_BLOCK_PAUSE_MS)
      s.pause = { at: now, until, handover: shown }
      flush()
      return shown
        ? { note: CONSENT_MESSAGE, handover: true, result: 'consent' }
        : {
            note: `${ENGINE_NAME[e]} ${block.message}，先暂停到 ${clock(until)}`,
            result: 'consent',
          }
    }
    s.hits = [...s.hits.filter((t) => t > now - DAY), now]
    const human =
      e === 'google' && (block.kind === 'captcha' || block.kind === 'login') && s.hits.length >= 2
    if (human && channel !== undefined) {
      s.pause = { at: now, until: now + HANDOVER_PAUSE_MS, handover: true }
      flush()
      const shown = await channel.reveal({
        workspace_id: o.workspace_id,
        url,
        reason: block.kind === 'login' ? 'login' : 'captcha',
        message: '需要你在这页点一下验证（AI 不碰验证码）；点过之后搜索会自动接着用 Google。',
      })
      return shown
        ? { note: HANDOVER_MESSAGE, handover: true, result: 'blocked' }
        : {
            note: `${ENGINE_NAME[e]} ${block.message}，已暂停到 ${clock(now + HANDOVER_PAUSE_MS)}`,
            result: 'blocked',
          }
    }
    s.pause = { at: now, until: now + FIRST_BLOCK_PAUSE_MS, handover: false }
    flush()
    return {
      note: `${ENGINE_NAME[e]} ${block.message}，先暂停到 ${clock(now + FIRST_BLOCK_PAUSE_MS)}（不绕过）`,
      result: 'blocked',
    }
  }

  /**
   * WP454：第一次搜 Google 之前先开一次 Google 首页（只开不点，等 `dom-ready` 加 1.5 秒；算进每小时上限）。
   * partition 里已经有 Google 的 cookie（壳经 `status` 的 `google_cookies` 告诉）就跳过。
   * 回 `undefined` = 接着搜；回别的 = 这一路到此为止（热身那一页就被拦 / 要同意 / 这一小时满了）。
   */
  async function warmUp(
    channel: SearchBrowserChannel,
    url: string,
    trace: SearchTraceStep[],
  ): Promise<StepOutcome | undefined> {
    if (warmed) return undefined
    // 同时进来好几条（品牌分析会并发搜）：等同一次热身，不各开一页
    if (warming !== undefined) return warming
    warming = warmOnce(channel, url, trace).finally(() => {
      warming = undefined
    })
    return warming
  }

  async function warmOnce(
    channel: SearchBrowserChannel,
    url: string,
    trace: SearchTraceStep[],
  ): Promise<StepOutcome | undefined> {
    const t0 = o.now()
    const st = await channel.status(o.workspace_id)
    if (st?.google_cookies === true) {
      warmed = true
      trace.push({ via: 'google_warmup', result: 'skipped', ms: 0, why: '已经有 Google 的 cookie' })
      return undefined
    }
    const got = await o.throttle.run(() =>
      channel.open({
        workspace_id: o.workspace_id,
        url: GOOGLE_HOME,
        kind: 'page',
        timeout_ms: ENGINE_TIMEOUT_MS,
        settle_ms: 1_500,
        max_chars: 2_000,
        no_read: true,
      }),
    )
    const step = (result: SearchStepResult, why?: string): void => {
      trace.push({
        via: 'google_warmup',
        result,
        ms: o.now() - t0,
        ...(why === undefined ? {} : { why }),
      })
    }
    if (got === undefined) {
      const why = `这一小时内置浏览器已经开了 ${o.throttle.maxPerHour} 页（上限）`
      step('skipped', why)
      return { note: `${why}，Google 这次没开`, result: 'skipped' }
    }
    warmed = true
    if (!got.ok) {
      // 首页没打开不拦着：照样去搜，搜索那一页自己会说清楚
      step(got.reason === 'timeout' ? 'timeout' : 'failed', got.message)
      return undefined
    }
    const block = blockOf(got)
    if (block === undefined || block.kind === 'interstitial' || block.kind === 'login') {
      step('ok')
      return undefined
    }
    const out = await onBlock('google', block, url)
    step(out.result, block.message)
    return out
  }

  /** 内置浏览器开一个搜索结果页。回：结果 / 一句为什么没用上 / 亮给人了。 */
  async function viaBrowser(
    e: 'google' | 'bing',
    query: string,
    locale: SearchLocale,
    trace: SearchTraceStep[],
  ): Promise<StepOutcome> {
    const channel = o.channel
    if (channel === undefined) return { result: 'skipped', why: '这里没有内置浏览器' }
    const p = await paused(e)
    if (p !== undefined)
      return {
        note: `${ENGINE_NAME[e]} 之前被人机验证拦过，暂停到 ${clock(p.until)}`,
        result: 'skipped',
      }
    const url = e === 'google' ? googleSearchUrl(query, locale) : bingSearchUrl(query, locale)
    if (e === 'google') {
      const stop = await warmUp(channel, url, trace)
      if (stop !== undefined) return stop
    }
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
        result: 'skipped',
      }
    if (!got.ok)
      return {
        note: `${ENGINE_NAME[e]} 这次没打开（${got.message}）`,
        result: got.reason === 'timeout' ? 'timeout' : 'failed',
      }
    const block = blockOf(got)
    if (block !== undefined) return { ...(await onBlock(e, block, url)), why: block.message }
    const items = got.serp?.items ?? []
    const seen = got.serp?.candidates ?? 0
    return {
      sources: items,
      // WP454：0 条时分清「真没结果」和「页面上有结果标题、一条都没读出来」
      ...(items.length === 0 && seen > 0
        ? { why: `0 条结果（页面上有 ${seen} 个结果标题，一条都没读出来）` }
        : {}),
    }
  }

  /**
   * WP455（docs/110 §3.1 第 5–8 条）：通过插件在你自己的 Chrome 里搜一次 Google（只在内置浏览器 Google 没拿到结果时走）。
   * 只读：后台窗口打开结果页、读回 HTML、读完闲 30 秒自动关；不点、不填、不跑页面脚本。
   * 遇到人机验证 / `/sorry` / cookie 同意页：不亮给人、不点，这一路停到北京时间第二天零点。
   */
  async function viaOwnChrome(query: string, locale: SearchLocale): Promise<StepOutcome> {
    const oc = o.ownChrome
    const reader = oc?.reader()
    const serp = reader?.serp?.bind(reader)
    if (oc === undefined || serp === undefined)
      return { result: 'skipped', why: '没选「用你正在用的浏览器」，或插件还没装好' }
    if (oc.gate.pausedUntil() !== undefined)
      return { result: 'skipped', why: OWN_CHROME_PAUSED_WHY }
    const cap = oc.gate.throttle.maxPerHour
    if (oc.gate.throttle.usedThisHour() >= cap)
      return { result: 'skipped', why: `这一小时已经用你的 Chrome 搜了 ${cap} 次（上限）` }
    const url = googleSearchUrl(query, locale)
    let opened = false
    const got = await o.throttle.run(() =>
      oc.gate.throttle.run(() => {
        opened = true
        return serp(url, {
          // 110A 的判法：还是过渡页就再等（最多 8 秒，在读页那一侧）
          pending: (html, finalUrl) =>
            blockOf(openResultOfHtml(html, finalUrl))?.kind === 'interstitial',
        })
      }),
    )
    // 每个品牌第一次真的用了你的 Chrome：结果说明里说一句，之后不再说
    const tell = opened && state.own_chrome_told_at === undefined
    if (tell) {
      state.own_chrome_told_at = o.now()
      flush()
    }
    const told: Pick<StepOutcome, 'tell'> = tell ? { tell: true } : {}
    if (got === undefined)
      return {
        ...told,
        result: 'skipped',
        why: opened
          ? `这一小时已经用你的 Chrome 搜了 ${cap} 次（上限）`
          : `这一小时已经开了 ${o.throttle.maxPerHour} 页（上限）`,
      }
    if (!got.ok)
      return { ...told, note: `你的 Chrome 这次没搜成（${got.message}）`, result: got.reason }
    const page = openResultOfHtml(got.html, got.final_url)
    const block = blockOf(page)
    if (block?.kind === 'interstitial')
      return {
        ...told,
        note: '你的 Chrome 里 Google 没出结果（过渡页，等了 8 秒还没跳到结果页）',
        result: 'interstitial',
        why: block.message,
      }
    if (block !== undefined && block.kind !== 'login') {
      const until = oc.gate.pauseForToday()
      o.log?.(`web-search: 你的 Chrome 里 Google ${block.message}，这一路停到 ${clock(until)}`)
      return {
        ...told,
        note: `你的 Chrome 里 Google ${block.message}，这一路今天先不用了（不亮给你、不点）`,
        result: block.kind === 'consent' ? 'consent' : 'blocked',
        why: block.message,
      }
    }
    const items = page.serp.items
    const seen = page.serp.candidates ?? 0
    return {
      ...told,
      sources: items,
      ...(items.length === 0 && seen > 0
        ? { why: `0 条结果（页面上有 ${seen} 个结果标题，一条都没读出来）` }
        : {}),
    }
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

  /**
   * WP355：名单里那家模型自带的搜索。搜不成（没登录、出错、超时、到了每小时上限、模型没真的去搜）
   * 都只记一句，交给后面 WP353 的链接着搜——不让这一次失败。
   */
  async function viaNative(
    source: NativeSearchSource,
    who: SearchWho,
    query: string,
    maxResults: number,
    locale: SearchLocale,
  ): Promise<{
    sources?: SearchSource[]
    note?: string
    result?: SearchStepResult
    usage?: BrowserSearchResult['native_usage']
  }> {
    const label = NATIVE_SEARCH_LABEL[source]
    const port = o.native
    if (port === undefined) return { note: `${label} 在这里没接上` }
    const task = () =>
      port
        .search({
          source,
          ...(who.person_id === undefined ? {} : { person_id: who.person_id }),
          ...(who.model === undefined ? {} : { model: who.model }),
          query,
          maxResults,
          locale: {
            language: locale.language,
            ...(locale.market === undefined ? {} : { market: locale.market }),
          },
        })
        .then(
          (r) => ({ ok: true as const, r }),
          (e: unknown) => ({ ok: false as const, e }),
        )
    const got = o.nativeThrottle === undefined ? await task() : await o.nativeThrottle.run(task)
    if (got === undefined)
      return {
        note: `这一小时 ${label} 已经搜了 ${o.nativeThrottle?.maxPerHour ?? 0} 次（上限）`,
        result: 'skipped',
      }
    if (!got.ok) {
      const why = got.e instanceof Error ? got.e.message : String(got.e)
      o.log?.(`web-search: ${label} 没搜成：${why}`)
      return { note: `${label} 这次没搜成（${why.replace(/[。.]$/u, '')}）` }
    }
    const usage = got.r.usage
    return {
      sources: [...got.r.sources],
      ...(usage === undefined
        ? {}
        : { usage: { model: got.r.model ?? who.model ?? '', ...usage } }),
    }
  }

  const VIA_LINE: Record<Exclude<SearchVia, 'native'>, string> = {
    google: '这次的结果来自 Google（工坊内置浏览器）',
    own_chrome: '这次的结果来自 Google（你的 Chrome）',
    bing: '这次的结果来自 Bing（工坊内置浏览器）',
    cloud_google: '这次的结果来自云端 Google 搜索',
    public: '这次的结果来自公开搜索服务',
  }
  const viaLine = (via: SearchVia, native?: NativeSearchSource): string =>
    via === 'native'
      ? `这次的结果来自 ${NATIVE_SEARCH_LABEL[native ?? 'openai-codex']}（用你的订阅搜的）`
      : VIA_LINE[via]
  const viaName = (via: SearchVia, native?: NativeSearchSource): string =>
    via === 'native'
      ? NATIVE_SEARCH_LABEL[native ?? 'openai-codex']
      : via === 'public'
        ? '公开搜索服务'
        : via === 'cloud_google'
          ? '云端 Google'
          : via === 'own_chrome'
            ? 'Google（你的 Chrome）'
            : ENGINE_NAME[via]

  return {
    fetchHosts: o.channel === undefined ? [] : BROWSER_FETCH_HOSTS,
    available: () =>
      o.channel !== undefined ||
      o.cloud !== undefined ||
      o.keyless !== undefined ||
      o.ownChrome?.reader() !== undefined,

    async search(query, maxResults = 10, who = {}) {
      const locale = searchLocaleOf(o.profile(), query)
      const key = `${locale.language}|${locale.market ?? ''}|${query.trim().toLowerCase()}`
      const now = o.now()
      const hit = state.cache[key]
      // WP454：每一步留痕（只存查询哈希）
      const trace: SearchTraceStep[] = []
      const record = (via: SearchVia | undefined, cached = false): void => {
        const entry: SearchTraceEntry = {
          at: now,
          query_hash: createHash('sha256').update(key).digest('hex').slice(0, 16),
          ...(via === undefined ? {} : { via }),
          ...(cached ? { cached: true } : {}),
          ms: o.now() - now,
          steps: trace,
        }
        state.trace = [...(state.trace ?? []), entry].slice(-SEARCH_TRACE_MAX)
        const miss = trace.find((t) => t.via === 'google' && t.result !== 'ok')
        if (miss !== undefined)
          state.google_last_miss = {
            at: now,
            result: miss.result,
            ...(miss.why === undefined ? {} : { why: miss.why }),
          }
        flush()
      }
      if (hit !== undefined && hit.at > now - SEARCH_CACHE_TTL_MS) {
        record(hit.via, true)
        return {
          sources: hit.sources.slice(0, maxResults),
          content: `${viaLine(hit.via, hit.native)}（7 天内搜过同一句，用的是上次的结果）。`,
          truncated: false,
          via: hit.via,
          cached: true,
          ...(hit.native === undefined ? {} : { native_source: hit.native }),
          locale,
        }
      }
      const site = siteOf(query)
      const notes: string[] = []
      let handover = false
      // WP455：这一次第一次用了你的 Chrome（结果说明末尾加一句）
      let tellOwnChrome = false
      const told = (): string => (tellOwnChrome ? `${OWN_CHROME_TELL_LINE}。` : '')
      let anyLoaded = false
      let nativeUsage: BrowserSearchResult['native_usage']
      // WP355（决策 937）：名单里的模型来源先走它自带的搜索，不行再走 WP353 的链
      const native = nativeSearchSourceOf(who.source)
      const steps: [SearchVia, () => Promise<StepOutcome>][] = [
        ...(native === undefined
          ? []
          : [
              [
                'native',
                async () => {
                  const got = await viaNative(native, who, query, maxResults, locale)
                  nativeUsage = got.usage
                  return got
                },
              ] as [SearchVia, () => Promise<StepOutcome>],
            ]),
        ['google', () => viaBrowser('google', query, locale, trace)],
        // WP455：上一步没拿到结果（被拦、过渡页、超时、0 条、停着）才走到这里
        ['own_chrome', () => viaOwnChrome(query, locale)],
        ['bing', () => viaBrowser('bing', query, locale, trace)],
        ['cloud_google', () => viaCloud(query, locale)],
        ['public', () => viaPublic(query, maxResults)],
      ]
      for (const [via, step] of steps) {
        const t0 = o.now()
        const got = await step()
        const mark = (result: SearchStepResult, why?: string): void => {
          trace.push({ via, result, ms: o.now() - t0, ...(why === undefined ? {} : { why }) })
        }
        if (got.handover === true) handover = true
        if (got.tell === true) tellOwnChrome = true
        if (got.note !== undefined) notes.push(got.note)
        if (got.sources === undefined) {
          // 没给结果的那几路：有一句话 = 试了没成；一句都没有 = 没接这一路
          mark(
            got.result ?? (got.note === undefined ? 'skipped' : 'failed'),
            got.why ?? got.note ?? '没接这一路',
          )
          continue
        }
        anyLoaded = true
        // `site:` 限定：不在那个站上的不算（有的引擎会无视限定、回一堆无关站）
        const sources = (
          site === undefined ? got.sources : got.sources.filter((s) => onSite(s.url, site))
        )
          .filter((s) => /^https?:\/\//.test(s.url))
          .slice(0, maxResults)
        if (sources.length === 0) {
          mark(
            'empty',
            got.sources.length === 0
              ? (got.why ?? '0 条结果')
              : `${got.sources.length} 条都不在 ${site} 上`,
          )
          notes.push(`${viaName(via, native)} 没搜到相关结果`)
          continue
        }
        mark('ok')
        state.cache[key] = {
          at: o.now(),
          via,
          ...(via === 'native' && native !== undefined ? { native } : {}),
          sources,
        }
        const keys = Object.keys(state.cache)
        if (keys.length > CACHE_MAX) {
          for (const k of keys
            .sort((a, b) => (state.cache[a]?.at ?? 0) - (state.cache[b]?.at ?? 0))
            .slice(0, keys.length - CACHE_MAX))
            delete state.cache[k]
        }
        record(via)
        const before = notes.length === 0 ? '' : `前面没用上的：${notes.join('；')}。`
        return {
          sources,
          content: `${viaLine(via, native)}。${before}${told()}`,
          truncated: false,
          via,
          ...(handover ? { handover: true } : {}),
          ...(via === 'native' && native !== undefined ? { native_source: native } : {}),
          ...(nativeUsage === undefined ? {} : { native_usage: nativeUsage }),
          locale,
        }
      }
      record(undefined)
      if (!anyLoaded && notes.length === 0)
        throw webError(
          'WEB_PROVIDER_UNAVAILABLE',
          '这里没有内置浏览器，也没接云端搜索，联网搜索用不了。',
        )
      if (!anyLoaded)
        throw webError('WEB_PROVIDER_ERROR', `这次没搜成：${notes.join('；')}。${told()}`)
      return {
        sources: [],
        content: `没搜到相关结果：${notes.join('；')}。${told()}`,
        truncated: false,
        ...(handover ? { handover: true } : {}),
        ...(nativeUsage === undefined ? {} : { native_usage: nativeUsage }),
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
