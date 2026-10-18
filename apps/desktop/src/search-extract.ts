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
}

export interface SerpExtract {
  signals: PageSignals
  items: SerpItem[]
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
      const q = u.searchParams.get('q') ?? u.searchParams.get('url')
      return q !== null && /^https?:\/\//.test(q) ? q : ''
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
  const seen = new Set<string>()
  const push = (url: string, title: string, snippet: string): void => {
    if (url === '' || title === '' || seen.has(url) || own(url)) return
    seen.add(url)
    items.push({ url, title, ...(snippet === '' ? {} : { snippet }) })
  }
  if (args.engine === 'google') {
    const root = document.querySelector('#search') ?? document.querySelector('#rso') ?? document
    for (const h3 of Array.from(root.querySelectorAll('a h3'))) {
      if (items.length >= args.limit) break
      const a = h3.closest('a')
      if (a === null) continue
      // 广告块（「赞助商」）不收
      if (a.closest('#tads, #bottomads, [data-text-ad]') !== null) continue
      const box =
        a.closest('div.g, div.MjjYud, div[data-hveid], div[data-sokoban-container]') ??
        a.parentElement
      const snip =
        box?.querySelector('.VwiC3b, [data-sncf], div[style*="-webkit-line-clamp"]')?.textContent ??
        ''
      push(target(a.getAttribute('href') ?? ''), clean(h3.textContent, 300), clean(snip, 500))
    }
  } else {
    for (const li of Array.from(document.querySelectorAll('#b_results li.b_algo'))) {
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
    },
    items,
  }
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

/** 拼成 `executeJavaScript` 要的那一段（函数源码 + 参数，参数只是 JSON 数据）。 */
export function pageScript<A>(fn: (args: A) => unknown, args: A): string {
  return `(${fn.toString()})(${JSON.stringify(args)})`
}
