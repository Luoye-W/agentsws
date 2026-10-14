/**
 * WP328 → WP330：把巡查库交成周报要的那一份（WP330 的 `RedditWeekSource`，`apps/server/src/reddit-weekly.ts`）。
 *
 * 形状照 WP330 契约 `RedditWatchItem`（`packages/contracts/src/reddit-weekly.ts`）逐格写在这里（结构类型）；
 * WP330 合进 main 之后，`server.ts` 里 `options.redditWeekSource?.(ws) ?? …` 那一处兜底换成
 * `redditWeekSourceOf(brand.redditWatch)` 就接上了（见报告 §3）。
 *
 * 三点对齐：
 * 1. 周五那次巡查由周报调 `sweepNow` 触发（巡查这边不再单独排「周五 17:00 最后一次」）；
 * 2. 话题 `key` 跨天一致：由话题名规范化得来（AI 判的时候带着本周已有话题、能归就用原名）；
 * 3. 巡查失败不挡周报：`sweepNow` 有哪块没读成就抛一句人话，周报照样出、把原因带上。
 */
import type { Iso8601, RedditWatchEntry, RedditWatchVerdict } from '@agentsws/contracts'
import type { RedditWatchAssembly } from './service.js'

/** 与 WP330 `RedditWatchItem` 同形。 */
export interface RedditWeekItem {
  id: string
  kind: 'post' | 'comment'
  scope: 'own' | 'external'
  subreddit: string
  author?: string
  created_at: Iso8601
  permalink: string
  title?: string
  text: string
  deleted?: boolean
  signals?: { voc?: boolean; ugc?: boolean; note?: string }
  topic?: { key: string; label: string }
  assessment?: RedditWatchVerdict
  keyword?: string
}

type MaybePromise<T> = T | Promise<T>

/** 与 WP330 `RedditWeekSource` 同形。 */
export interface RedditWeekSourceLike {
  configured(): MaybePromise<boolean>
  subreddits(): MaybePromise<string[]>
  items(window: { since: Iso8601; until: Iso8601 }): MaybePromise<RedditWeekItem[]>
  sweeps(window: { since: Iso8601; until: Iso8601 }): MaybePromise<Iso8601[]>
  sweepNow?(): Promise<unknown>
}

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

/** 一条巡查条目 → 周报那一条（私信、没链接的、别人版块里回我们的不进周报）。 */
export function weekItemOf(
  e: RedditWatchEntry,
  ownSubs: ReadonlySet<string>,
): RedditWeekItem | undefined {
  if (e.kind === 'message' || e.url === undefined || e.subreddit === undefined) return undefined
  const own = ownSubs.has(e.subreddit.toLowerCase())
  // 收件箱只认自家版块里的（别处回我们的不算外部关键词命中）；外部只认关键词命中的
  if (e.source === 'inbox' && !own) return undefined
  const scope = e.source === 'external' ? 'external' : 'own'
  const item: RedditWeekItem = {
    id: e.fullname,
    kind: e.kind,
    scope,
    subreddit: e.subreddit,
    created_at: e.created_at,
    permalink: e.url,
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
  if (scope === 'external') {
    const label = j?.topic ?? (e.keyword === undefined ? '其他' : `关键词：${e.keyword}`)
    item.topic = { key: topicKey(label), label }
    if (j !== undefined) item.assessment = j.verdict
    if (e.keyword !== undefined) item.keyword = e.keyword
  }
  return item
}

export function redditWeekSourceOf(rw: RedditWatchAssembly): RedditWeekSourceLike {
  return {
    configured: () => {
      const s = rw.settings()
      return s.own_subreddits.length > 0 || s.keywords.length > 0
    },
    subreddits: () => rw.settings().own_subreddits,
    items: (w) => {
      const own = new Set(rw.settings().own_subreddits.map((x) => x.toLowerCase()))
      const out = new Map<string, RedditWeekItem>()
      // 自家版块那一路先放（同一条在收件箱里也有时以它为准）
      for (const source of ['own_sub', 'inbox', 'external'] as const)
        for (const e of rw.items({ source, since: w.since, until: w.until, limit: LIMIT })) {
          const it = weekItemOf(e, own)
          if (it !== undefined && !out.has(it.id)) out.set(it.id, it)
        }
      return [...out.values()]
    },
    sweeps: (w) =>
      rw
        .runs({ since: w.since })
        .map((r) => r.finished_at)
        .filter((t): t is Iso8601 => t !== undefined && t >= w.since && t <= w.until),
    sweepNow: () => rw.sweepNow(),
  }
}
