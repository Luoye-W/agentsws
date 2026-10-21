/**
 * WP353：应用内搜索浏览器里跑的**只读** DOM 提取（经 `webContents.executeJavaScript` 注入）。
 *
 * 只读 DOM：不点击、不填表、不改页面、不发请求。两个函数都会被 `toString()` 成字符串送进页面执行，
 * 所以**里面不能引用模块里的任何东西**（工具函数都写在函数体内）。
 *
 * - {@link extractSerp}：Google / Bing 搜索结果页 → 标题、真实链接、摘要；Google 的 `/url?q=…`、
 *   Bing 的 `/ck/a?…&u=a1<base64>` 跳转链接还原成目标网址；广告位不收。
 * - {@link extractReadable}：普通网页（Reddit / LinkedIn 这类匿名抓取常被拒的站）→ 标题 + 正文文字。
 *
 * 两个都顺带交回几样「被拦了没有」的迹象（人机验证挂件、正文开头一截），判断在服务进程里做。
 */

export interface SerpItem {
  url: string
  title: string
  snippet?: string
}

export interface PageSignals {
  title: string
  /** 正文开头一截（小写），认验证页 / 登录墙用。 */
  text: string
  /** 页面上有没有人机验证挂件（reCAPTCHA / hCaptcha / Turnstile / Google 的验证表单）。 */
  captcha: boolean
  passwordInputs: number
  /**
   * WP454：是不是 Google 的「过渡页」（没 cookie 的新浏览器第一次搜会先拿到它：页面脚本跑完再带 `sei=`
   * 请求一次才是真结果页）。HTML 里有 `enablejs` 那个重试地址就算。只有 {@link extractSerp} 填。
   */
  interstitial?: boolean
}

/**
 * WP454：搜索结果页现在是什么状态（`dom-ready` 之后轮询它，等到真结果页再读）。
 * - `results`：结果容器里有结果；`no_results`：页面加载完了、明说 / 实际没结果；
 * - `blocked`：`/sorry`、验证码；`consent`：Google 的 cookie 同意页；
 * - `interstitial`：Google 过渡页（还会自己跳）；`pending`：还没出来。
 */
export type SerpState =
  | 'results'
  | 'no_results'
  | 'blocked'
  | 'consent'
  | 'interstitial'
  | 'pending'

export interface SerpProbe {
  state: SerpState
  /** 核实用（WP454 §6）：视图不挂到窗口上时页面自己看到的可见性与视口大小。 */
  visibility: string
  width: number
  height: number
}

export interface SerpExtract {
  signals: PageSignals
  items: SerpItem[]
  /**
   * WP454：页面上看到几个「结果标题」（Google `a h3`、Bing `li.b_algo`）——0 条结果时用来分清
   * 「真没结果」和「有结果但没读出来」（留痕里那一句）。
   */
  candidates?: number
}

export interface ReadableExtract {
  signals: PageSignals
  text: string
  truncated: boolean
}

