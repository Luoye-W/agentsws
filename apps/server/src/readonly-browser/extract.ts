/**
 * WP228：在页面里跑的那段**只读**脚本——只读 DOM、数迹象，不点、不填、不改页面。
 *
 * 认三种 Reddit 页面结构（哪种认得出用哪种，一条都认不出就照实说「页面结构认不出」）：
 *
 * 1. 新版（shreddit）：`<shreddit-post>` / `<shreddit-comment>`，字段都在属性上（服务端渲染，
 *    不开页面脚本也在）；
 * 2. 新版搜索结果：`[data-testid="search-post-unit"]` 里的 `a[data-testid="post-title"]`；
 * 3. 旧版（old.reddit.com）：`.thing[data-fullname]`。
 *
 * 产出与接口中台那一路同一组字段（`kind / url / id / title / text / subreddit / author /
 * created_at / score / comments`），再由 WP220 的 `toRedditItem` 归一。
 *
 * **注意**：这个函数会被 Playwright 转成字符串送进页面执行，所以里面不能引用模块里的任何东西。
 * 本单没有访问真的 reddit.com（纪律），结构按公开的页面写法与本地假站点对齐；真站改版认不出时
 * 会走「认不出」那一支，不会编数据。
 */

export interface ExtractArgs {
  limit: number
  /** 每条正文最多留多少字。 */
  maxText: number
}

export interface ExtractResult {
  signals: {
    title: string
    text: string
    passwordInputs: number
    frameSources: string[]
    items: number
  }
  items: Record<string, unknown>[]
}

export function extractRedditPage(args: ExtractArgs): ExtractResult {
  const clip = (s: string | null | undefined, n: number): string =>
    (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
  const num = (s: string | null | undefined): number | undefined => {
    if (s === null || s === undefined || s.trim() === '') return undefined
    const n = Number(s.replace(/,/g, ''))
    return Number.isFinite(n) ? n : undefined
  }
  const put = (o: Record<string, unknown>, k: string, v: unknown): void => {
    if (v !== undefined && v !== null && v !== '') o[k] = v
  }
  const posts: Record<string, unknown>[] = []
  const comments: Record<string, unknown>[] = []

  // 1. 新版 shreddit
  for (const el of Array.from(document.querySelectorAll('shreddit-post'))) {
    const o: Record<string, unknown> = { kind: 'post' }
    put(o, 'url', el.getAttribute('permalink') ?? el.getAttribute('content-href'))
    put(o, 'id', el.getAttribute('id') ?? el.getAttribute('thingid'))
    put(o, 'title', clip(el.getAttribute('post-title'), 500))
    put(o, 'author', el.getAttribute('author'))
    put(
      o,
      'subreddit',
      el.getAttribute('subreddit-name') ?? el.getAttribute('subreddit-prefixed-name'),
    )
    put(o, 'created_at', el.getAttribute('created-timestamp'))
    put(o, 'score', num(el.getAttribute('score')))
    put(o, 'comments', num(el.getAttribute('comment-count')))
    const body = el.querySelector('[slot="text-body"]') ?? el.querySelector('[slot="body"]')
    put(o, 'text', clip(body?.textContent, args.maxText))
    posts.push(o)
  }
  for (const el of Array.from(document.querySelectorAll('shreddit-comment'))) {
    const o: Record<string, unknown> = { kind: 'comment' }
    put(o, 'url', el.getAttribute('permalink'))
    put(o, 'id', el.getAttribute('thingid'))
    put(o, 'author', el.getAttribute('author'))
    put(o, 'score', num(el.getAttribute('score')))
    const ts =
      el.getAttribute('created') ?? el.querySelector('faceplate-timeago')?.getAttribute('ts')
    put(o, 'created_at', ts)
    const body = el.querySelector('[slot="comment"]')
    put(o, 'text', clip(body?.textContent, args.maxText))
    comments.push(o)
  }
  // 2. 新版搜索结果
  if (posts.length === 0) {
    for (const unit of Array.from(document.querySelectorAll('[data-testid="search-post-unit"]'))) {
      const a = unit.querySelector('a[data-testid="post-title"]')
      const o: Record<string, unknown> = { kind: 'post' }
      put(o, 'url', a?.getAttribute('href'))
      put(o, 'title', clip(a?.getAttribute('aria-label') ?? a?.textContent, 500))
      put(o, 'created_at', unit.querySelector('faceplate-timeago')?.getAttribute('ts'))
      const nums = Array.from(unit.querySelectorAll('faceplate-number'))
      put(o, 'score', num(nums[0]?.getAttribute('number')))
      put(o, 'comments', num(nums[1]?.getAttribute('number')))
      const sub = unit.querySelector('a[href^="/r/"]')?.getAttribute('href')
      put(o, 'subreddit', sub?.split('/')[2])
      posts.push(o)
    }
  }
  // 3. 旧版
  if (posts.length === 0 && comments.length === 0) {
    for (const el of Array.from(document.querySelectorAll('.thing[data-fullname]'))) {
      const isComment = el.classList.contains('comment')
      const o: Record<string, unknown> = { kind: isComment ? 'comment' : 'post' }
      put(o, 'url', el.getAttribute('data-permalink'))
      put(o, 'id', el.getAttribute('data-fullname'))
      put(o, 'author', el.getAttribute('data-author'))
      put(o, 'subreddit', el.getAttribute('data-subreddit'))
      put(o, 'score', num(el.getAttribute('data-score')))
      put(o, 'comments', num(el.getAttribute('data-comments-count')))
      const ts = num(el.getAttribute('data-timestamp'))
      put(o, 'created_at', ts === undefined ? undefined : new Date(ts).toISOString())
      put(o, 'title', clip(el.querySelector('a.title')?.textContent, 500))
      put(o, 'text', clip(el.querySelector('.usertext-body')?.textContent, args.maxText))
      ;(isComment ? comments : posts).push(o)
    }
  }

  const isPostPage = comments.length > 0 || /\/comments\//.test(location.pathname)
  const items = isPostPage
    ? [...posts.slice(0, 1), ...comments.slice(0, args.limit)]
    : posts.slice(0, args.limit)
  // 只看 iframe 与验证码挂件——站点自己的脚本名里带 captcha 不算（登录弹窗的脚本可能每页都挂着）
  const frameSources = Array.from(document.querySelectorAll('iframe[src]'))
    .map((el) => el.getAttribute('src') ?? '')
    .filter((s) => s !== '')
    .slice(0, 50)
  if (document.querySelector('.g-recaptcha, .h-captcha, #px-captcha, .cf-turnstile') !== null)
    frameSources.push('captcha-widget')
  const bodyText = (document.body as HTMLElement | null)?.innerText ?? ''
  return {
    signals: {
      title: clip(document.title, 200),
      text: clip(bodyText, 2000).toLowerCase(),
      passwordInputs: document.querySelectorAll('input[type="password"]').length,
      frameSources,
      items: items.length,
    },
    items,
  }
}
