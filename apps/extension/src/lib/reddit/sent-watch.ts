/**
 * WP467（Luoye 10-22）：**人自己发出去的，插件照样记**——
 *
 * 「等你发」里的每一条（还没批的卡、批过等你打开的、没发出去的），只要用户在**这个帖子**的原帖页上自己发了
 * （插件填好后点的、或者点「复制」自己粘贴的），插件在那一页上认出来：这个帖子里 + 文本相近 + 当前登录的号发的
 * + 草稿出来之后才发的，就回写成「已记录」。认不出就留给卡上「我发了，帮我记一下」（贴链接 / 认最近一条）。
 *
 * 只看、不点：插件在原帖页里只读页面上的评论（和填草稿同一个页面脚本），从不点发送。
 * 插件正在填、正在等你点发送的那一条（`queued` / `filling`）不在这里管——那边自己会认。
 */
import {
  checkRedditReadUrl,
  isNewRedditUrl,
  looksLikeSent,
  type PanelSnapshot,
  type PostedHit,
  parseRedditListing,
  type RedditFetched,
  redditPostIdOf,
  redditReadUrl,
  redditSentSelectors,
} from '@agentsws/browser-action'

/** 要盯的一条。 */
export interface WatchTarget {
  /** `w:<job>` / `c:<卡 id>`。 */
  key: string
  job?: string
  card?: { id: string; version: number }
  kind: 'reply' | 'comment'
  /** 帖子 id（不带 `t3_`）。 */
  post: string
  /** 回的那条评论（`t1_…`；回帖子没有）。 */
  parent?: string
  /** 草稿。 */
  text: string
  /** 草稿什么时候出来的（毫秒）：早于它发的不算。 */
  since_ms: number
}

/** 没发出去的那几条盯多久（之后人自己发的就靠「我发了，帮我记一下」）。 */
export const FAILED_WATCH_MS = 24 * 60 * 60 * 1000
/** 页面上的时间与本机时间可能差一点。 */
const CLOCK_SLACK_MS = 5 * 60 * 1000

/** 快照 → 要盯的那几条（发新帖不盯：落到新帖页，靠插件填的那一路或手动记）。 */
export function watchTargets(
  snap: PanelSnapshot,
  nowMs: number,
  /** 人点了「我发了，帮我记一下」：插件正在填的、没发出去多久的都算。 */
  opts: { manual?: boolean } = {},
): WatchTarget[] {
  const out: WatchTarget[] = []
  const cardIds = new Set<string>()
  for (const c of snap.cards) {
    cardIds.add(c.id)
    if (c.kind === 'submit' || c.target_post === undefined || c.draft.text.trim() === '') continue
    out.push({
      key: `c:${c.id}`,
      card: { id: c.id, version: c.version },
      kind: c.kind,
      post: c.target_post,
      ...(c.kind === 'reply' && c.target_parent !== undefined ? { parent: c.target_parent } : {}),
      text: c.draft.text,
      since_ms: Date.parse(c.created_at) || 0,
    })
  }
  for (const w of snap.writes) {
    if (cardIds.has(w.approval_item_id)) continue
    if (w.kind === undefined || w.kind === 'submit' || w.target_post === undefined) continue
    if (w.text === undefined || w.text.trim() === '' || w.record_id !== undefined) continue
    if (w.state === 'sent') continue
    const failedRecently =
      w.state === 'failed' &&
      nowMs - (Date.parse(w.finished_at ?? w.queued_at) || 0) < FAILED_WATCH_MS
    if (opts.manual !== true && w.state !== 'awaiting' && !failedRecently) continue
    if (w.kind === 'reply' && w.target_parent === undefined) continue
    out.push({
      key: `w:${w.job_id}`,
      job: w.job_id,
      kind: w.kind,
      post: w.target_post,
      ...(w.kind === 'reply' && w.target_parent !== undefined ? { parent: w.target_parent } : {}),
      text: w.text,
      since_ms: Date.parse(w.queued_at) || 0,
    })
  }
  return out
}

/** 页面上认出来的这一条算不算（文本相近 + 当前登录的号 + 草稿出来之后才发的）。 */
export function hitMatches(target: WatchTarget, hit: PostedHit, me: string | undefined): boolean {
  if (hit.fullname === undefined && hit.permalink === undefined) return false
  if (hit.created_ms !== undefined && hit.created_ms < target.since_ms - CLOCK_SLACK_MS)
    return false
  return looksLikeSent({ draft: target.text, said: hit.text ?? '', me, author: hit.author })
}

