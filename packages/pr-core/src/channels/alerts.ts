/**
 * `pr.monitoring` 的两条进料口（60 §2 `channels/alerts.ts`）。
 *
 * | 口 | 拿什么 | 为什么是它 |
 * |---|---|---|
 * | {@link fetchGoogleAlerts} | 新闻、博客、评测 | Google Alerts 的 RSS 是**唯一**不用申请、不要钱、也不违反谁的条款的新闻监控入口 |
 * | {@link searchRedditMentions} | Reddit 上的讨论 | 品牌名在 Reddit 上被提到，多数时候不在我们自己的版里 |
 *
 * 四条纪律：
 *
 * 1. **`fetch` 注入**（同 `social-core/channels/types.ts` 第 1 条）。这个包
 *    没有网络依赖，测试里塞一个假 fetch 就能把"RSS 空了怎么说""404 怎么说"测掉。
 * 2. **RSS 自己解析，不拉 XML 库**。Google Alerts 的 feed 是很规整的 Atom，
 *    要的只有五个标签。为一个固定形状的 feed 拖进一个 XML 解析器，
 *    换来的是一条新的供应链依赖（16 §3）。
 * 3. **拿不到就说拿不到**（36 §3）。没配 feed 地址、feed 404、解析不出条目，
 *    一律回 `{ ok: false, reason, message }`，`message` 是给人看的一句话。
 *    **绝不回一个空数组假装"今天没人提我们"**——那是这条职责上最贵的一种谎。
 * 4. **正文原样带回**。Google Alerts 的摘要里带 `<b>` 高亮，这里只把标签剥掉、
 *    把实体解开，一个字不改写（外部文本，21 §1）。
 */

import type { Iso8601, MentionSource } from '@agentsws/contracts'
import type { SocialError, SocialResult, SocialTransport } from '@agentsws/social-core'
import { mentionKey } from '../monitor.js'

const LABEL = 'Google Alerts'

/** 拉回来的一条（还没判情绪、还没去重）。 */
export interface RawMention {
  source: MentionSource
  origin: string
  url: string
  title?: string
  text: string
  author?: string
  published_at: Iso8601
  dedupe_key: string
}

/* ── 一、Google Alerts（RSS）─────────────────────────────────────────── */

/** Google Alerts 的 feed 地址长这样（连接卡上那一格填的就是它）。 */
export const GOOGLE_ALERTS_FEED_PREFIX = 'https://www.google.com/alerts/feeds/'

/** 这个地址像不像一条 Google Alerts 的 feed（连接卡的表单校验读它）。 */
export function isGoogleAlertsFeed(url: string): boolean {
  return url.trim().startsWith(GOOGLE_ALERTS_FEED_PREFIX)
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

/**
 * 去标签 + 解实体。**不改写一个字**（文件头第 4 条）。
 *
 * 顺序是**先解实体再去标签**，不能反过来：Google Alerts 的 `<title type="html">`
 * 里装的是**转义过的** HTML（`&lt;b&gt;Nordvolt&lt;/b&gt;`）。先去标签的话
 * 那一层根本不是标签，解完实体之后 `<b>` 就原样留在标题里了。
 */
export function stripHtml(raw: string): string {
  const decoded = raw
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&(?!amp;)[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
  return decoded
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

const tag = (xml: string, name: string): string | undefined => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))
  return m?.[1]
}

/**
 * Google Alerts 把真实地址藏在 `google.com/url?...&url=<真地址>` 里。
 * 拆出来，拆不出就原样返回——**不猜**（猜错一个地址，人点过去到不了那篇文章）。
 */
export function unwrapAlertLink(href: string): string {
  try {
    const u = new URL(href)
    const inner = u.searchParams.get('url')
    return inner === null ? href : inner
  } catch {
    return href
  }
}

/** 一条 Atom `<entry>` → 一条提及；缺链接或缺时间的丢掉（**不补一个现在时刻**）。 */
export function parseAlertsFeed(xml: string, now: Iso8601): RawMention[] {
  const out: RawMention[] = []
  for (const m of xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const entry = m[1] ?? ''
    const hrefMatch = entry.match(/<link[^>]*href="([^"]+)"/i)
    const href = hrefMatch?.[1]
    if (href === undefined) continue
    const url = unwrapAlertLink(stripHtml(href))
    const published = tag(entry, 'published') ?? tag(entry, 'updated')
    const at = published === undefined ? Number.NaN : Date.parse(stripHtml(published))
    const title = stripHtml(tag(entry, 'title') ?? '')
    const text = stripHtml(tag(entry, 'content') ?? tag(entry, 'summary') ?? '')
    if (title === '' && text === '') continue
    let origin = ''
    try {
      origin = new URL(url).hostname
    } catch {
      origin = 'unknown'
    }
    const source: MentionSource = /(^|\.)reddit\.com$/.test(origin)
      ? 'reddit'
      : /blog|medium\.com$/.test(origin)
        ? 'blog'
        : 'news'
    out.push({
      source,
      origin,
      url,
      ...(title === '' ? {} : { title }),
      text,
      // 拿不到发布时间就用我们看到它的时刻，并且**如实记在 `observed_at` 那一侧**
      published_at: Number.isNaN(at) ? now : new Date(at).toISOString(),
      dedupe_key: mentionKey({ source, url, title }),
    })
  }
  return out
}

export interface AlertsTransport {
  /** 一跳 HTTP（结构上与 `globalThis.fetch` 相容；由宿主注入）。 */
  fetch: SocialTransport['fetch']
  now(): Iso8601
}

/**
 * 拉一条 Google Alerts feed。
 *
 * feed 地址是**这个品牌自己的**（连接卡 `google_alerts` 那一格），由调用方
 * 从加密库取出来递进来——这个函数不认识凭据库。
 */
