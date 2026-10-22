/**
 * WP467（Luoye 10-22 Windows 真机）：**按帖子认页面**——「填入」先找用户已经开着的那个原帖标签页，
 * 自动记录也只认「这个帖子里」的那一条。网址形态很多，这里一处认全（插件与本机服务共用，纯函数）：
 *
 * - `https://www.reddit.com/r/<版>/comments/<帖>/<标题段>/`（带不带标题段、查询参数、`#`）
 * - `https://www.reddit.com/r/<版>/comments/<帖>/comment/<评论>/`（新版评论永久链接）
 * - `https://www.reddit.com/r/<版>/comments/<帖>/<标题段>/<评论>/`（旧版评论永久链接）
 * - `https://www.reddit.com/comments/<帖>/`、`/user/<人>/comments/<帖>/…`、`https://redd.it/<帖>`
 * - `old.` / `new.` / `np.` / `m.` / `sh.` / 不带 `www.` 的 Reddit 子域；站内相对路径
 *
 * 认不出（`/r/<版>/s/<分享码>` 这种要跳一次才知道是哪一帖的短链）就回 `undefined`，不猜。
 */

const POST_ID = /^[a-z0-9]{3,12}$/u
const COMMENT_ID = /^[a-z0-9]{3,12}$/u

/** Reddit 自己的主机（含子域）与短链 redd.it。 */
function redditHost(host: string): 'site' | 'short' | undefined {
  const h = host.toLowerCase()
  if (h === 'redd.it') return 'short'
  if (h === 'reddit.com' || h.endsWith('.reddit.com')) return 'site'
  return undefined
}

/** 网址 / 站内路径 → 主机 + 路径段（小写）。认不出回 `undefined`。 */
function partsOf(url: string): { kind: 'site' | 'short'; segs: string[] } | undefined {
  const raw = url.trim()
  if (raw === '') return undefined
  let host = 'www.reddit.com'
  let path = raw
  if (/^[a-z][a-z0-9+.-]*:/iu.test(raw)) {
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      return undefined
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
    host = u.hostname
    path = u.pathname
  } else if (!raw.startsWith('/')) return undefined
  const kind = redditHost(host)
  if (kind === undefined) return undefined
  const segs = (path.split(/[?#]/u)[0] ?? '')
    .split('/')
    .filter((s) => s !== '')
    .map((s) => s.toLowerCase())
  return { kind, segs }
}

/** 帖子 id（不带 `t3_`，小写）。认不出回 `undefined`。 */
export function redditPostIdOf(url: string): string | undefined {
  const p = partsOf(url)
  if (p === undefined) return undefined
  if (p.kind === 'short') {
    const id = p.segs[0]
    return id !== undefined && POST_ID.test(id) ? id : undefined
  }
  const at = p.segs.indexOf('comments')
  if (at < 0) return undefined
  const id = p.segs[at + 1]
  return id !== undefined && POST_ID.test(id) ? id : undefined
}

/** 评论 id（不带 `t1_`）：永久链接指向某一条评论时才有。 */
export function redditCommentIdOf(url: string): string | undefined {
  const p = partsOf(url)
  if (p === undefined || p.kind === 'short') return undefined
  const at = p.segs.indexOf('comments')
  if (at < 0 || redditPostIdOf(url) === undefined) return undefined
  const rest = p.segs.slice(at + 2)
  // 新版：…/comment/<评论>/；旧版：…/<标题段>/<评论>/——都是帖子 id 后面第二段
  const id = rest[1]
  return id !== undefined && COMMENT_ID.test(id) ? id : undefined
}

/** `t3_abc` / `abc` → `abc`（不合法回 `undefined`）。 */
export function bareRedditId(id: string | undefined, prefix: 't1' | 't3'): string | undefined {
  if (id === undefined) return undefined
  const v = id.trim().toLowerCase()
  const bare = v.startsWith(`${prefix}_`) ? v.slice(3) : v
  return POST_ID.test(bare) ? bare : undefined
}

/**
 * 这个网址是不是**新版 Reddit**（www / 不带 www 的 reddit.com）——「填入」只在这种标签页里填，
 * old.reddit 不进写路径（WP467 第 5 条）。
 */
export function isNewRedditUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase()
    return h === 'www.reddit.com' || h === 'reddit.com'
  } catch {
    return false
  }
}

/** 两个网址是不是同一个帖子。 */
export function sameRedditPost(a: string, b: string): boolean {
  const x = redditPostIdOf(a)
  return x !== undefined && x === redditPostIdOf(b)
}
