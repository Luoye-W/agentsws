/**
 * WP411（#11）：起草前读「整串」——原帖 + 上下文评论 + 品牌号在这串里已经说过的话。
 *
 * 两个来源合起来：
 * 1. 插件借品牌号会话现读的整串（`post_comments`，读回来的存成这一帖的快照）；
 * 2. 巡查库里已经有的（自家版块的评论流、品牌号自己发的、收件箱）。
 * 插件不在线 / 没读成时只用第 2 样，并在上下文里照实写一句（卡上标出来）。
 */
import type { RedditListingItem } from '@agentsws/browser-action'
import type {
  Iso8601,
  RedditThreadComment,
  RedditThreadContext,
  RedditWatchEntry,
} from '@agentsws/contracts'

/** 一帖的快照（kv `thread:<t3_…>`）。 */
export interface ThreadSnapshot {
  at: Iso8601
  items: RedditThreadComment[]
  post?: { fullname: string; title?: string; text: string; author?: string }
}

/** 快照多久算新（起草前读过、几小时内再起草同一串就不再读）。 */
export const THREAD_FRESH_MS = 6 * 3_600_000
/** 一串最多留几条进快照 / 上下文。 */
const SNAPSHOT_MAX = 150
const CONTEXT_MAX = 30
const TEXT_MAX = 1_200

const COMMENTS_PATH = /\/comments\/([a-z0-9]{3,12})/iu

/** 这一条属于哪一帖（`t3_…`）；认不出回 `undefined`。 */
export function linkOf(
  e: Pick<RedditWatchEntry, 'kind' | 'fullname' | 'link_fullname' | 'url'>,
): string | undefined {
  if (e.kind === 'post') return e.fullname.toLowerCase()
  if (e.link_fullname !== undefined && /^t3_/iu.test(e.link_fullname))
    return e.link_fullname.toLowerCase()
  const m = COMMENTS_PATH.exec(e.url ?? '')
  return m?.[1] === undefined ? undefined : `t3_${m[1].toLowerCase()}`
}

const iso = (sec: number): Iso8601 => new Date(sec * 1000).toISOString()

/** 插件读回来的整串 → 快照（截短、去掉被删的）。 */
export function snapshotOf(raw: readonly RedditListingItem[], at: Iso8601): ThreadSnapshot {
  const snap: ThreadSnapshot = { at, items: [] }
  for (const r of raw) {
    if (r.deleted === true) continue
    if (r.kind === 'post') {
      snap.post = {
        fullname: r.name.toLowerCase(),
        text: r.text.slice(0, TEXT_MAX),
        ...(r.title === undefined ? {} : { title: r.title }),
        ...(r.author === undefined ? {} : { author: r.author }),
      }
      continue
    }
    if (r.kind !== 'comment' || snap.items.length >= SNAPSHOT_MAX) continue
    snap.items.push({
      fullname: r.name.toLowerCase(),
      text: r.text.slice(0, TEXT_MAX),
      created_at: iso(r.created_utc),
      ...(r.author === undefined ? {} : { author: r.author }),
      ...(r.parent_id === undefined ? {} : { parent_fullname: r.parent_id.toLowerCase() }),
      ...(r.url === undefined ? {} : { url: r.url }),
    })
  }
  return snap
}

const lower = (s: string | undefined): string =>
  (s ?? '').trim().replace(/^u\//iu, '').toLowerCase()

/**
 * 合成这一条的整串上下文。`brandUser` = 品牌号（它发的进 `ours`）。
 * 上下文评论先放被回那一条往上的那一串（父、祖父…），再按时间补到 {@link CONTEXT_MAX} 条。
 */
export function threadContextOf(input: {
  item: RedditWatchEntry
  snapshot?: ThreadSnapshot
  /** 巡查库里同一帖的条目（任一来源）。 */
  stored: readonly RedditWatchEntry[]
  brandUser?: string
  nowMs: number
}): RedditThreadContext {
  const { item, snapshot } = input
  const brand = lower(input.brandUser)
  const fresh = snapshot !== undefined && input.nowMs - Date.parse(snapshot.at) < THREAD_FRESH_MS
  const all = new Map<string, RedditThreadComment & { ours: boolean }>()
  let post = fresh ? snapshot?.post : undefined
  for (const e of input.stored) {
    if (e.deleted === true || e.kind === 'message') continue
    const ours = e.ours === true || (brand !== '' && lower(e.author) === brand)
    if (e.kind === 'post') {
      post ??= {
        fullname: e.fullname,
        text: e.text.slice(0, TEXT_MAX),
        ...(e.title === undefined ? {} : { title: e.title }),
        ...(e.author === undefined ? {} : { author: e.author }),
      }
      if (ours && e.fullname !== item.fullname)
        all.set(e.fullname, { fullname: e.fullname, text: e.text, created_at: e.created_at, ours })
      continue
    }
    all.set(e.fullname.toLowerCase(), {
      fullname: e.fullname.toLowerCase(),
      text: e.text.slice(0, TEXT_MAX),
      created_at: e.created_at,
      ours,
      ...(e.author === undefined ? {} : { author: e.author }),
      ...(e.parent_fullname === undefined
        ? {}
        : { parent_fullname: e.parent_fullname.toLowerCase() }),
      ...(e.url === undefined ? {} : { url: e.url }),
    })
  }
  if (fresh)
    for (const c of snapshot?.items ?? [])
      all.set(c.fullname, { ...c, ours: brand !== '' && lower(c.author) === brand })
  const target = item.fullname.toLowerCase()
  const chain: string[] = []
  for (let at = all.get(target)?.parent_fullname; at !== undefined && !chain.includes(at); )
    if (all.has(at)) {
      chain.push(at)
      at = all.get(at)?.parent_fullname
    } else break
  const strip = ({
    ours: _o,
    ...c
  }: RedditThreadComment & { ours: boolean }): RedditThreadComment => c
  const others = [...all.values()].filter((c) => !c.ours && c.fullname !== target)
  const byTime = (a: RedditThreadComment, b: RedditThreadComment): number =>
    (a.created_at ?? '').localeCompare(b.created_at ?? '')
  const picked = [
    ...chain
      .map((k) => all.get(k))
      .filter((c): c is RedditThreadComment & { ours: boolean } => c !== undefined && !c.ours),
    ...others
      .filter((c) => !chain.includes(c.fullname))
      .sort(byTime)
      .reverse(),
  ].slice(0, CONTEXT_MAX)
  const ours = [...all.values()]
    .filter((c) => c.ours)
    .map(strip)
    .sort(byTime)
  return {
    ...(post === undefined || post.fullname === target ? {} : { post }),
    comments: picked.map(strip).sort(byTime),
    ours,
    read: fresh ? 'plugin' : 'store',
    ...(fresh ? {} : { note: '这一串没现读成，只看了巡查库里已有的几条。' }),
  }
}

/** 品牌号已经直接回过这一条了（它的某条回复的父级就是这一条）。 */
export function alreadyReplied(
  ctx: RedditThreadContext,
  fullname: string,
): RedditThreadComment | undefined {
  const k = fullname.toLowerCase()
  return ctx.ours.find((c) => (c.parent_fullname ?? '').toLowerCase() === k)
}