export function extractSerp(args: { engine: 'google' | 'bing'; limit: number }): SerpExtract {
  const clean = (s: string | null | undefined, n: number): string =>
    (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
  const absolute = (href: string): string => {
    try {
      return new URL(href, location.href).href
    } catch {
      return ''
    }
  }
  /** 跳转链接 → 目标网址；认不出就原样（只收 http / https）。 */
  const target = (href: string): string => {
    const abs = absolute(href)
    if (abs === '') return ''
    let u: URL
    try {
      u = new URL(abs)
    } catch {
      return ''
    }
    const host = u.hostname.replace(/^www\./, '')
    if (/^google\./.test(host) && u.pathname === '/url') {
      // WP454：`/url?sa=t&q=&url=https…` 这种 q 是空的、目标在 url 里——哪个是网址取哪个
      const q = [u.searchParams.get('q'), u.searchParams.get('url')].find(
        (v) => v !== null && /^https?:\/\//.test(v),
      )
      return q ?? ''
    }
    if (host === 'bing.com' && u.pathname.startsWith('/ck/a')) {
      const raw = u.searchParams.get('u')
      if (raw === null) return ''
      const b64 = raw.replace(/^a1/, '').replace(/-/g, '+').replace(/_/g, '/')
      try {
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
        const decoded = decodeURIComponent(
          Array.from(atob(padded))
            .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
            .join(''),
        )
        return /^https?:\/\//.test(decoded) ? decoded : ''
      } catch {
        return ''
      }
    }
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : ''
  }
  const own = (url: string): boolean => {
    try {
      const h = new URL(url).hostname.replace(/^www\./, '')
      return (
        (args.engine === 'google' && (/^google\./.test(h) || h.endsWith('.google.com'))) ||
        (args.engine === 'bing' && (h === 'bing.com' || h.endsWith('.bing.com')))
      )
    } catch {
      return true
    }
  }
  const items: SerpItem[] = []
  let candidates = 0
  const seen = new Set<string>()
  const push = (url: string, title: string, snippet: string): void => {
    if (url === '' || title === '' || seen.has(url) || own(url)) return
    seen.add(url)
    items.push({ url, title, ...(snippet === '' ? {} : { snippet }) })
  }
  if (args.engine === 'google') {
    // WP454：先在 #search 里找；一条都没有再看 #rso、整页（结果容器的位置随 Google 改版会变）
    const roots = [document.querySelector('#search'), document.querySelector('#rso'), document]
    for (const root of roots) {
      if (root === null || items.length > 0) continue
      const heads = Array.from(root.querySelectorAll('a h3'))
      candidates = Math.max(candidates, heads.length)
      for (const h3 of heads) {
        if (items.length >= args.limit) break
        const a = h3.closest('a')
        if (a === null) continue
        // 广告块（「赞助商」）不收
        if (a.closest('#tads, #bottomads, [data-text-ad]') !== null) continue
        const box =
          a.closest('div.g, div.MjjYud, div[data-hveid], div[data-sokoban-container]') ??
          a.parentElement
        const snip =
          box?.querySelector('.VwiC3b, [data-sncf], div[style*="-webkit-line-clamp"]')
            ?.textContent ?? ''
        // WP454：href 不是网址（`#`、脚本）时看 data-href、ping（`/url?…&url=` 里有目标）
        const url =
          ['href', 'data-href', 'ping']
            .map((attr) => target(a.getAttribute(attr) ?? ''))
            .find((u) => u !== '' && !own(u)) ?? ''
        push(url, clean(h3.textContent, 300), clean(snip, 500))
      }
    }
  } else {
    const lis = Array.from(document.querySelectorAll('#b_results li.b_algo'))
    candidates = lis.length
    for (const li of lis) {
      if (items.length >= args.limit) break
      const a = li.querySelector('h2 a')
      if (a === null) continue
      const snip = li.querySelector('.b_caption p, p.b_lineclamp2, p.b_lineclamp3, p')?.textContent
      push(target(a.getAttribute('href') ?? ''), clean(a.textContent, 300), clean(snip, 500))
    }
  }
  const body = document.body as HTMLElement | null
  const text = (body?.innerText ?? body?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 3000)
  return {
    signals: {
      title: clean(document.title, 200),
      text: text.toLowerCase(),
      captcha:
        document.querySelector(
          '#captcha-form, .g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]',
        ) !== null,
      passwordInputs: document.querySelectorAll('input[type="password"]').length,
      interstitial:
        (document.documentElement?.innerHTML ?? '').includes('enablejs') &&
        items.length === 0 &&
        document.querySelector('#search, #rso') === null,
    },
    items,
    candidates,
  }
}

/**
 * WP454：搜索结果页轮询用的探针（只读，同 {@link extractSerp} 送进页面执行，里面不引用模块里的东西）。
 * 顺序：同意页 → 被拦 → 结果 → 过渡页 → 无结果 → 还没出来。
 */
export function serpState(args: { engine: 'google' | 'bing' }): SerpProbe {
  const done = (state: SerpState): SerpProbe => ({
    state,
    visibility: String(document.visibilityState ?? ''),
    width: Number(globalThis.innerWidth ?? 0),
    height: Number(globalThis.innerHeight ?? 0),
  })
  const host = location.hostname.toLowerCase()
  const path = location.pathname
  const text = (
    (document.body as HTMLElement | null)?.innerText ??
    document.body?.textContent ??
    ''
  )
    .replace(/\s+/g, ' ')
    .toLowerCase()
  if (
    args.engine === 'google' &&
    (/^consent\.google\./.test(host) ||
      document.querySelector('form[action*="consent.google."]') !== null)
  )
    return done('consent')
  if (
    path.startsWith('/sorry') ||
    document.querySelector(
      '#captcha-form, .g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]',
    ) !== null ||
    text.includes('unusual traffic')
  )
    return done('blocked')
  if (args.engine === 'google') {
    if (document.querySelector('#search a h3, #rso a h3') !== null) return done('results')
    const html = document.documentElement?.innerHTML ?? ''
    if (
      html.includes('enablejs') ||
      text.includes('not redirected within a few seconds') ||
      text.includes('having trouble accessing google search')
    )
      return done('interstitial')
    if (
      document.querySelector('#topstuff .card-section, #botstuff') !== null ||
      ((document.querySelector('#search, #rso, #res') !== null ||
        text.includes('did not match any documents')) &&
        document.readyState === 'complete')
    )
      return done('no_results')
    return done('pending')
  }
  if (document.querySelector('#b_results li.b_algo') !== null) return done('results')
  if (
    document.querySelector('#b_results .b_no') !== null ||
    (document.querySelector('#b_results') !== null && document.readyState === 'complete')
  )
    return done('no_results')
  return done('pending')
}

export function extractReadable(args: { maxChars: number }): ReadableExtract {
  const body = document.body as HTMLElement | null
  // 正文优先：article / main / [role=main]；都没有就整页
  const main =
    (document.querySelector('article, main, [role="main"]') as HTMLElement | null) ?? body
  const raw = main?.innerText ?? main?.textContent ?? ''
  const text = raw
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '')
    .join('\n')
  const all = (body?.innerText ?? body?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 3000)
  return {
    signals: {
      title: (document.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      text: all.toLowerCase(),
      captcha:
        document.querySelector(
          '#captcha-form, .g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]',
        ) !== null,
      passwordInputs: document.querySelectorAll('input[type="password"]').length,
    },
    text: text.slice(0, args.maxChars),
    truncated: text.length > args.maxChars,
  }
}

/**
 * WP393（docs/104 §3.6）：**数据地址的原文**（竞品店公开的 `products.json` / Store API / `all.atom`）——
 * 直接请求被挡时，在内置浏览器里打开同一个地址、把页面上显示的原文原样读回（不折行、不压空白）。
 * JSON / 纯文本页 Chromium 把原文放在 `<pre>` 里；XML 页把整份文档序列化回去。只读，不点不填。
 */
export function extractData(args: {
  maxChars: number
}): ReadableExtract & { content_type: string } {
  const type = (document.contentType ?? '').toLowerCase()
  const pre = document.querySelector('body > pre') as HTMLElement | null
  const raw = /xml/.test(type)
    ? new XMLSerializer().serializeToString(document)
    : (pre?.textContent ??
      document.body?.textContent ??
      document.documentElement?.textContent ??
      '')
  const head = raw.slice(0, 3000)
  return {
    signals: {
      title: (document.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      text: head.replace(/\s+/g, ' ').toLowerCase(),
      captcha:
        document.querySelector(
          '#captcha-form, .g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]',
        ) !== null,
      passwordInputs: document.querySelectorAll('input[type="password"]').length,
    },
    text: raw.slice(0, args.maxChars),
    truncated: raw.length > args.maxChars,
    content_type: type,
  }
}

/**
 * WP394（docs/104 一期 B）：**Amazon 前台页的 HTML 原文**（商品页 / 搜索页）——服务进程按 `brand-intake` 的
 * 那套解析器读价格、划线价、优惠券、BSR、有没有货。只读：不点、不填、不滚动。
 */
export function extractHtml(args: { maxChars: number }): ReadableExtract {
  const raw = document.documentElement?.outerHTML ?? ''
  const body = (document.body?.innerText ?? '').slice(0, 3000)
  return {
    signals: {
      title: (document.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      text: body.replace(/\s+/g, ' ').toLowerCase(),
      captcha:
        document.querySelector(
          'form[action*="validateCaptcha"], #captchacharacters, .g-recaptcha, .h-captcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]',
        ) !== null,
      passwordInputs: document.querySelectorAll('input[type="password"]').length,
    },
    text: raw.slice(0, args.maxChars),
    truncated: raw.length > args.maxChars,
  }
}

/** 拼成 `executeJavaScript` 要的那一段（函数源码 + 参数，参数只是 JSON 数据）。 */
export function pageScript<A>(fn: (args: A) => unknown, args: A): string {
  return `(${fn.toString()})(${JSON.stringify(args)})`
}
