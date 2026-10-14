/**
 * WP332：公关「在别人帖子下回评论」——找被回那条评论的链接（插件靠它打开那条评论、找到回复框）。
 *
 * 按顺序找，找到就停：
 * 1. 调用方给的（是这条评论的链接才算）；
 * 2. 来源里记着的：WP328 巡查条目（`url`；没有就用所在帖子拼一个）→ 社群线程（`permalink`）→ 公关提及（`url`）；
 * 3. **出卡前补读一次**：知道所在的帖子（调用方给的是帖子链接，或巡查条目记着帖子）就读那个帖子的评论，
 *    按编号找到这一条（走 `read_reddit` 同一条只读取数路由）。
 *
 * 都找不到回 `{ ok: false, message }`（一句人话）——公关那一侧照实说、**不出能发的卡**。
 */
import type { CommunityThread, Mention, RedditWatchEntry } from '@agentsws/contracts'

export type RedditParentLink = { ok: true; permalink: string } | { ok: false; message: string }

export interface RedditParentLinkDeps {
  /** WP328 巡查库里这一条（任一来源）。 */
  watchEntries(fullname: string): readonly RedditWatchEntry[]
  /** 社群线程（Reddit 的）。 */
  threads(): readonly CommunityThread[]
  /** 公关提及。 */
  mentions(): readonly Pick<Mention, 'url'>[]
  /** 补读：读一个帖子下面的评论（不给 = 不补读）。 */
  readComments?(
    post_url: string,
  ): Promise<{ ok: true; items: { id?: string; url: string }[] } | { ok: false; message: string }>
}

/** 网址 → 站内路径（`https://www.reddit.com/r/x/comments/…?context=3` → `/r/x/comments/…/`）。 */
function sitePath(url: string | undefined): string | undefined {
  if (url === undefined || url.trim() === '') return undefined
  let path = url.trim()
  try {
    if (/^https?:/iu.test(path)) path = new URL(path).pathname
  } catch {
    return undefined
  }
  path = path.split(/[?#]/u)[0] ?? ''
  if (!/^\/r\/[^/]+\/comments\/[^/]+\//u.test(`${path}/`)) return undefined
  return path.endsWith('/') ? path : `${path}/`
}

/** `/r/x/comments/<帖子>/<slug>/<评论>/` 里的评论编号（是帖子链接回 undefined）。 */
const commentIdOf = (path: string): string | undefined =>
  path.match(/^\/r\/[^/]+\/comments\/[^/]+\/[^/]*\/([a-z0-9]+)\/$/iu)?.[1]?.toLowerCase()

/** 帖子那一段：`/r/x/comments/<帖子>/`。 */
const postPathOf = (path: string): string | undefined =>
  path.match(/^(\/r\/[^/]+\/comments\/[^/]+\/)/u)?.[1]

const bare = (fullname: string): string => fullname.replace(/^t\d_/u, '').toLowerCase()

export function redditParentLinker(deps: RedditParentLinkDeps) {
  return async (input: {
    fullname: string
    venue: string
    permalink?: string
  }): Promise<RedditParentLink> => {
    const id = bare(input.fullname)
    const isThis = (path: string | undefined): path is string =>
      path !== undefined && commentIdOf(path) === id
    const given = sitePath(input.permalink)
    if (isThis(given)) return { ok: true, permalink: given }

    // 来源里记着的
    let postPath = given === undefined ? undefined : postPathOf(given)
    for (const e of deps.watchEntries(input.fullname)) {
      const p = sitePath(e.url)
      if (isThis(p)) return { ok: true, permalink: p }
      const sub = (e.subreddit ?? input.venue).replace(/^\/?r\//u, '').trim()
      if (postPath === undefined && e.link_fullname !== undefined && sub !== '')
        postPath = `/r/${sub}/comments/${bare(e.link_fullname)}/`
    }
    for (const t of deps.threads()) {
      if (t.channel !== 'reddit' || bare(t.external_id) !== id) continue
      const p = sitePath(t.permalink)
      if (isThis(p)) return { ok: true, permalink: p }
    }
    for (const m of deps.mentions()) {
      const p = sitePath(m.url)
      if (isThis(p)) return { ok: true, permalink: p }
    }

    // 出卡前补读一次：读所在帖子的评论、按编号找
    if (postPath === undefined)
      return {
        ok: false,
        message: '巡查、社群线程、提及里都没有这条评论的链接，也不知道它在哪个帖子下',
      }
    if (deps.readComments === undefined)
      return { ok: false, message: '这台电脑上读不了 Reddit，没法补读那个帖子' }
    const got = await deps.readComments(`https://www.reddit.com${postPath}`)
    if (!got.ok) return { ok: false, message: `补读那个帖子没读成：${got.message}` }
    for (const item of got.items) {
      const p = sitePath(item.url)
      if (isThis(p)) return { ok: true, permalink: p }
      if (item.id !== undefined && bare(item.id) === id && p !== undefined) {
        const post = postPathOf(p) ?? postPath
        return { ok: true, permalink: `${post}_/${id}/` }
      }
    }
    return { ok: false, message: '补读了那个帖子，没找到这条评论（可能被删了）' }
  }
}
