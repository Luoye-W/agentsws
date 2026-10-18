/**
 * WP411（#10 第 2 条、#13）：**按时间窗回补**——在你浏览器里（插件借品牌号会话只读、不扣积分）把一段时间补齐：
 * 外部关键词走全站搜帖子（按最新、读到起点就停），自家版块读新帖 + 新评论，重点版块读新帖。
 *
 * 回补前先说一句「要补 X 天，约 N 页，在你浏览器里读」，然后照做；补不了照实说原因和能做的，不许只回库里的 0 条。
 * 一件活最多 {@link REDDIT_READ_MAX_PARTS} 路，路多了拆成几件按顺序读（同一次巡查）。
 */
import {
  normalizeSubreddit,
  REDDIT_MAX_PAGES,
  REDDIT_READ_MAX_PARTS,
  type RedditReadRequest,
  type RedditSearchTime,
} from '@agentsws/browser-action'
import type { RedditBackfillPlan, RedditWatchSettings } from '@agentsws/contracts'
import { coveringTimeWindow } from '@agentsws/social-core'

/** 回补的读那几路都以这个开头（不动日常的「上次读到哪」、不动版块的钟）。 */
export const BACKFILL_PREFIX = 'bf:'
/** 最远补到多久以前（Reddit 的列表往回只给约 1000 条，再早的读不到）。 */
export const BACKFILL_MAX_DAYS = 90

const DAY_MS = 86_400_000

/** 用户给的时间（ISO 或本地日期 YYYY-MM-DD；`until` 的日期含那一天）→ 毫秒。认不出回 `undefined`。 */
export function parseWhen(raw: unknown, tzOffsetMinutes: number, end: boolean): number | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const s = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/u.test(s)) {
    const t = Date.parse(`${s}T00:00:00.000Z`) - tzOffsetMinutes * 60_000
    return Number.isFinite(t) ? t + (end ? DAY_MS - 1 : 0) : undefined
  }
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : undefined
}

/** 搜索词：短语加引号（整串搜）。 */
export const searchQuery = (k: string): string =>
  /\s/u.test(k.trim()) ? `"${k.trim()}"` : k.trim()

/** 关键词 → 读的那一路的键（键里带原词，交回时认出是哪个关键词）。 */
export const searchKey = (k: string): string => `${BACKFILL_PREFIX}search:${k.trim().slice(0, 60)}`

export interface BackfillParts {
  external: boolean
  own: boolean
  watch: boolean
}

/** 这一段要读哪几路（按顺序：关键词、自家、重点），每一路几页、人话标签。 */
export function backfillReads(
  s: RedditWatchSettings,
  window: { sinceMs: number; untilMs: number },
  nowMs: number,
  parts: BackfillParts = { external: true, own: true, watch: true },
): { reads: RedditReadRequest[]; labels: string[] } {
  const days = Math.max(1, Math.ceil((window.untilMs - window.sinceMs) / DAY_MS))
  const since_utc = Math.floor(window.sinceMs / 1000)
  const time: RedditSearchTime = coveringTimeWindow(window.sinceMs, nowMs)
  // 一周按两页算（每页 100 条），最多 5 页
  const pages = (perWeek: number): number =>
    Math.max(1, Math.min(REDDIT_MAX_PAGES, Math.ceil((days / 7) * perWeek)))
  const reads: RedditReadRequest[] = []
  const labels: string[] = []
  if (parts.external)
    for (const k of s.keywords) {
      reads.push({
        key: searchKey(k),
        kind: 'search',
        query: searchQuery(k),
        time,
        since_utc,
        max_pages: pages(2),
      })
      labels.push(`搜「${k}」`)
    }
  const sub = (raw: string): string | undefined => normalizeSubreddit(raw)
  if (parts.own)
    for (const raw of s.own_subreddits) {
      const name = sub(raw)
      if (name === undefined) continue
      const k = name.toLowerCase()
      reads.push({
        key: `${BACKFILL_PREFIX}sub_new:${k}`,
        kind: 'sub_new',
        subreddit: name,
        since_utc,
        max_pages: pages(2),
      })
      reads.push({
        key: `${BACKFILL_PREFIX}sub_comments:${k}`,
        kind: 'sub_comments',
        subreddit: name,
        since_utc,
        max_pages: REDDIT_MAX_PAGES,
      })
      labels.push(`r/${name} 新帖和评论`)
    }
  if (parts.watch)
    for (const raw of s.watch_subreddits ?? []) {
      const name = sub(raw)
      if (name === undefined) continue
      reads.push({
        key: `${BACKFILL_PREFIX}watch_new:${name.toLowerCase()}`,
        kind: 'sub_new',
        subreddit: name,
        since_utc,
        max_pages: pages(1),
      })
      labels.push(`r/${name} 新帖`)
    }
  return { reads, labels }
}

