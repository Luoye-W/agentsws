/**
 * `pr.monitoring`（信息监控）的 feed 进料口（60 §2 `channels/alerts.ts`；WP386 改用 feedsmith、放开任意 RSS）。
 *
 * | 口 | 拿什么 |
 * |---|---|
 * | {@link fetchGoogleAlerts} | 一条 Google Alerts 的 RSS（feed 本身已经按查询语句筛过） |
 * | {@link fetchFeed} | 任意 RSS / Atom / RDF / JSON Feed（某个网站的全部新内容，调用方按关键词在本地过滤） |
 *
 * Reddit 不在这里：它走 `read_reddit` 同一条取数路由（接口中台 / 浏览器只读，决策 76、R10），由服务进程那一侧接；
 * 原来对 `oauth.reddit.com/search` 的那段（从没被调用过）WP386 删了——Reddit 11-13 停 RSS、2027-03 关公共 API。
 *
 * 四条纪律：
 *
 * 1. **`fetch` 注入**（同 `social-core/channels/types.ts` 第 1 条）。测试里塞一个假 fetch 就能把
 *    "feed 404 怎么说""不是 feed 怎么说"测掉，不联网。
 * 2. **解析交给 feedsmith**（MIT，本机和 Workers 都能跑；docs/103 §2 查过 dsh 官方 / 社区没有合适的）。
 *    原来的正则只认 Google Alerts 那一种 Atom；换成它之后 RSS 2.0、Atom、RDF、JSON Feed 都认。
 * 3. **拿不到就说拿不到**（36 §3）。没地址、404、不是 feed，一律回 `{ ok: false, reason, message }`，
 *    `message` 是给人看的一句话。**绝不回一个空数组假装"今天没人提我们"**。
 * 4. **正文原样带回**。只把标签剥掉、把实体解开，一个字不改写（外部文本，21 §1）。
 */

import { GOOGLE_ALERTS_FEED_PREFIX, type Iso8601, type MentionSource } from '@agentsws/contracts'
import type { SocialResult, SocialTransport } from '@agentsws/social-core'
import { parseFeed } from 'feedsmith'
import { mentionKey } from '../monitor.js'

export { GOOGLE_ALERTS_FEED_PREFIX }

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
  /** WP386：feed 里这一条的 guid / id（有就带上；去重与「这条见过没有」用它）。 */
  guid?: string
}

/** 这个地址像不像一条 Google Alerts 的 feed（连接卡 / 配置卡的校验读它）。 */
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

/**
 * Google Alerts 的 feed 标题里带着它盯的词：`Google Alert - Super73` → `Super73`
 * （中文界面是「Google 快讯 - …」）。别的 feed 回原标题；没有标题回 `undefined`。
 */
export function feedLabelOf(title: string | undefined): string | undefined {
  if (title === undefined) return undefined
  const t = stripHtml(title)
  if (t === '') return undefined
  const m = /^(?:google\s*alerts?|google\s*快讯|google\s*快訊)\s*[-–—:：]\s*(.+)$/iu.exec(t)
  const raw = (m?.[1] ?? t).trim()
  // 整个被一对引号包着才去掉（`"Super73"` → `Super73`）；查询语句里的引号原样留
  const label = /^["“][^"“”]+["”]$/u.test(raw) ? raw.slice(1, -1).trim() : raw
  return label === '' ? undefined : label
}

/* ── 解析（feedsmith）──────────────────────────────────────────────── */

/** 一份 feed 解出来的样子（四种格式归一）。 */
export interface ParsedFeed {
  format: 'rss' | 'atom' | 'rdf' | 'json'
  /** feed 自己的标题（原样，去过标签）。 */
  title?: string
  /** 人话名：Google Alerts 拆出来的那个词，别的 feed 就是它的标题（{@link feedLabelOf}）。 */
  label?: string
  rows: RawMention[]
}

type Loose = Record<string, unknown>
const obj = (v: unknown): Loose | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : undefined
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
/** feedsmith 有的格子是字符串，有的是 `{ value }`（Atom 的 text construct、RSS 的 guid）。 */
const textOf = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v
  const val = obj(v)?.value
  return typeof val === 'string' ? val : undefined
}

