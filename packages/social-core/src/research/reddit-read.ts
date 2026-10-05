/**
 * WP220（Luoye 10-05）：**Reddit 取数路由**——两路，按顺序试，每次取数记一条来源。
 *
 * | 级 | 来源 | 这里怎么走 |
 * |---|---|---|
 * | `workshop` | 接口中台（`social.reddit.search` / `posts` / `comments`，积分） | 注入的 {@link RedditHubPort} |
 * | `browser_readonly` | 本机浏览器**只读**打开 Reddit 页面 | 注入的 {@link RedditReadBrowser} |
 *
 * 默认 ①→②，每个品牌可调顺序、可关某一路（设置 `data_source_routing['reddit.read']`）。
 * 某一路失败（没配 / 被关 / 云上没开通 / 报错 / 限速到了 / 会话不对）**自动试下一路**；
 * 两路都不行照实说，不编、不显示成「0 条」。
 *
 * 浏览器那一路的四道闸（Luoye 10-05 的护栏）：
 *
 * 1. **只读**：脚本描述 `writes: false`，执行器只拿回条目；发帖 / 回帖永远走品牌号 + 人批，不经这里。
 * 2. **单独的只读会话**：执行器要报自己的会话是哪种（{@link ReadBrowserSessionKind}），
 *    不是 `readonly_isolated` 一律拒用——**绝不用品牌发帖账号的会话**，也不用人自己的浏览器。
 * 3. **限速**：两页之间隔多久、一小时 / 一天最多几页，从设置来（默认保守），到了就不开，记 `rate_limited`。
 * 4. **白名单**：只开 `REDDIT_READ_HOSTS` 里的站。
 *
 * 这个文件不认识 dsh、不认识 Playwright，也不碰任何凭据；真执行器在服务进程那一侧装配，测试塞替身。
 */
import type {
  DataSourceRoute,
  Iso8601,
  RedditBrowserReadLimits,
  RedditReadCapability,
  ResearchFetchAttempt,
  ResearchFetchRecord,
  RunBrowser,
} from '@agentsws/contracts'
import { hostAllowed, REDDIT_READ_HOSTS } from '@agentsws/contracts'
import type { BrowserAction, BrowserRunResult } from '../channels/facebook-group.js'

/** 归一后的一条 Reddit 内容（帖子或评论）。正文是**外部文本**：进模型上下文前要围栏（21 §1）。 */
export interface RedditItem {
  kind: 'post' | 'comment'
  url: string
  id?: string
  title?: string
  text: string
  subreddit?: string
  author?: string
  created_at?: Iso8601
  /** 赞数（Reddit 的 score）。 */
  score?: number
  comments?: number
}

/** 接口中台那一路回来的样子（服务进程把 `/v1/data-service/call/*` 的回执翻成这个）。 */
export type RedditHubResult =
  | {
      ok: true
      items: readonly Record<string, unknown>[]
      cached: boolean
      credits: number
      fetched_at: Iso8601
    }
  /** `not_configured` = 没关联账号 / 云上这项能力还没开通（没价）；`failed` = 走了但没成。 */
  | { ok: false; reason: 'not_configured' | 'failed'; message: string }

export interface RedditHubPort {
  call(capability: RedditReadCapability, input: Record<string, unknown>): Promise<RedditHubResult>
}

/**
 * 浏览器会话是哪一种。只有 `readonly_isolated`（单独起的、不带任何登录态的只读会话）能用来取数。
 * `brand_posting` = 品牌发帖账号登录着的会话；`user_attached` = 接的是人自己的浏览器（可能登着品牌号）。
 */
export type ReadBrowserSessionKind = 'readonly_isolated' | 'brand_posting' | 'user_attached'

export interface RedditReadBrowser {
  session(): { kind: ReadBrowserSessionKind; id: string }
  /**
   * WP228：第二个参数是这次要几条、读的是哪一项（脚本描述里只有人话，真执行器要个数）。
   * `handover` = 被站点拦了（登录墙 / 验证码 / 429），这一路记 `blocked`。
   */
  run(action: BrowserAction, hint?: RedditReadHint): Promise<BrowserRunResult>
}

/** WP228：给执行器的提示（要几条、哪一项）。 */
export interface RedditReadHint {
  capability: RedditReadCapability
  limit: number
}

