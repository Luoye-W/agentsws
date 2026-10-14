/**
 * WP328：读回来的一条 → 巡查条目（插件那一路 / 第三方数据渠道那一路各一个翻法）。
 */
import type { RedditListingItem } from '@agentsws/browser-action'
import type { Iso8601, RedditWatchItem, RedditWatchSource, WorkspaceId } from '@agentsws/contracts'
import type { RedditItem } from '@agentsws/social-core'

export interface IngestContext {
  workspace_id: WorkspaceId
  run_id: string
  now: Iso8601
  newId(prefix: string): string
}

const iso = (sec: number): Iso8601 => new Date(sec * 1000).toISOString()
const lower = (s: string | undefined): string =>
  (s ?? '').trim().replace(/^u\//iu, '').toLowerCase()

/** 插件读回来的一条。`brandUser` = 品牌号（是它发的记 `ours`）。 */
export function watchItemOf(
  raw: RedditListingItem,
  source: Exclude<RedditWatchSource, 'external'>,
  ctx: IngestContext,
  brandUser: string | undefined,
): RedditWatchItem {
  const item: RedditWatchItem = {
    id: ctx.newId('rw'),
    workspace_id: ctx.workspace_id,
    source,
    kind: raw.kind,
    fullname: raw.name,
    text: raw.text,
    created_at: iso(raw.created_utc),
    fetched_at: ctx.now,
    run_id: ctx.run_id,
    status: 'open',
  }
  if (raw.subreddit !== undefined) item.subreddit = raw.subreddit
  if (raw.author !== undefined) item.author = raw.author
  if (raw.title !== undefined) item.title = raw.title
  if (raw.url !== undefined) item.url = raw.url
  if (raw.parent_id !== undefined) item.parent_fullname = raw.parent_id
  if (raw.link_id !== undefined) item.link_fullname = raw.link_id
  if (raw.link_title !== undefined) item.post_title = raw.link_title
  if (raw.inbox_type !== undefined) item.inbox_type = raw.inbox_type
  if (raw.deleted === true) item.deleted = true
  if (brandUser !== undefined && raw.author !== undefined && lower(raw.author) === lower(brandUser))
    item.ours = true
  return item
}

const COMMENTS_PATH = /\/comments\/([a-z0-9]{3,12})(?:\/[^/]*\/([a-z0-9]{3,12}))?/iu

/** 第三方数据渠道那一条的全名（`t3_…` / `t1_…`）。认不出回 `undefined`（不记）。 */
export function externalFullname(r: RedditItem): string | undefined {
  const id = (r.id ?? '').trim()
  if (/^t[13]_[a-z0-9]+$/iu.test(id)) return id.toLowerCase()
  const m = COMMENTS_PATH.exec(r.url)
  if (r.kind === 'comment') {
    const cid = m?.[2] ?? (id === '' ? undefined : id)
    return cid === undefined ? undefined : `t1_${cid.toLowerCase()}`
  }
  const pid = id !== '' ? id : m?.[1]
  return pid === undefined ? undefined : `t3_${pid.toLowerCase()}`
}

/** 外部社区（关键词命中）的一条。 */
export function externalItemOf(
  r: RedditItem,
  keyword: string,
  ctx: IngestContext,
): RedditWatchItem | undefined {
  const fullname = externalFullname(r)
  if (fullname === undefined) return undefined
  const item: RedditWatchItem = {
    id: ctx.newId('rw'),
    workspace_id: ctx.workspace_id,
    source: 'external',
    kind: r.kind,
    fullname,
    text: r.text.slice(0, 4_000),
    url: r.url,
    keyword,
    created_at: r.created_at ?? ctx.now,
    fetched_at: ctx.now,
    run_id: ctx.run_id,
    status: 'open',
  }
  if (r.subreddit !== undefined) item.subreddit = r.subreddit
  if (r.author !== undefined) item.author = r.author
  if (r.title !== undefined) item.title = r.title.slice(0, 300)
  return item
}