interface LooseItem {
  link?: string
  guid?: string
  title?: string
  text?: string
  author?: string
  date?: string
}

function atomItem(e: Loose): LooseItem {
  const links = list(e.links)
    .map(obj)
    .filter((l): l is Loose => l !== undefined)
  const alt = links.find((l) => l.rel === undefined || l.rel === 'alternate') ?? links[0]
  const author = list(e.authors).map(obj)[0]?.name
  return {
    ...(typeof alt?.href === 'string' ? { link: alt.href } : {}),
    ...(typeof e.id === 'string' ? { guid: e.id } : {}),
    ...(textOf(e.title) === undefined ? {} : { title: textOf(e.title) as string }),
    ...((textOf(e.content) ?? textOf(e.summary)) === undefined
      ? {}
      : { text: (textOf(e.content) ?? textOf(e.summary)) as string }),
    ...(typeof author === 'string' && author.trim() !== '' ? { author } : {}),
    ...(typeof (e.published ?? e.updated) === 'string'
      ? { date: (e.published ?? e.updated) as string }
      : {}),
  }
}

function rssItem(i: Loose): LooseItem {
  const dc = obj(i.dc)
  const content = obj(i.content)
  const creator = list(dc?.creators)[0] ?? dc?.creator
  const author = list(i.authors)[0] ?? creator
  const date = i.pubDate ?? dc?.date ?? list(dc?.dates)[0]
  const text = textOf(content?.encoded) ?? textOf(i.description)
  return {
    ...(typeof i.link === 'string' ? { link: i.link } : {}),
    ...(textOf(i.guid) === undefined ? {} : { guid: textOf(i.guid) as string }),
    ...(textOf(i.title) === undefined ? {} : { title: textOf(i.title) as string }),
    ...(text === undefined ? {} : { text }),
    ...(typeof author === 'string' && author.trim() !== '' ? { author } : {}),
    ...(typeof date === 'string' ? { date } : {}),
  }
}

function jsonItem(i: Loose): LooseItem {
  const link = i.url ?? i.external_url
  const author = obj(list(i.authors)[0])?.name ?? obj(i.author)?.name
  const text = i.content_text ?? i.summary ?? i.content_html
  const date = i.date_published ?? i.date_modified
  return {
    ...(typeof link === 'string' ? { link } : {}),
    ...(typeof i.id === 'string' ? { guid: i.id } : {}),
    ...(typeof i.title === 'string' ? { title: i.title } : {}),
    ...(typeof text === 'string' ? { text } : {}),
    ...(typeof author === 'string' && author.trim() !== '' ? { author } : {}),
    ...(typeof date === 'string' ? { date } : {}),
  }
}

/** 站点名 → 来源种类（Reddit / 博客 / 其余算新闻）。 */
function sourceOfHost(origin: string): MentionSource {
  return /(^|\.)reddit\.com$/.test(origin)
    ? 'reddit'
    : /blog|medium\.com$|substack\.com$/.test(origin)
      ? 'blog'
      : 'news'
}

/**
 * 一份 feed 文本 → 归一的条目。**不是 feed 回 `undefined`**（网页、登录页、空串）——调用方照实说，
 * 不当成 0 条。缺链接或标题正文全空的条目丢掉；拿不到发布时间就用 `now`（我们看到它的时刻）。
 */
