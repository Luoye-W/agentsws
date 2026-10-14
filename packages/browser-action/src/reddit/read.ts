/**
 * WP328（docs/102 §3，Luoye 10-14 定）：**Reddit 只读**——插件借用户日常 Chrome 里已经登录的会话，
 * 取品牌号自己的收件箱与自家版块的 `.json`。
 *
 * 三条纪律（与 WP313 的广告动作同一套：只限速、不伪装、被拦就停）：
 *
 * 1. **只读 GET、只认白名单里的几种地址**：收件箱（必须带 `mark=false`，不改已读）、版块新帖 / 新评论、
 *    某帖评论、`/api/me.json`（看登的是哪个号）。别的地址一律拒（{@link checkRedditReadUrl}）。
 * 2. **不登录、不碰口令**：没登录就停下，回「没登录」让工坊出连接卡（WP324）。
 * 3. **判新看编号，不看未读标记**：本机服务给每一路一个「上次读到哪一条」（`stop_at`），读到它就停翻页。
 *
 * 这一份插件与本机服务共用，所以一个 `node:` 都不许出现。
 */

/** 只开这两个站（同一个登录会话；`old.` 的 `.json` 最稳）。 */
export const REDDIT_READ_ORIGIN = 'https://old.reddit.com'

/** 插件连接 Reddit 时申请的可选站点权限（WP329 写也用这一份）。 */
export const REDDIT_HOST_PERMISSIONS: readonly string[] = [
  'https://old.reddit.com/*',
  'https://www.reddit.com/*',
]

/** 一路读什么。 */
export type RedditReadKind =
  /** 收件箱（评论回复 / 帖子回复 / 被 @ / 老式私信，一次全拿）。 */
  | 'inbox'
  /** 某个版块的新帖。 */
  | 'sub_new'
  /** 某个版块的新评论（整个版块的，按时间倒序）。 */
  | 'sub_comments'
  /** 某一帖下面的评论（平铺）。 */
  | 'post_comments'
  /** WP329（决策 764）：某个版块的版规（起草时当上下文；只读，一页）。 */
  | 'sub_rules'

export interface RedditReadRequest {
  /** 这一路的键（本机服务按它记「上次读到哪」）：`inbox`、`sub_new:inmoxr`… */
  key: string
  kind: RedditReadKind
  /** `sub_new` / `sub_comments` 要。不带 `r/`。 */
  subreddit?: string
  /** `post_comments` 要：帖子 id（不带 `t3_`）。 */
  post_id?: string
  /** 读到这一条（全名 `t1_xxx`）就停，不再往后翻。 */
  stop_at?: string
  /** 比这个时间（秒）更早的不要（第一次读时防止把几个月前的老帖当新的）。 */
  since_utc?: number
  /** 最多翻几页（每页最多 100 条）。 */
  max_pages: number
}

/** 一页多少条（Reddit 上限 100）。 */
export const REDDIT_PAGE_LIMIT = 100
/** 一路最多翻几页（防止一次读太多）。 */
export const REDDIT_MAX_PAGES = 5
/** 两次请求之间的**固定**间隔（毫秒）。固定，不随机（决策 555）。 */
export const REDDIT_READ_GAP_MS = 2_000

const SUB_NAME = /^[A-Za-z0-9_]{2,21}$/u
const POST_ID = /^[a-z0-9]{3,12}$/u
const FULLNAME = /^t[1-6]_[a-z0-9]{1,13}$/u

/** 版块名规范化：去掉 `r/`、`/r/`、空白；不合法回 `undefined`。 */
export function normalizeSubreddit(raw: string): string | undefined {
  const s = raw
    .trim()
    .replace(/^https?:\/\/(www\.|old\.)?reddit\.com/iu, '')
    .replace(/^\/?r\//iu, '')
    .replace(/\/.*$/u, '')
  return SUB_NAME.test(s) ? s : undefined
}

/** 这一路第几页的地址。`after` 是上一页给的翻页标记。 */
export function redditReadUrl(req: RedditReadRequest, after?: string): string {
  const q = new URLSearchParams()
  q.set('limit', String(REDDIT_PAGE_LIMIT))
  q.set('raw_json', '1')
  if (after !== undefined) q.set('after', after)
  let path: string
  switch (req.kind) {
    case 'inbox':
      path = '/message/inbox/.json'
      // 不改已读（决策 661）：你手机上的红点原样留着
      q.set('mark', 'false')
      break
    case 'sub_new':
      path = `/r/${req.subreddit ?? ''}/new/.json`
      break
    case 'sub_comments':
      path = `/r/${req.subreddit ?? ''}/comments/.json`
      break
    case 'post_comments':
      path = `/comments/${req.post_id ?? ''}/.json`
      q.set('sort', 'new')
      break
    case 'sub_rules':
      path = `/r/${req.subreddit ?? ''}/about/rules.json`
      q.delete('limit')
      break
  }
  return `${REDDIT_READ_ORIGIN}${path}?${q.toString()}`
}

/** 看登的是哪个号。 */
export const REDDIT_ME_URL = `${REDDIT_READ_ORIGIN}/api/me.json?raw_json=1`

const ALLOWED_PATHS: readonly RegExp[] = [
  /^\/message\/inbox\/\.json$/u,
  /^\/r\/[A-Za-z0-9_]{2,21}\/new\/\.json$/u,
  /^\/r\/[A-Za-z0-9_]{2,21}\/comments\/\.json$/u,
  /^\/comments\/[a-z0-9]{3,12}\/\.json$/u,
  // WP329：版规（只读）
  /^\/r\/[A-Za-z0-9_]{2,21}\/about\/rules\.json$/u,
  /^\/api\/me\.json$/u,
]

/**
 * 执行前最后一道闸：只放行白名单里的 GET 地址；收件箱必须带 `mark=false`。
 * 回 `undefined` = 放行；回一句话 = 拒。
 */
export function checkRedditReadUrl(url: string): string | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return '地址不对。'
  }
  if (u.origin !== REDDIT_READ_ORIGIN) return `只读 ${REDDIT_READ_ORIGIN} 上的数据。`
  if (!ALLOWED_PATHS.some((p) => p.test(u.pathname)))
    return `这个地址不在只读白名单里：${u.pathname}`
  if (u.pathname.startsWith('/message/') && u.searchParams.get('mark') !== 'false')
    return '读收件箱必须带 mark=false（不改已读）。'
  return undefined
}

/** 本机服务给的一路请求合不合法（插件领到活时再查一遍）。 */
export function checkRedditReadRequest(req: RedditReadRequest): string | undefined {
  if (typeof req.key !== 'string' || req.key === '' || req.key.length > 80) return '这一路没有键。'
  if (
    (req.kind === 'sub_new' || req.kind === 'sub_comments' || req.kind === 'sub_rules') &&
    !SUB_NAME.test(req.subreddit ?? '')
  )
    return '版块名不对。'
  if (req.kind === 'post_comments' && !POST_ID.test(req.post_id ?? '')) return '帖子 id 不对。'
  if (req.stop_at !== undefined && !FULLNAME.test(req.stop_at)) return '「读到哪」的编号不对。'
  if (!Number.isInteger(req.max_pages) || req.max_pages < 1 || req.max_pages > REDDIT_MAX_PAGES)
    return `一路最多翻 ${REDDIT_MAX_PAGES} 页。`
  return checkRedditReadUrl(redditReadUrl(req))
}