export async function fetchGoogleAlerts(
  transport: AlertsTransport,
  input: { feed_url: string },
): Promise<SocialResult<RawMention[]>> {
  const url = input.feed_url.trim()
  if (url === '')
    return {
      ok: false,
      reason: 'not_connected',
      message: `${LABEL} 还没连上（没有 feed 地址），所以"外面有谁提我们"这一块没有数。去连接页把 Google Alerts 的 RSS 地址填上。`,
    }
  if (!isGoogleAlertsFeed(url))
    return {
      ok: false,
      reason: 'not_connected',
      message: `这不像一条 Google Alerts 的 RSS 地址（要以 ${GOOGLE_ALERTS_FEED_PREFIX} 开头）。在 Google Alerts 里把提醒的"投递方式"改成 RSS，再把那个地址复制过来。`,
    }
  let res: Awaited<ReturnType<AlertsTransport['fetch']>>
  try {
    res = await transport.fetch(url, { headers: { accept: 'application/atom+xml' } })
  } catch (e) {
    return {
      ok: false,
      reason: 'upstream_error',
      message: `${LABEL} 那边没给回数据：${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`,
    }
  }
  if (!res.ok)
    return {
      ok: false,
      reason: res.status === 404 ? 'not_connected' : 'upstream_error',
      status: res.status,
      message:
        res.status === 404
          ? `${LABEL} 说这条 feed 不存在（404）。多半是那条提醒被删了或者地址抄错了一段——回 Google Alerts 重新复制一次。`
          : `${LABEL} 回了 ${res.status}。这一轮没拉到，下一轮再试。`,
    }
  const xml = await res.text()
  const rows = parseAlertsFeed(xml, transport.now())
  if (rows.length === 0 && !/<entry[\s>]/i.test(xml))
    return {
      ok: false,
      reason: 'upstream_error',
      message: `${LABEL} 给回来的不是一条 Atom feed（里面一个 entry 都没有）。这一轮不算"今天没人提我们"——那两件事必须分得开。`,
    }
  return { ok: true, observed_at: transport.now(), data: rows }
}

/* ── 二、Reddit 搜索 ────────────────────────────────────────────────── */

const REDDIT_SEARCH_BASE = 'https://oauth.reddit.com/search'

interface RawRedditListing {
  data?: {
    children?: {
      data?: {
        name?: string
        title?: string
        selftext?: string
        author?: string
        subreddit?: string
        permalink?: string
        created_utc?: number
        num_comments?: number
      }
    }[]
  }
}

/**
 * 全站搜品牌名（**不是我们自己的版**——那是 `social.reddit` 的事）。
 *
 * 复用 `social-core` 的那把 transport（凭据、UA、限流全在那边），这里只多拼
 * 一个 `/search` 的 URL。
 */
export async function searchRedditMentions(
  transport: SocialTransport,
  input: { query: string; limit?: number },
): Promise<SocialResult<RawMention[]>> {
  if (!transport.connected('reddit'))
    return {
      ok: false,
      reason: 'not_connected',
      message: 'Reddit 还没连上，所以"Reddit 上有谁提我们"这一块没有数。去连接页把 Reddit 连上。',
    }
  const cred = await transport.credential('reddit')
  const url = `${REDDIT_SEARCH_BASE}?q=${encodeURIComponent(input.query)}&sort=new&limit=${Math.min(input.limit ?? 25, 100)}`
  let res: Awaited<ReturnType<SocialTransport['fetch']>>
  try {
    res = await transport.fetch(url, {
      headers: {
        authorization: `Bearer ${cred.access_token ?? cred.token ?? ''}`,
        'user-agent': cred.user_agent ?? 'agentsws/1.0 (品牌监控；https://github.com/agentsws)',
        accept: 'application/json',
      },
    })
  } catch (e) {
    return {
      ok: false,
      reason: 'upstream_error',
      message: `Reddit 那边没给回数据：${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`,
    }
  }
  if (!res.ok) return redditHttpFailure(res.status)
  let raw: RawRedditListing
  try {
    raw = JSON.parse(await res.text()) as RawRedditListing
  } catch (e) {
    return {
      ok: false,
      reason: 'upstream_error',
      message: `Reddit 给回来的不是 JSON：${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`,
    }
  }
  const now = transport.now()
  return {
    ok: true,
    observed_at: now,
    data: (raw.data?.children ?? []).map((c) => {
      const row = c.data ?? {}
      const url = `https://www.reddit.com${row.permalink ?? ''}`
      const title = row.title ?? ''
      return {
        source: 'reddit' as const,
        origin: `r/${row.subreddit ?? '?'}`,
        url,
        ...(title === '' ? {} : { title }),
        text: row.selftext ?? title,
        ...(row.author === undefined ? {} : { author: row.author }),
        published_at:
          row.created_utc === undefined ? now : new Date(row.created_utc * 1000).toISOString(),
        dedupe_key: mentionKey({ source: 'reddit', url, title }),
      }
    }),
  }
}

function redditHttpFailure(status: number): SocialError {
  if (status === 401 || status === 403)
    return {
      ok: false,
      reason: 'not_connected',
      status,
      message: `Reddit 拒绝了这次搜索（${status}）。多半是授权掉了，或者 User-Agent 写的不是它认的那个格式——去连接页重新授权一次。`,
    }
  if (status === 429)
    return {
      ok: false,
      reason: 'rate_limited',
      status,
      message: 'Reddit 说太快了（429）。等一会儿再搜；这一轮先跳过，不会丢。',
    }
  return { ok: false, reason: 'upstream_error', status, message: `Reddit 回了 ${status}。` }
}