export function parseFeedDoc(text: string, now: Iso8601): ParsedFeed | undefined {
  let parsed: { format: string; feed: unknown }
  try {
    parsed = parseFeed(text) as { format: string; feed: unknown }
  } catch {
    return undefined
  }
  const feed = obj(parsed.feed) ?? {}
  const format = parsed.format as ParsedFeed['format']
  const raw: LooseItem[] =
    format === 'atom'
      ? list(feed.entries)
          .map(obj)
          .filter((e): e is Loose => e !== undefined)
          .map(atomItem)
      : format === 'json'
        ? list(feed.items)
            .map(obj)
            .filter((e): e is Loose => e !== undefined)
            .map(jsonItem)
        : list(feed.items)
            .map(obj)
            .filter((e): e is Loose => e !== undefined)
            .map(rssItem)
  const rows: RawMention[] = []
  for (const it of raw) {
    if (it.link === undefined || it.link.trim() === '') continue
    const url = unwrapAlertLink(stripHtml(it.link))
    const title = stripHtml(it.title ?? '')
    const body = stripHtml(it.text ?? '')
    if (title === '' && body === '') continue
    let origin = ''
    try {
      origin = new URL(url).hostname
    } catch {
      origin = 'unknown'
    }
    const at = it.date === undefined ? Number.NaN : Date.parse(stripHtml(it.date))
    const source = sourceOfHost(origin)
    const guid = it.guid?.trim()
    rows.push({
      source,
      origin,
      url,
      ...(title === '' ? {} : { title }),
      text: body,
      ...(it.author === undefined ? {} : { author: stripHtml(it.author) }),
      published_at: Number.isNaN(at) ? now : new Date(at).toISOString(),
      dedupe_key: mentionKey({ source, url, title, ...(guid ? { guid } : {}) }),
      ...(guid ? { guid } : {}),
    })
  }
  const title = textOf(feed.title)
  const clean = title === undefined ? undefined : stripHtml(title)
  const label = feedLabelOf(clean)
  return {
    format,
    ...(clean === undefined || clean === '' ? {} : { title: clean }),
    ...(label === undefined ? {} : { label }),
    rows,
  }
}

/** 一条 Google Alerts（或任意）feed → 一批提及（原来那个口子，形状不变）。 */
export function parseAlertsFeed(xml: string, now: Iso8601): RawMention[] {
  return parseFeedDoc(xml, now)?.rows ?? []
}

/* ── 拉取 ─────────────────────────────────────────────────────────── */

export interface AlertsTransport {
  /** 一跳 HTTP（结构上与 `globalThis.fetch` 相容；由宿主注入）。 */
  fetch: SocialTransport['fetch']
  now(): Iso8601
}

const ACCEPT =
  'application/atom+xml, application/rss+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5'

/** 贴进来的不是 RSS 时那一句（Google Alerts 默认是邮箱投递，最常见的就是这个）。 */
export const EMAIL_DELIVERY_HINT =
  '这条还是邮箱投递，去 Google Alerts 把投递方式改成 RSS，再把 RSS 链接贴过来。'

/**
 * 拉一条 feed（Google Alerts 或任意网站的 RSS / Atom）。
 *
 * 地址是**这个品牌自己的**（监控源那一行），由调用方递进来——这个函数不认识库。
 * `name` 是失败那句话里的主语（「Google Alerts」/ 网站名）。
 */
