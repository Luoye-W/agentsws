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

import type { PageSignals } from '@agentsws/browser-action/serp'

// WP455：Google / Bing 结果页的提取挪到 `@agentsws/browser-action/serp`（服务进程读「你的 Chrome」读回来的 HTML
// 用同一个函数）；这里原样转出，壳里照旧 `pageScript(extractSerp, …)` 送进页面跑。
export {
  extractSerp,
  type PageSignals,
  type SerpExtract,
  type SerpItem,
} from '@agentsws/browser-action/serp'

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

export interface ReadableExtract {
  signals: PageSignals
  text: string
  truncated: boolean
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
    // 探针在整页加载完之前就在跑：只有明说「没搜到」才马上算；别的要等页面加载完、结果容器在却没结果才算
    if (
      text.includes('did not match any documents') ||
      (document.readyState === 'complete' &&
        document.querySelector('#topstuff .card-section, #search, #rso, #res') !== null)
    )
      return done('no_results')
    return done('pending')
  }
  if (document.querySelector('#b_results li.b_algo') !== null) return done('results')
  // Bing 第一次访问时结果可能晚一步才有（10-21 真机：dom-ready 那一刻 #b_results 里还没有结果）——
  // 页面加载完了还没有才算没结果
  if (document.readyState === 'complete' && document.querySelector('#b_results') !== null)
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
