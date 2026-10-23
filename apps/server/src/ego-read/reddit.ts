/**
 * WP493（决策 1718）：**在 ego 里读 Reddit**——巡查 / 现读那件「只读活」（`RedditReadJob`）原样交给 ego 跑，
 * 读法与插件一模一样（`@agentsws/browser-action` 的 `runRedditRead`：先看登的是哪个号、只读白名单里的 `.json`、
 * 收件箱带 `mark=false`、被拦就停、两次请求之间固定隔 2 秒）。
 *
 * **怎么在 ego 里跑同一份读法**：`runRedditRead` 每读一个地址问一次 `fetch`。ego 每一趟是一个新进程、开一个新空间，
 * 不能一个地址起一趟；所以「先批量取、再回放」：
 *
 * 1. 第一趟把「看登的是哪个号」与每一路第一页的地址一起交给 ego（打开 `old.reddit.com`，借这一页的登录态逐个 GET，
 *    中间隔 2 秒；碰到 429 / 登录页就不往下取）；
 * 2. 拿取回来的那几份回放 `runRedditRead`——它要的第二页（翻页）不在手里就记下来，下一趟再取；
 * 3. 最多翻 {@link REDDIT_MAX_PAGES} 页，所以最多几趟就完；每一趟都把空间收掉。
 *
 * 回放时 `runRedditRead` 自己的间隔给 0（真正的间隔在 ego 那一侧）。
 *
 * {@link createEgoRedditPump}：ego 能用时，由它替插件去巡查那边领活（`next({ via: 'ego' })`）、读完交回（`result`）——
 * 巡查、起草、现读（`read_reddit` 第三路）那一整套不用改；插件这时只是备用（巡查那边不再把活发给插件）。
 */
import {
  REDDIT_MAX_PAGES,
  REDDIT_ME_URL,
  REDDIT_READ_GAP_MS,
  REDDIT_READ_ORIGIN,
  type RedditFetched,
  type RedditReadJob,
  type RedditReadJobResult,
  type RedditReadNextResponse,
  type RedditReadResultInput,
  redditReadUrl,
  runRedditRead,
} from '@agentsws/browser-action'
import type { EgoPageReader } from './reader.js'

/** 读不到时那一份（`runRedditRead` 会认成「不是数据」）。 */
const MISS_BODY = ''

export interface EgoRedditOptions {
  reader: Pick<EgoPageReader, 'fetch'>
  /** 测试：把 `https://old.reddit.com` 换成本机假站。 */
  origin?: string
  /** 两次 GET 之间隔多久（缺省 2 秒，与插件同一个数）。 */
  gapMs?: number
}

/** 插件的话术是「Chrome 里的 Reddit…」；ego 跑的那一份换成 ego。 */
const egoWords = (s: string): string => s.replace(/Chrome/gu, 'ego')

/** 在 ego 里跑一件 Reddit 只读活。ego 跑不起来回 `failed`（一路都没读）。 */
export async function egoRedditRead(
  job: RedditReadJob,
  options: EgoRedditOptions,
): Promise<RedditReadJobResult> {
  const origin = options.origin ?? REDDIT_READ_ORIGIN
  const toSite = (u: string): string =>
    u.startsWith(REDDIT_READ_ORIGIN) ? `${origin}${u.slice(REDDIT_READ_ORIGIN.length)}` : u
  const fromSite = (u: string): string =>
    u.startsWith(origin) ? `${REDDIT_READ_ORIGIN}${u.slice(origin.length)}` : u
  /** 同一个地址不同写法（`%2C` / `,`）认成一个。 */
  const k = (u: string): string => {
    try {
      return new URL(u).href
    } catch {
      return u
    }
  }
  const cache = new Map<string, RedditFetched>()
  let want = [REDDIT_ME_URL, ...job.reads.map((r) => redditReadUrl(r))]
  // 第一趟 + 每翻一页一趟 + 余量
  for (let pass = 0; pass < REDDIT_MAX_PAGES + 2; pass += 1) {
    const missing = [...new Set(want)].filter((u) => !cache.has(k(u)))
    if (missing.length > 0) {
      const got = await options.reader.fetch(toSite(REDDIT_ME_URL), missing.map(toSite), {
        gap_ms: options.gapMs ?? REDDIT_READ_GAP_MS,
        stop_on_wall: true,
      })
      if (!got.ok) return { outcome: 'failed', message: got.message, parts: [] }
      for (const r of got.responses) {
        cache.set(k(fromSite(r.url)), {
          status: r.status ?? 0,
          url: fromSite(r.final_url ?? r.url),
          content_type: r.content_type ?? '',
          body: r.body ?? MISS_BODY,
        })
      }
      // 被拦之后没取的那几个：这一趟不再取（回放会在被拦那一处停下）
      for (const u of missing) if (!cache.has(k(u))) cache.set(k(u), MISS)
    }
    const misses = new Set<string>()
    const res = await runRedditRead(job, {
      fetch: async (u) => {
        const hit = cache.get(k(u))
        if (hit !== undefined) return hit === MISS ? { ...MISS, url: u } : hit
        misses.add(u)
        throw new Error('later')
      },
      sleep: async () => undefined,
      stopped: () => false,
      gapMs: 0,
    })
    if (misses.size === 0)
      return {
        ...res,
        message: egoWords(res.message),
        parts: res.parts.map((p) =>
          p.message === undefined ? p : { ...p, message: egoWords(p.message) },
        ),
      }
    want = [...misses]
  }
  return { outcome: 'failed', message: 'ego 里翻页翻太多了，这次先停。', parts: [] }
}

