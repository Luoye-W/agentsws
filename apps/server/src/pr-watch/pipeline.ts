/**
 * WP386（docs/103 U2）：**一条管道 + 每种来源一个进料口适配器**。
 *
 * 不管内容从哪来（Google Alerts 的 RSS、网站 RSS、Reddit 取数路由；以后的邮件提醒、云端接口、插件、网页比对），
 * 进来后都走同一段：拉取 → 「这条见过没有」→ 满 20 条全新就加拉 → 本地关键词过滤 → 交给提及库去重 / 判类 / 入库。
 * 哪个口被平台关掉，换一个适配器接上，管道不动。RSS 不写死在这里：feed 的那个适配器只是其中一种。
 */

import type { PrMentionInput } from '@agentsws/api'
import {
  GOOGLE_ALERTS_FEED_CAP,
  type Iso8601,
  MONITOR_BOOST_EVERY_HOURS,
  type MonitorGroup,
  type MonitorRunPart,
  type MonitorSource,
  type PrWatchStore,
} from '@agentsws/contracts'
import {
  type AlertsTransport,
  fetchFeed,
  keywordFilter,
  mentionKey,
  type RawMention,
} from '@agentsws/pr-core'

/** 一个进料口拉回来的那一份（失败照实说，不回空数组）。 */
export type IngressPull =
  | { ok: true; items: RawMention[]; label?: string }
  | { ok: false; message: string }

/** 管道里的一条源（监控源，或 Reddit 那一路这种不存成监控源的）。 */
export interface PipelineSource {
  id: string
  label: string
  group: MonitorGroup
  competitor?: string
  /** 本地按关键词过滤（普通 RSS 是整个站的新内容）；Google Alerts / Reddit 已经按词搜过，不再过滤。 */
  filter?: { keywords: readonly string[]; exclude: readonly string[] }
  /** 满 20 条全新就加拉（只有 Google Alerts：feed 只留最近约 20 条）。 */
  capped?: boolean
  every_hours?: number
  /** 拉成过没有（第一次拉回来全是新的不算「可能漏了」）。 */
  pulled_before?: boolean
}

/** 进料口适配器：只管「拉回来」，别的都在管道里。 */
export interface IngressAdapter {
  pull(source: PipelineSource): Promise<IngressPull>
}

/** feed 那一种（`google_alerts` 与 `rss` 共用；地址从监控源上取）。 */
export function feedAdapter(
  transport: AlertsTransport,
  urlOf: (source_id: string) => string | undefined,
): IngressAdapter {
  return {
    async pull(source) {
      const url = urlOf(source.id)
      if (url === undefined) return { ok: false, message: '这条源没有地址了。' }
      const got = await fetchFeed(transport, { url, name: `「${source.label}」` })
      return got.ok
        ? {
            ok: true,
            items: got.data.rows,
            ...(got.data.label === undefined ? {} : { label: got.data.label }),
          }
        : { ok: false, message: got.message }
    },
  }
}

/** Reddit 那一路取回来的一条（`read_reddit` 同一条取数路由的条目形状里用得上的几格）。 */
export interface RedditReadItem {
  url?: string
  title?: string
  text?: string
  body?: string
  author?: string
  created_at?: string
  subreddit?: string
  id?: string
}

/**
 * Reddit 那一路（决策 76、R10）：走接口中台 / 浏览器只读那条取数路由，不再碰 `oauth.reddit.com`。
 * 一条源 = 设置里的几个搜索词；每个词取最近一周最新的几条。
 */
export function redditAdapter(
  now: () => Iso8601,
  queries: () => readonly string[],
  search: (
    query: string,
  ) => Promise<{ ok: true; items: RedditReadItem[] } | { ok: false; message: string }>,
): IngressAdapter {
  return {
    async pull() {
      const items: RawMention[] = []
      const fails: string[] = []
      let any = false
      for (const q of queries()) {
        const got = await search(q).catch((e: unknown) => ({
          ok: false as const,
          message: e instanceof Error ? e.message : String(e),
        }))
        if (!got.ok) {
          fails.push(`「${q}」${got.message}`)
          continue
        }
        any = true
        for (const it of got.items) {
          const url = it.url ?? ''
          if (url === '') continue
          const title = it.title?.trim() ?? ''
          const text = (it.text ?? it.body ?? title).trim()
          const at = it.created_at === undefined ? Number.NaN : Date.parse(it.created_at)
          items.push({
            source: 'reddit',
            origin:
              it.subreddit === undefined ? 'reddit.com' : `r/${it.subreddit.replace(/^r\//u, '')}`,
            url,
            ...(title === '' ? {} : { title }),
            text,
            ...(it.author === undefined ? {} : { author: it.author }),
            published_at: Number.isNaN(at) ? now() : new Date(at).toISOString(),
            dedupe_key: mentionKey({ source: 'reddit', url, title }),
            ...(it.id === undefined ? {} : { guid: it.id }),
          })
        }
      }
      if (!any) return { ok: false, message: fails.join('；') || 'Reddit 没取到。' }
      return { ok: true, items }
    },
  }
}

