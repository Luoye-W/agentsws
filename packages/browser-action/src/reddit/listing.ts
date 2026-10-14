/**
 * WP328：Reddit `.json` 的解析与「被拦了没有」（插件与本机服务共用，纯函数）。
 *
 * 正文是**外部文本**：这里只截短、不解释；进模型上下文前由本机服务围栏（21 §1）。
 */

/** 收件箱里这一条是哪一栏。 */
export type RedditInboxType = 'comment_reply' | 'post_reply' | 'username_mention' | 'message'

/** 归一后的一条（帖子 / 评论 / 私信）。 */
export interface RedditListingItem {
  /** 全名：`t3_xxx` 帖子、`t1_xxx` 评论、`t4_xxx` 私信。 */
  name: string
  kind: 'post' | 'comment' | 'message'
  author?: string
  subreddit?: string
  /** 帖子标题 / 私信主题。 */
  title?: string
  /** 正文（截到 {@link REDDIT_TEXT_MAX} 字）。 */
  text: string
  /** `https://www.reddit.com/...` 永久链接。 */
  url?: string
  /** 回的是哪一条（评论 / 收件箱）。 */
  parent_id?: string
  /** 属于哪一帖（评论）。 */
  link_id?: string
  /** 评论所在那一帖的标题。 */
  link_title?: string
  /** 收件箱：哪一栏。 */
  inbox_type?: RedditInboxType
  created_utc: number
  score?: number
  num_comments?: number
  /** 原文已被删 / 被移除。 */
  deleted?: true
}

export const REDDIT_TEXT_MAX = 4_000

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

const DELETED = new Set(['[deleted]', '[removed]'])

function permalink(p: string | undefined): string | undefined {
  if (p === undefined) return undefined
  if (/^https?:\/\//u.test(p)) return p
  return p.startsWith('/') ? `https://www.reddit.com${p}` : undefined
}

function inboxType(d: Record<string, unknown>, kind: string): RedditInboxType | undefined {
  const t = str(d.type)
  if (t === 'comment_reply' || t === 'post_reply' || t === 'username_mention') return t
  return kind === 't4' ? 'message' : undefined
}

/** 一个 `{ kind, data }` → 一条；认不出（`more` 之类）回 `undefined`。 */
export function redditThingOf(thing: unknown, inbox = false): RedditListingItem | undefined {
  const t = rec(thing)
  const kind = str(t?.kind)
  const d = rec(t?.data)
  if (d === undefined || (kind !== 't1' && kind !== 't3' && kind !== 't4')) return undefined
  const name = str(d.name) ?? (str(d.id) === undefined ? undefined : `${kind}_${String(d.id)}`)
  const created = num(d.created_utc)
  if (name === undefined || created === undefined) return undefined
  const rawText = kind === 't3' ? (str(d.selftext) ?? '') : (str(d.body) ?? '')
  const author = str(d.author)
  const deleted = DELETED.has(rawText.trim()) || author === '[deleted]'
  const item: RedditListingItem = {
    name,
    kind: kind === 't3' ? 'post' : kind === 't1' ? 'comment' : 'message',
    text: deleted ? '' : rawText.slice(0, REDDIT_TEXT_MAX),
    created_utc: created,
  }
  if (author !== undefined && author !== '[deleted]') item.author = author
  const sub = str(d.subreddit)
  if (sub !== undefined) item.subreddit = sub
  const title = kind === 't3' ? str(d.title) : kind === 't4' ? str(d.subject) : undefined
  if (title !== undefined) item.title = title.slice(0, 300)
  const url = permalink(str(d.context) ?? str(d.permalink))
  if (url !== undefined) item.url = url
  const parent = str(d.parent_id)
  if (parent !== undefined) item.parent_id = parent
  const link = str(d.link_id)
  if (link !== undefined) item.link_id = link
  const linkTitle = str(d.link_title)
  if (linkTitle !== undefined) item.link_title = linkTitle.slice(0, 300)
  if (inbox) {
    const it = inboxType(d, kind)
    if (it !== undefined) item.inbox_type = it
  }
  const score = num(d.score)
  if (score !== undefined) item.score = score
  const nc = num(d.num_comments)
  if (nc !== undefined) item.num_comments = nc
  if (deleted) item.deleted = true
  return item
}

/** 一页：条目 + 下一页标记。认不出是 Listing 回 `undefined`。 */
export function parseRedditListing(
  json: unknown,
  inbox = false,
): { items: RedditListingItem[]; after?: string } | undefined {
  // 某帖评论：`[帖子那一页, 评论那一页]`，评论是树——平铺
  if (Array.isArray(json)) {
    const out: RedditListingItem[] = []
    for (const page of json) {
      const one = parseRedditListing(page, inbox)
      if (one === undefined) return undefined
      out.push(...one.items)
    }
    return { items: out }
  }
  const t = rec(json)
  const d = rec(t?.data)
  if (t?.kind !== 'Listing' || !Array.isArray(d?.children)) return undefined
  const items: RedditListingItem[] = []
  const walk = (children: unknown[]): void => {
    for (const c of children) {
      const item = redditThingOf(c, inbox)
      if (item !== undefined) items.push(item)
      const replies = rec(rec(rec(c)?.data)?.replies)
      const kids = rec(replies?.data)?.children
      if (Array.isArray(kids)) walk(kids)
    }
  }
  walk(d.children as unknown[])
  const after = str(d.after)
  return after === undefined ? { items } : { items, after }
}

/** `/api/me.json`：登着的号的用户名；没登录（空对象）回 `undefined`。 */
export function redditMeOf(json: unknown): string | undefined {
  const d = rec(rec(json)?.data)
  return str(d?.name)
}