export async function fetchFeed(
  transport: AlertsTransport,
  input: { url: string; name?: string },
): Promise<SocialResult<ParsedFeed>> {
  const url = input.url.trim()
  const google = isGoogleAlertsFeed(url)
  const who = input.name ?? (google ? LABEL : '这个网站')
  if (url === '')
    return {
      ok: false,
      reason: 'not_connected',
      message: `${who} 还没有 feed 地址，所以这一块没有数。`,
    }
  let res: Awaited<ReturnType<AlertsTransport['fetch']>>
  try {
    res = await transport.fetch(url, { headers: { accept: ACCEPT } })
  } catch (e) {
    return {
      ok: false,
      reason: 'upstream_error',
      message: `${who} 那边没给回数据：${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`,
    }
  }
  if (!res.ok)
    return {
      ok: false,
      reason: res.status === 404 ? 'not_connected' : 'upstream_error',
      status: res.status,
      message:
        res.status === 404
          ? google
            ? `${LABEL} 说这条 feed 不存在（404）。多半是那条提醒被删了或者地址抄错了一段——回 Google Alerts 重新复制一次。`
            : `${who} 的这个 feed 地址不存在了（404）。`
          : `${who} 回了 ${res.status}。这一轮没拉到，下一轮再试。`,
    }
  const parsed = parseFeedDoc(await res.text(), transport.now())
  if (parsed === undefined)
    return {
      ok: false,
      reason: 'upstream_error',
      message: google
        ? `${LABEL} 给回来的不是一条 feed（里面一个 entry 都没有）。这一轮不算"今天没人提我们"——那两件事必须分得开。`
        : `${who} 给回来的不是 RSS（像是网页或登录页）。这一轮不算"没有新内容"。`,
    }
  return { ok: true, observed_at: transport.now(), data: parsed }
}

/**
 * 拉一条 Google Alerts feed（原来那个口子：只认 Google Alerts 的地址，回一批提及）。
 * 任意 RSS 走 {@link fetchFeed}。
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
      message: `${LABEL} 还没连上（没有 feed 地址），所以"外面有谁提我们"这一块没有数。把 Google Alerts 的 RSS 链接贴过来。`,
    }
  if (!isGoogleAlertsFeed(url))
    return {
      ok: false,
      reason: 'not_connected',
      message: `这不像一条 Google Alerts 的 RSS 地址（要以 ${GOOGLE_ALERTS_FEED_PREFIX} 开头）。在 Google Alerts 里把提醒的"投递方式"改成 RSS，再把那个地址复制过来。`,
    }
  const got = await fetchFeed(transport, { url, name: LABEL })
  return got.ok ? { ok: true, observed_at: got.observed_at, data: got.data.rows } : got
}

/** {@link probeFeedLink} 认出来的一条：哪一种、规整后的地址、拉回来的那一份。 */
export interface ProbedFeed extends ParsedFeed {
  kind: 'google_alerts' | 'rss'
  url: string
}

/**
 * 用户贴进来的一条链接：是不是能读的 feed（贴的时候当场拉一次，拉到了才算配好）。
 *
 * - `google.com/alerts/feeds/…` → Google Alerts 的 RSS；
 * - Google Alerts 的别的地址（提醒列表页、邮件里的「编辑提醒」链接）→ 当场说「这条还是邮箱投递」；
 * - 别的网址：拉一次，是 RSS / Atom 就收（任意网站的 feed）；不是就照实说，并带上那句提示。
 */
export async function probeFeedLink(
  transport: AlertsTransport,
  raw: string,
): Promise<SocialResult<ProbedFeed>> {
  const url = raw.trim()
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { ok: false, reason: 'not_connected', message: `这不是一个链接。${EMAIL_DELIVERY_HINT}` }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    return {
      ok: false,
      reason: 'not_connected',
      message: `这不是一个网页链接。${EMAIL_DELIVERY_HINT}`,
    }
  const google = isGoogleAlertsFeed(url)
  if (!google && /(^|\.)google\.[a-z.]+$/iu.test(u.hostname) && u.pathname.startsWith('/alerts'))
    return { ok: false, reason: 'not_connected', message: EMAIL_DELIVERY_HINT }
  const got = await fetchFeed(transport, {
    url,
    ...(google ? { name: LABEL } : { name: u.hostname }),
  })
  if (!got.ok)
    return got.reason === 'upstream_error' && got.status === undefined && !google
      ? { ...got, message: `这个链接不是能读的 RSS。${EMAIL_DELIVERY_HINT}` }
      : got
  return {
    ok: true,
    observed_at: got.observed_at,
    data: { ...got.data, kind: google ? 'google_alerts' : 'rss', url },
  }
}