/** 每条源「见过的条目」最多记多少（feed 只留最近约 20 条，留够几轮就行）。 */
const SEEN_KEPT = 400

/** 一条源拉一次、走完管道（不入库：入库交给提及库，回的是要入库的那几行）。 */
export async function runPipelineFor(input: {
  source: PipelineSource
  adapter: IngressAdapter
  store: Pick<PrWatchStore, 'kv' | 'setKv'>
}): Promise<{ part: MonitorRunPart; rows: PrMentionInput[]; boost: boolean; label?: string }> {
  const { source } = input
  const got = await input.adapter.pull(source)
  if (!got.ok)
    return {
      part: {
        source_id: source.id,
        label: source.label,
        status: 'failed',
        fetched: 0,
        fresh: 0,
        kept: 0,
        message: got.message,
      },
      rows: [],
      boost: false,
    }
  const seenKey = `seen:${source.id}`
  const seen = new Set(input.store.kv<string[]>(seenKey) ?? [])
  const keyOf = (r: RawMention): string => r.guid ?? r.dedupe_key
  const fresh = got.items.filter((r) => !seen.has(keyOf(r)))
  // 满 20 条全是上次之后的新条目 → 这条 feed 可能漏了，改成每 4 小时拉一次（R6）
  const boost =
    source.capped === true &&
    source.pulled_before === true &&
    got.items.length >= GOOGLE_ALERTS_FEED_CAP &&
    fresh.length === got.items.length &&
    (source.every_hours ?? 24) > MONITOR_BOOST_EVERY_HOURS
  const kept = fresh.filter((r) =>
    source.filter === undefined ? true : keywordFilter(r, source.filter).keep,
  )
  const nextSeen = [
    ...got.items.map(keyOf),
    ...[...seen].filter((k) => !got.items.some((r) => keyOf(r) === k)),
  ]
  input.store.setKv(seenKey, nextSeen.slice(0, SEEN_KEPT))
  const rows: PrMentionInput[] = kept.map((r) => ({
    source: r.source,
    origin: r.origin,
    url: r.url,
    ...(r.title === undefined ? {} : { title: r.title }),
    text: r.text === '' ? (r.title ?? r.url) : r.text,
    ...(r.author === undefined || r.author === '' ? {} : { author: r.author }),
    published_at: r.published_at,
    group: source.group,
    ...(source.competitor === undefined ? {} : { competitor: source.competitor }),
    source_id: source.id,
    ...(r.guid === undefined ? {} : { guid: r.guid }),
  }))
  return {
    part: {
      source_id: source.id,
      label: source.label,
      status: 'ok',
      fetched: got.items.length,
      fresh: fresh.length,
      kept: kept.length,
      ...(boost
        ? { message: `一次来了 ${got.items.length} 条、全是新的，可能漏了，改成每 4 小时拉一次` }
        : {}),
    },
    rows,
    boost,
    ...(got.label === undefined ? {} : { label: got.label }),
  }
}

/** 监控源 → 管道里的一条源。 */
export function pipelineSourceOf(s: MonitorSource): PipelineSource {
  return {
    id: s.id,
    label: s.label,
    group: s.group,
    ...(s.competitor === undefined ? {} : { competitor: s.competitor }),
    ...(s.kind === 'rss'
      ? { filter: { keywords: s.keywords ?? [], exclude: s.exclude ?? [] } }
      : {}),
    capped: s.kind === 'google_alerts',
    every_hours: s.every_hours,
    pulled_before: s.last_ok_at !== undefined,
  }
}
