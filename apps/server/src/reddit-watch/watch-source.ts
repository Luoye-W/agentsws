/**
 * WP328 → WP331：把 Reddit 巡查库交成报告积木要的那一份（通用的 `WatchSource`，`apps/server/src/report-tools.ts`）。
 *
 * 条目形状是通用契约 `WatchItem`（`packages/contracts/src/report.ts`）；「查巡查数据」「立即巡查」两个工具经它读库。
 * WP330 时这里是专给 Reddit 周报的 `RedditWeekSource`，周五那次巡查由周报触发；WP331 起没有「周报」这个概念了，
 * 巡查照自己的每日节奏，要最新数据由 AI 在出报告前自己调「立即巡查」。
 *
 * 两点：
 * 1. 话题 `key` 跨天一致：由话题名规范化得来（AI 判的时候带着本周已有话题、能归就用原名）；
 * 2. `sweepNow` 有哪块没读成就抛一句人话（工具照实转告，报告照样用已入库的出）。
 */
import type { Iso8601, RedditWatchEntry, RedditWatchSettings, WatchItem } from '@agentsws/contracts'
import type { WatchSource } from '../report-tools.js'
import type { RedditWatchAssembly } from './service.js'
import { localMarks } from './terms.js'

/** 话题名 → 跨天稳定的键（大小写、空白、全半角标点不算不同）。 */
export function topicKey(label: string): string {
  return `t:${label
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')}`
}

const LIMIT = 5000

/** 一条巡查条目 → 通用的那一条（私信、没链接的、别人版块里回我们的不算）。 */
export function watchItemOfEntry(
  e: RedditWatchEntry,
  ownSubs: ReadonlySet<string>,
  /** WP340：按当前设置补算告警词 / 标签（后加的词对老条目也生效；不给就只用入库时标的）。 */
  terms?: Pick<RedditWatchSettings, 'alert_words' | 'tag_words'>,
): WatchItem | undefined {
  if (e.kind === 'message' || e.url === undefined || e.subreddit === undefined) return undefined
  const own = ownSubs.has(e.subreddit.toLowerCase())
  // 收件箱只认自家版块里的（别处回我们的不算外部关键词命中）；外部只认关键词命中的
  if (e.source === 'inbox' && !own) return undefined
  const scope = e.source === 'external' ? 'external' : 'own'
  const item: WatchItem = {
    id: e.fullname,
    platform: 'reddit',
    kind: e.kind,
    scope,
    place: e.subreddit,
    created_at: e.created_at,
    url: e.url,
    text: e.text,
  }
  if (e.author !== undefined) item.author = e.author
  const title = e.title ?? e.post_title
  if (title !== undefined) item.title = title
  if (e.deleted === true) item.deleted = true
  const j = e.judgement
  if (
    scope === 'own' &&
    j !== undefined &&
    e.ours !== true &&
    (j.voc !== undefined || j.ugc !== undefined)
  ) {
    const note = j.voc ?? j.ugc
    item.signals = {
      ...(j.voc === undefined ? {} : { voc: true }),
      ...(j.ugc === undefined ? {} : { ugc: true }),
      ...(note === undefined ? {} : { note }),
    }
  }
  // WP340：「优先」与本地标签（入库时标的 ∪ 按当前设置补算的）
  const now = terms === undefined || e.deleted === true ? undefined : localMarks(e, terms)
  if (e.ours !== true && (e.priority === true || (now?.alerts.length ?? 0) > 0))
    item.priority = true
  const tags = [...new Set([...(e.tags ?? []), ...(now?.tags ?? [])])]
  if (tags.length > 0) item.tags = tags
  if (scope === 'external') {
    const label =
      j?.topic ??
      (e.keyword !== undefined
        ? `关键词：${e.keyword}`
        : e.subreddit !== undefined
          ? `r/${e.subreddit}`
          : '其他')
    item.topic = { key: topicKey(label), label }
    if (j !== undefined) item.assessment = j.verdict
    if (e.keyword !== undefined) item.keyword = e.keyword
  }
  return item
}

export function redditWatchSourceOf(rw: RedditWatchAssembly): WatchSource {
  return {
    platform: 'reddit',
    configured: () => {
      const s = rw.settings()
      return (
        s.own_subreddits.length > 0 ||
        s.keywords.length > 0 ||
        (s.watch_subreddits ?? []).length > 0
      )
    },
    ownPlaces: () => rw.settings().own_subreddits,
    items: (w) => {
      const s = rw.settings()
      const own = new Set(s.own_subreddits.map((x) => x.toLowerCase()))
      const out = new Map<string, WatchItem>()
      // 自家版块那一路先放（同一条在收件箱里也有时以它为准）
      for (const source of ['own_sub', 'inbox', 'external'] as const)
        for (const e of rw.items({ source, since: w.since, until: w.until, limit: LIMIT })) {
          const it = watchItemOfEntry(e, own, s)
          if (it !== undefined && !out.has(it.id)) out.set(it.id, it)
        }
      return [...out.values()]
    },
    sweeps: (w) =>
      rw
        .runs({ since: w.since })
        .map((r) => r.finished_at)
        .filter((t): t is Iso8601 => t !== undefined && t >= w.since && t <= w.until),
    sweepNow: (o) => rw.sweepNow(o?.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
  }
}