/**
 * WP228：限速器的形状（{@link createReadRateLimiter} 是内存版；服务进程给一本落盘的账，
 * 与连接页的「今天额度用完 / 被拦了」同一本）。`reason: 'blocked'` = 被站点拦了、暂停中。
 */
export interface RedditReadLimiter {
  check(
    nowMs: number,
  ): { ok: true } | { ok: false; message: string; reason?: 'interval' | 'hour' | 'day' | 'blocked' }
  take(nowMs: number): void
}

/**
 * 一次运行的浏览器配置 → 会话是哪一种。`launch`（新起一个无痕浏览器、不带任何 cookie）才算单独的只读会话；
 * `attach`（桌面壳另起的「工作用的浏览器」——论坛、群组发帖时人在里面登品牌号）与 BrowserSkill
 * （人日常用的浏览器）都可能登着品牌号，一律不算。
 */
export function readSessionKindOf(browser: RunBrowser): ReadBrowserSessionKind {
  return browser.mode === 'launch' ? 'readonly_isolated' : 'user_attached'
}

export interface RedditReadRequest {
  capability: RedditReadCapability
  /** 与能力目录里的输入白名单同名（`query` / `subreddit` / `time_window` / `sort` / `limit` / `post_url`）。 */
  input: Record<string, unknown>
}

export type RedditReadResult =
  | { ok: true; items: RedditItem[]; record: ResearchFetchRecord }
  | { ok: false; message: string; record: ResearchFetchRecord }

export interface RedditReadRouterOptions {
  /** 这个品牌的路由（顺序 + 被关掉的）。 */
  route(): DataSourceRoute
  /** 浏览器只读那一路的限速（设置里来，默认保守）。 */
  limits(): RedditBrowserReadLimits
  /** WP228：外面给的限速器（不给 = 内存版，按 `limits` 数）。 */
  limiter?: RedditReadLimiter
  hub?: RedditHubPort
  /** 只读浏览器；给函数就每次取数现问（服务进程那一侧可能晚建）。 */
  browser?: RedditReadBrowser | (() => RedditReadBrowser | undefined)
  /** 现在几点（毫秒），限速按它算。 */
  nowMs(): number
  /** 每取一次数记一条（审计 / 报告的出处都从这里来）。 */
  onRecord?(record: ResearchFetchRecord): void
}