export interface SentWatchDeps {
  /** 开着的新版 Reddit 标签页（加载完的）。 */
  tabs(): Promise<{ id: number; url: string }[]>
  /** 在那个标签页里认「发出去的那一条」的候选（页面脚本放进去再问；放不进去回空）。 */
  find(
    tabId: number,
    selector: string,
    body: string,
    text: string,
    author?: string,
  ): Promise<PostedHit[]>
  /** 当前登录的那个号（不知道回 `undefined`）。 */
  me(): Promise<string | undefined>
  /** 回写「已记录」。回记上了没有。 */
  record(target: WatchTarget, hit: PostedHit): Promise<boolean>
}

/**
 * 看一遍：每一条要盯的，在开着的「这个帖子」的标签页里找。回这一遍记上了几条。
 * `done` = 已经记过的（键 / 那一条的编号），同一条不记两次。
 */
export async function watchSentOnce(
  targets: readonly WatchTarget[],
  deps: SentWatchDeps,
  done: Set<string>,
): Promise<number> {
  const live = targets.filter((t) => !done.has(t.key))
  if (live.length === 0) return 0
  const tabs = (await deps.tabs().catch(() => [])).filter((t) => isNewRedditUrl(t.url))
  if (tabs.length === 0) return 0
  let me: string | undefined
  let asked = false
  let recorded = 0
  for (const t of live) {
    const here = tabs.filter((tab) => redditPostIdOf(tab.url) === t.post)
    if (here.length === 0) continue
    if (!asked) {
      me = await deps.me().catch(() => undefined)
      asked = true
    }
    const sel = redditSentSelectors(
      t.kind === 'reply' ? { kind: 'reply', parent: t.parent ?? '' } : { kind: 'comment' },
    )
    for (const tab of here) {
      const hits = await deps
        .find(tab.id, sel.selector, sel.body, t.text, me)
        .catch((): PostedHit[] => [])
      const hit = hits.find(
        (h) => !done.has(h.fullname ?? h.permalink ?? '') && hitMatches(t, h, me),
      )
      if (hit === undefined) continue
      if (await deps.record(t, hit).catch(() => false)) {
        done.add(t.key)
        done.add(hit.fullname ?? hit.permalink ?? '')
        recorded += 1
      }
      break
    }
  }
  return recorded
}

/**
 * 「认最近一条」：读这个帖子的评论（借这个 Chrome 里的登录会话只读一页，按新到旧），
 * 找当前登录的号在草稿出来之后发的、回对了那一条的最新一条。认不出回一句人话。
 */
export async function latestSent(
  target: WatchTarget,
  deps: { read(url: string): Promise<RedditFetched>; me: string | undefined },
): Promise<{ ok: true; hit: PostedHit } | { ok: false; message: string }> {
  const me = deps.me?.replace(/^\/?u\//u, '').trim()
  if (me === undefined || me === '')
    return {
      ok: false,
      message: '不知道这个 Chrome 登的是哪个 Reddit 号，认不出。贴那一条的链接吧。',
    }
  const url = redditReadUrl({
    key: 'latest',
    kind: 'post_comments',
    post_id: t3less(target.post),
    max_pages: 1,
  })
  const bad = checkRedditReadUrl(url)
  if (bad !== undefined) return { ok: false, message: bad }
  let res: RedditFetched
  try {
    res = await deps.read(url)
  } catch {
    return {
      ok: false,
      message: '没读到这个帖子的评论（Reddit 没开着或没登录）。贴那一条的链接吧。',
    }
  }
  let json: unknown
  try {
    json = JSON.parse(res.body)
  } catch {
    return { ok: false, message: '没读到这个帖子的评论。贴那一条的链接吧。' }
  }
  const items = parseRedditListing(json)?.items ?? []
  const mine = items
    .filter(
      (i) =>
        i.kind === 'comment' &&
        i.author?.toLowerCase() === me.toLowerCase() &&
        i.created_utc * 1000 >= target.since_ms - CLOCK_SLACK_MS &&
        (target.kind !== 'reply' || i.parent_id === target.parent),
    )
    .sort((a, b) => b.created_utc - a.created_utc)
  const top = mine[0]
  if (top === undefined)
    return {
      ok: false,
      message: `这个帖子里没找到 u/${me} 新发的那一条（刚发的话 Reddit 有时要过一会儿才查得到）。贴链接也行。`,
    }
  return {
    ok: true,
    hit: {
      fullname: top.name,
      ...(top.url === undefined ? {} : { permalink: top.url }),
      author: top.author ?? me,
      ...(top.text === '' ? {} : { text: top.text }),
      created_ms: top.created_utc * 1000,
    },
  }
}

const t3less = (id: string): string => id.replace(/^t3_/u, '')
