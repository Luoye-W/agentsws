/**
 * WP455（docs/110 §3，决策 1434）：Google / Bing 搜索结果页的**只读**提取——桌面壳与服务进程共用同一套选择器。
 *
 * 原来只在桌面壳里（WP353 / WP454，`apps/desktop/src/search-extract.ts`），经 `webContents.executeJavaScript`
 * 送进内置浏览器的页面里跑。WP455 的「用你的 Chrome 搜 Google」读回的是 HTML 原文（BrowserSkill `get-html`），
 * 服务进程拿解析好的文档对象再跑**同一个函数**，两边的选择器、跳转链接还原、广告过滤一字不差。
 *
 * - 页面里跑：`extractSerp(args)`——`doc` / `here` 缺省就是页面自己的 `document` / `location.href`；
 *   函数会被 `toString()` 成字符串送进页面执行，所以**里面不能引用模块里的任何东西**（工具函数都写在函数体内）。
 * - 服务进程跑：`extractSerp(args, 解析好的文档, 结果页地址)`。
 *
 * 只读 DOM：不点击、不填表、不改页面、不发请求。顺带交回几样「被拦了没有」的迹象，判断在服务进程里做。
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

export interface SerpExtract {
  signals: PageSignals
  items: SerpItem[]
  /**
   * WP454：页面上看到几个「结果标题」（Google `a h3`、Bing `li.b_algo`）——0 条结果时用来分清
   * 「真没结果」和「有结果但没读出来」（留痕里那一句）。
   */
  candidates?: number
}

export function extractSerp(
  args: { engine: 'google' | 'bing'; limit: number },
  doc: Document = document,
  here: string = location.href,
): SerpExtract {
  const clean = (s: string | null | undefined, n: number): string =>
    (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
  const absolute = (href: string): string => {
    try {
      return new URL(href, here).href
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
    const roots = [doc.querySelector('#search'), doc.querySelector('#rso'), doc]
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
    const lis = Array.from(doc.querySelectorAll('#b_results li.b_algo'))
    candidates = lis.length
    for (const li of lis) {
      if (items.length >= args.limit) break
      const a = li.querySelector('h2 a')
      if (a === null) continue
      const snip = li.querySelector('.b_caption p, p.b_lineclamp2, p.b_lineclamp3, p')?.textContent
      push(target(a.getAttribute('href') ?? ''), clean(a.textContent, 300), clean(snip, 500))
    }
  }
  const body = doc.body as HTMLElement | null
  const text = (body?.innerText ?? body?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 3000)
  return {
    signals: {
      title: clean(doc.title, 200),
      text: text.toLowerCase(),
      captcha:
        doc.querySelector(
          '#captcha-form, .g-recaptcha, .h-captcha, .cf-turnstile, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]',
        ) !== null,
      passwordInputs: doc.querySelectorAll('input[type="password"]').length,
      interstitial:
        (doc.documentElement?.innerHTML ?? '').includes('enablejs') &&
        items.length === 0 &&
        doc.querySelector('#search, #rso') === null,
    },
    items,
    candidates,
  }
}