/** 浏览器只读那一路的限速器：只记开过页面的时刻，不睡觉、不排队——到了就说到了。 */
export function createReadRateLimiter(limits: () => RedditBrowserReadLimits) {
  const opened: number[] = []
  return {
    /** 现在能不能再开一页；不能就说还要等多久。 */
    check(nowMs: number): { ok: true } | { ok: false; message: string } {
      const l = limits()
      const hourAgo = nowMs - 3_600_000
      const dayAgo = nowMs - 86_400_000
      while (opened.length > 0 && (opened[0] ?? 0) <= dayAgo) opened.shift()
      const last = opened[opened.length - 1]
      if (last !== undefined && nowMs - last < l.min_interval_seconds * 1000) {
        const wait = Math.ceil((l.min_interval_seconds * 1000 - (nowMs - last)) / 1000)
        return {
          ok: false,
          message: `浏览器只读取数要隔 ${l.min_interval_seconds} 秒开一页，还要等 ${wait} 秒。`,
        }
      }
      if (opened.filter((t) => t > hourAgo).length >= l.max_pages_per_hour)
        return {
          ok: false,
          message: `这一小时已经开了 ${l.max_pages_per_hour} 页（设置里的上限），过一会儿再取。`,
        }
      if (opened.length >= l.max_pages_per_day)
        return {
          ok: false,
          message: `今天已经开了 ${l.max_pages_per_day} 页（设置里的上限），明天再取。`,
        }
      return { ok: true }
    },
    take(nowMs: number): void {
      opened.push(nowMs)
    },
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** 把一条原始结果（接口中台或浏览器读回来的）翻成 {@link RedditItem}。没有地址的丢掉。 */
export function toRedditItem(
  raw: Record<string, unknown>,
  fallbackKind: RedditItem['kind'],
): RedditItem | undefined {
  const url = str(raw.url) ?? str(raw.permalink)
  if (url === undefined) return undefined
  const kind = raw.kind === 'comment' || raw.kind === 'post' ? raw.kind : fallbackKind
  const created =
    str(raw.created_at) ??
    (num(raw.created_utc) === undefined
      ? undefined
      : new Date((num(raw.created_utc) ?? 0) * 1000).toISOString())
  const out: RedditItem = {
    kind,
    url: url.startsWith('/') ? `https://www.reddit.com${url}` : url,
    text: str(raw.text) ?? str(raw.body) ?? str(raw.selftext) ?? '',
  }
  const id = str(raw.id)
  const title = str(raw.title)
  const subreddit = str(raw.subreddit)
  const author = str(raw.author)
  const score = num(raw.score) ?? num(raw.upvotes)
  const comments = num(raw.comments) ?? num(raw.num_comments)
  if (id !== undefined) out.id = id
  if (title !== undefined) out.title = title
  if (subreddit !== undefined) out.subreddit = subreddit.replace(/^\/?r\//iu, '')
  if (author !== undefined) out.author = author
  if (created !== undefined) out.created_at = created
  if (score !== undefined) out.score = score
  if (comments !== undefined) out.comments = comments
  return out
}

/** 浏览器只读那一路：这次要开哪一页、读什么。**只读**（`writes: false`）。 */
export function redditReadScript(req: RedditReadRequest): BrowserAction {
  const i = req.input
  const limit = Math.min(100, Math.max(1, num(i.limit) ?? 25))
  const t = str(i.time_window) ?? 'month'
  const sub = str(i.subreddit)?.replace(/^\/?r\//iu, '')
  const steps = [
    '只读：不点赞、不评论、不关注、不登录、不点任何会改东西的按钮',
    `往下滚到看见 ${limit} 条为止（滚不动了就有几条算几条）`,
  ]
  if (req.capability === 'social.reddit.comments') {
    return {
      url: str(i.post_url) ?? '',
      goal: `读这条帖子的正文与最多 ${limit} 条评论`,
      steps: [
        ...steps,
        '记下帖子标题、正文、版名、发帖时间、赞数；每条评论记下正文、作者、时间、赞数、链接',
      ],
      verify: '帖子本身读到了；评论有几条记几条，一条没有就说没有',
      writes: false,
    }
  }
  const q = encodeURIComponent(str(i.query) ?? '')
  const url =
    req.capability === 'social.reddit.posts'
      ? `https://www.reddit.com/r/${encodeURIComponent(sub ?? '')}/${str(i.sort) ?? 'new'}/?t=${t}`
      : sub === undefined
        ? `https://www.reddit.com/search/?q=${q}&t=${t}&sort=${str(i.sort) ?? 'relevance'}`
        : `https://www.reddit.com/r/${encodeURIComponent(sub)}/search/?q=${q}&restrict_sr=1&t=${t}&sort=${str(i.sort) ?? 'relevance'}`
  return {
    url,
    goal:
      req.capability === 'social.reddit.posts'
        ? `读 r/${sub ?? ''} 最近的帖子，最多 ${limit} 条`
        : `在 Reddit 上找与「${str(i.query) ?? ''}」有关的帖子，最多 ${limit} 条`,
    steps: [...steps, '每条记下：链接、标题、版名、作者、发帖时间、赞数、评论数；正文抄前两段就够'],
    verify: '每一条都有链接与标题；一条都没有就说「搜不到相关的」',
    writes: false,
  }
}

function urlHostAllowed(url: string): boolean {
  try {
    return hostAllowed(new URL(url).hostname, REDDIT_READ_HOSTS)
  } catch {
    return false
  }
}

/** 建一个 Reddit 取数路由。 */
export function createRedditReadRouter(options: RedditReadRouterOptions) {
  const limiter: RedditReadLimiter = options.limiter ?? createReadRateLimiter(options.limits)
  const fallbackKind = (c: RedditReadCapability): RedditItem['kind'] =>
    c === 'social.reddit.comments' ? 'comment' : 'post'
  const toItems = (
    rows: readonly Record<string, unknown>[],
    c: RedditReadCapability,
  ): RedditItem[] =>
    rows.flatMap((r) => {
      const item = toRedditItem(r, fallbackKind(c))
      return item === undefined ? [] : [item]
    })

  async function viaHub(req: RedditReadRequest) {
    if (options.hub === undefined)
      return {
        attempt: {
          route: 'workshop',
          outcome: 'not_configured',
          message: '这台机器没有接口中台（没关联账号）。',
        } as const,
      }
    const res = await options.hub.call(req.capability, req.input)
    if (!res.ok)
      return { attempt: { route: 'workshop', outcome: res.reason, message: res.message } as const }
    return {
      attempt: { route: 'workshop', outcome: 'ok' } as const,
      items: toItems(res.items, req.capability),
      cached: res.cached,
      credits: res.credits,
      fetched_at: res.fetched_at,
    }
  }

  async function viaBrowser(req: RedditReadRequest) {
    const browser = typeof options.browser === 'function' ? options.browser() : options.browser
    if (browser === undefined)
      return {
        attempt: {
          route: 'browser_readonly',
          outcome: 'not_configured',
          message: '这台机器没有可用的只读浏览器。',
        } as const,
      }
    const session = browser.session()
    if (session.kind !== 'readonly_isolated')
      return {
        attempt: {
          route: 'browser_readonly',
          outcome: 'session_refused',
          message:
            session.kind === 'brand_posting'
              ? '给的是品牌发帖账号的浏览器会话——取数绝不用它。要一个单独的只读会话。'
              : '给的是你自己的浏览器（可能登着品牌号）——取数要单独起一个只读会话。',
        },
      } as const
    const script = redditReadScript(req)
    if (!urlHostAllowed(script.url))
      return {
        attempt: {
          route: 'browser_readonly',
          outcome: 'failed',
          message: `这个地址不是 Reddit 的页面：${script.url}`,
        } as const,
      }
    const now = options.nowMs()
    const gate = limiter.check(now)
    if (!gate.ok)
      return {
        attempt: {
          route: 'browser_readonly',
          outcome: gate.reason === 'blocked' ? 'blocked' : 'rate_limited',
          message: gate.message,
        } as const,
      }
    limiter.take(now)
    const limit = Math.min(100, Math.max(1, num(req.input.limit) ?? 25))
    const res = await browser.run(script, { capability: req.capability, limit })
    if (res.status !== 'ok')
      return {
        attempt: {
          route: 'browser_readonly',
          outcome: res.status === 'handover' ? 'blocked' : 'failed',
          message: res.message,
        } as const,
      }
    return {
      attempt: { route: 'browser_readonly', outcome: 'ok' } as const,
      items: toItems(res.items ?? [], req.capability),
      cached: false,
      credits: 0,
      fetched_at: new Date(now).toISOString(),
    }
  }

  return {
    async read(req: RedditReadRequest): Promise<RedditReadResult> {
      const route = options.route()
      const attempts: ResearchFetchAttempt[] = []
      const seen = new Set<string>()
      for (const level of route.order) {
        if (level !== 'workshop' && level !== 'browser_readonly') continue
        if (seen.has(level)) continue
        seen.add(level)
        if (route.disabled.includes(level)) {
          attempts.push({ route: level, outcome: 'disabled', message: '这一路被这个品牌关掉了。' })
          continue
        }
        const got = level === 'workshop' ? await viaHub(req) : await viaBrowser(req)
        attempts.push(got.attempt)
        if ('items' in got && got.items !== undefined) {
          const record: ResearchFetchRecord = {
            platform: 'reddit',
            capability: req.capability,
            route: level,
            cached: got.cached,
            fetched_at: got.fetched_at,
            items: got.items.length,
            ...(level === 'workshop' ? { credits: got.credits } : {}),
            attempts,
          }
          options.onRecord?.(record)
          return { ok: true, items: got.items, record }
        }
      }
      const record: ResearchFetchRecord = {
        platform: 'reddit',
        capability: req.capability,
        route: 'none',
        cached: false,
        fetched_at: new Date(options.nowMs()).toISOString(),
        items: 0,
        attempts,
      }
      options.onRecord?.(record)
      const why = attempts.map((a) => a.message ?? a.outcome).join('；')
      return {
        ok: false,
        message: `Reddit 这一块没取到（${attempts.length === 0 ? '两路都没开' : why}）。这不等于没人在聊。`,
        record,
      }
    },
  }
}