/** 一件活最多 12 路：拆成几件。 */
export function chunkReads(reads: readonly RedditReadRequest[]): RedditReadRequest[][] {
  const out: RedditReadRequest[][] = []
  for (let i = 0; i < reads.length; i += REDDIT_READ_MAX_PARTS)
    out.push(reads.slice(i, i + REDDIT_READ_MAX_PARTS))
  return out
}

const dayLabel = (ms: number, tz: number): string => {
  const d = new Date(ms + tz * 60_000)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}

/**
 * 回补计划（还没读）：能补就给那一句人话；补不了说原因与能做的。
 * `plugin` = 插件那一侧现在能不能读（不能就补不了：回补只在你浏览器里读）。
 */
export function backfillPlan(input: {
  settings: RedditWatchSettings
  sinceMs: number
  untilMs: number
  nowMs: number
  tzOffsetMinutes: number
  plugin: { ok: true } | { ok: false; why: string }
  parts?: BackfillParts
}): { plan: RedditBackfillPlan; requests: RedditReadRequest[] } {
  const no = (message: string, can: string) => ({
    plan: { ok: false as const, message, can },
    requests: [],
  })
  const { sinceMs, nowMs } = input
  const untilMs = Math.min(input.untilMs, nowMs)
  if (!(sinceMs < untilMs))
    return no('时间窗不对：起点要早于终点，也不能在将来。', '换一个时间窗再说一次。')
  if (nowMs - sinceMs > BACKFILL_MAX_DAYS * DAY_MS)
    return no(
      `补不了 ${BACKFILL_MAX_DAYS} 天以前的：Reddit 的列表往回只给最近约 1000 条，再早的读不到。`,
      `最多补最近 ${BACKFILL_MAX_DAYS} 天；更早的只能人在 Reddit 上手动搜。`,
    )
  if (!input.plugin.ok)
    return no(
      `补不了：${input.plugin.why}（回补要插件在你浏览器里借品牌号读）。`,
      '打开 Chrome、确认插件连着 Reddit 后再说一次；或者用 read_reddit 按条计积分搜关键词（每次只回最近几十条，补不全）。',
    )
  const { reads, labels } = backfillReads(input.settings, { sinceMs, untilMs }, nowMs, input.parts)
  if (reads.length === 0)
    return no('没有要补的：巡查里还没配关键词或版块。', '先把巡查设好（关键词、版块）。')
  const days = Math.max(1, Math.ceil((untilMs - sinceMs) / DAY_MS))
  const pages = reads.reduce((n, r) => n + r.max_pages, 0)
  const tz = input.tzOffsetMinutes
  const limits = [
    ...(input.parts?.external === false || input.settings.keywords.length === 0
      ? []
      : ['Reddit 的搜索只给帖子：评论里提到的搜不到（日常巡查的数据渠道那一路能补评论）。']),
    '每一路最多翻 5 页（每页 100 条），量特别大的版块可能补不全，补不全会照实说。',
  ]
  const plan: RedditBackfillPlan = {
    ok: true,
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    days,
    pages,
    reads: labels,
    via: 'browser',
    message: `要补 ${days} 天（${dayLabel(sinceMs, tz)}–${dayLabel(untilMs, tz)}），约 ${pages} 页，在你浏览器里读（插件借品牌号只读，不扣积分）。`,
    limits,
  }
  return { plan, requests: reads }
}
