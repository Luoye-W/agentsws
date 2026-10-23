/**
 * WP477（决策 1609 / 1611 选 A）：官网统计——GA4 + Consent Mode v2 + 底部横幅。纯逻辑在 `../lib/analytics.ts`。
 *
 * 顺序要紧：先把四格同意状态设成 denied（访客之前点过「允许」就马上改 `analytics_storage`），再 `config`，最后才拉 gtag.js。
 * 只在正式域名上拉 gtag.js：本机预览、构建、测试一个统计请求都不发。
 */
import {
  CONSENT_DEFAULT,
  CONSENT_KEY,
  type ConsentChoice,
  consentUpdate,
  eventOf,
  gaCookieNames,
  readChoice,
  shouldLoadGa,
} from '../lib/analytics.js'

type Gtag = (...args: unknown[]) => void
const w = window as unknown as { dataLayer?: unknown[]; gtag?: Gtag }
w.dataLayer = w.dataLayer ?? []
// gtag 认的是 arguments 对象本身（官方片段就是这么写的），不能换成数组
const gtag: Gtag =
  w.gtag ??
  function gtag() {
    // biome-ignore lint/complexity/noArguments: gtag 只认 arguments 对象
    w.dataLayer?.push(arguments)
  }
w.gtag = gtag

const banner = document.querySelector<HTMLElement>('[data-consent]')
const id = banner?.dataset.gaId ?? ''
const hosts = (banner?.dataset.gaHosts ?? '').split(',').filter(Boolean)

function stored(): ConsentChoice | undefined {
  try {
    return readChoice(localStorage.getItem(CONSENT_KEY))
  } catch {
    return undefined
  }
}

gtag('consent', 'default', { ...CONSENT_DEFAULT })
const choice = stored()
if (choice === 'granted') gtag('consent', 'update', consentUpdate('granted'))

if (id !== '' && shouldLoadGa(location.hostname, hosts)) {
  gtag('js', new Date())
  gtag('config', id)
  const s = document.createElement('script')
  s.async = true
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`
  document.head.append(s)
}

/** 让一张 GA Cookie 过期（本域与上一级域各一次：gtag 默认写在 `.agentsws.com`）。 */
function expire(name: string): void {
  const parent = `; domain=.${location.hostname.replace(/^www\./u, '')}`
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API 在 Safari / Firefox 上还没有；这里只让 _ga* 过期
  document.cookie = `${name}=; Max-Age=0; path=/`
  // biome-ignore lint/suspicious/noDocumentCookie: 同上
  document.cookie = `${name}=; Max-Age=0; path=/${parent}`
}

function choose(next: ConsentChoice): void {
  try {
    localStorage.setItem(CONSENT_KEY, next)
  } catch {
    /* 隐私模式存不了：这一页里照样生效 */
  }
  gtag('consent', 'update', consentUpdate(next))
  // 改成「不允许」：之前存下的 GA Cookie 一起清掉（只清 _ga / _ga_*，只是让它们过期）
  if (next === 'denied') for (const name of gaCookieNames(document.cookie)) expire(name)
  if (banner) banner.hidden = true
}

if (banner) {
  // 还没选过就露出来；选过的不再打扰（页脚「统计设置」能再打开）
  if (choice === undefined || location.hash === '#consent') banner.hidden = false
  for (const btn of banner.querySelectorAll<HTMLButtonElement>('[data-consent-choice]'))
    btn.addEventListener('click', () => choose(btn.dataset.consentChoice as ConsentChoice))
}

document.addEventListener(
  'click',
  (e) => {
    const a = (e.target as Element | null)?.closest?.('a')
    if (!a) return
    // 页脚「统计设置」/ 隐私政策里的 #consent：打开横幅
    if (a.getAttribute('href')?.endsWith('#consent') && banner) {
      e.preventDefault()
      banner.hidden = false
      banner.querySelector<HTMLButtonElement>('[data-consent-choice="granted"]')?.focus()
      return
    }
    const ev = eventOf({ href: a.href, dl: a.hasAttribute('data-dl') }, location.pathname)
    if (ev) gtag('event', ev.name, ev.params)
  },
  { capture: true },
)