/** 被拦之后没取的那几个（回放到这里时认成「不是数据」）。 */
const MISS: RedditFetched = { status: 0, url: '', content_type: '', body: MISS_BODY }

/** 巡查那边给 ego 用的两口（`RedditWatchAssembly` 的子集）。 */
export interface EgoRedditWatchPort {
  next(input: { connected: boolean; via?: 'ego' }): RedditReadNextResponse
  result(id: string, input: RedditReadResultInput): Promise<{ accepted: true } | undefined>
}

export interface EgoRedditPumpOptions {
  /** 这个品牌的巡查（没装回 `undefined`）。 */
  watch(): EgoRedditWatchPort | undefined
  /** ego 这会儿能不能用（选了 ego / 默认 ego + 探得到 + 没关）。 */
  ready(): boolean
  /** 读一件活（缺省 {@link egoRedditRead}；测试给假的）。 */
  run(job: RedditReadJob): Promise<RedditReadJobResult>
  /** 没活时多久再去问一次（缺省按巡查那边说的，最短 30 秒）。 */
  minPollMs?: number
  setTimer?(fn: () => void, ms: number): { cancel(): void }
  log?(message: string, fields?: Record<string, unknown>): void
}

export interface EgoRedditPump {
  /** 现在去问一次（有活就读；排进来新活时巡查那边调）。 */
  kick(): Promise<void>
  /** 正在读。 */
  busy(): boolean
  stop(): void
}

/**
 * ego 替插件领活：有活就在 ego 里读、读完交回；没活按巡查那边说的间隔再来问。
 * 一次只读一件；读的时候来的 `kick` 等这件读完再接着问。
 */
export function createEgoRedditPump(options: EgoRedditPumpOptions): EgoRedditPump {
  const minPoll = options.minPollMs ?? 30_000
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return { cancel: () => clearTimeout(t) }
    })
  let running = false
  let again = false
  let stopped = false
  let timer: { cancel(): void } | undefined

  const schedule = (ms: number): void => {
    timer?.cancel()
    if (stopped) return
    timer = setTimer(
      () => {
        void kick()
      },
      Math.max(minPoll, ms),
    )
  }

  const kick = async (): Promise<void> => {
    if (stopped) return
    if (running) {
      again = true
      return
    }
    const watch = options.watch()
    if (watch === undefined || !options.ready()) {
      schedule(minPoll)
      return
    }
    running = true
    try {
      for (;;) {
        again = false
        const got = watch.next({ connected: true, via: 'ego' })
        if (got.job === undefined) {
          schedule(got.retry_after_ms)
          break
        }
        let res: RedditReadJobResult
        try {
          res = await options.run(got.job)
        } catch (e) {
          res = {
            outcome: 'failed',
            message: e instanceof Error ? e.message : String(e),
            parts: [],
          }
        }
        await watch.result(got.job.id, res).catch(() => undefined)
        options.log?.('ego 读了一件 Reddit 活', {
          job_id: got.job.id,
          outcome: res.outcome,
          parts: res.parts.length,
        })
        if (!options.ready() || stopped) break
      }
    } finally {
      running = false
    }
    if (again) await kick()
  }

  return {
    kick,
    busy: () => running,
    stop() {
      stopped = true
      timer?.cancel()
    },
  }
}
