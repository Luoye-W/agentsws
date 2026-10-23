/**
 * WP477（决策 1609 / 1611）：官网统计的纯逻辑（DOM 那一侧在 `scripts/analytics.ts`，测试只测这里）。
 */
import { ACCOUNT_PATHS, CLOUD_URL } from '../config.js'

/** 访客的选择存在这一格（localStorage，与明暗偏好 `aw-theme` 一样只存一个词）。 */
export const CONSENT_KEY = 'aw-consent'
export type ConsentChoice = 'granted' | 'denied'

/** Consent Mode v2 的默认：四格全 denied（同意前 GA 只做不存 Cookie 的粗计数）。 */
export const CONSENT_DEFAULT = {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
} as const

/** 访客点了「允许 / 不允许」之后的那一下更新：**只动 `analytics_storage`**，广告类永远不开。 */
export function consentUpdate(choice: ConsentChoice): { analytics_storage: ConsentChoice } {
  return { analytics_storage: choice }
}

export function readChoice(raw: string | null | undefined): ConsentChoice | undefined {
  return raw === 'granted' || raw === 'denied' ? raw : undefined
}

/** 只在正式域名上加载 gtag（本机预览、测试一个统计请求都不发）。 */
export function shouldLoadGa(hostname: string, hosts: readonly string[]): boolean {
  return hosts.includes(hostname.toLowerCase())
}

/** 页面在哪一块（事件参数，只是固定的几个词，不带地址）。 */
export function placementOf(pathname: string): 'home' | 'download' | 'pricing' | 'docs' | 'other' {
  const bare = pathname.replace(/^\/en(?=\/|$)/u, '') || '/'
  if (bare === '/') return 'home'
  if (bare.startsWith('/download')) return 'download'
  if (bare.startsWith('/pricing')) return 'pricing'
  if (bare.startsWith('/docs')) return 'docs'
  return 'other'
}

export type SiteEvent =
  | {
      name: 'download_click'
      params: {
        os: 'mac' | 'win' | 'extension' | 'unknown'
        link: 'file' | 'page'
        placement: string
      }
    }
  | { name: 'signup_click'; params: { placement: string } }

/**
 * 一次点击 → 要报的那件事（不是下载 / 注册就 `undefined`）。只看链接本身：
 * - 安装包直链（`.dmg` / `.exe` / `.zip`，或 `dl.agentsws.com`）→ `download_click`（`link: file`）；
 * - 首页「免费下载」还没换成直链时去下载页（`data-dl`）→ `download_click`（`link: page`）；
 * - 云端注册页 → `signup_click`。
 */
export function eventOf(
  link: { href: string; dl?: boolean },
  pathname: string,
): SiteEvent | undefined {
  const placement = placementOf(pathname)
  let url: URL
  try {
    url = new URL(link.href, 'https://agentsws.com')
  } catch {
    return undefined
  }
  const file = url.pathname.toLowerCase()
  if (url.host === 'dl.agentsws.com' || /\.(dmg|exe|zip)$/u.test(file)) {
    const os = file.endsWith('.dmg')
      ? 'mac'
      : file.endsWith('.exe')
        ? 'win'
        : /extension/u.test(file)
          ? 'extension'
          : /mac|darwin|arm64/u.test(file)
            ? 'mac'
            : 'unknown'
    return { name: 'download_click', params: { os, link: 'file', placement } }
  }
  if (link.dl === true)
    return { name: 'download_click', params: { os: 'unknown', link: 'page', placement } }
  if (`${url.protocol}//${url.host}` === CLOUD_URL && url.pathname === ACCOUNT_PATHS.signup)
    return { name: 'signup_click', params: { placement } }
  return undefined
}

/** 「不允许」时要清掉的 GA Cookie 名（`_ga`、`_ga_<容器>`）。 */
export function gaCookieNames(cookieHeader: string): string[] {
  return cookieHeader
    .split(';')
    .map((c) => c.split('=')[0]?.trim() ?? '')
    .filter((name) => name === '_ga' || name.startsWith('_ga_'))
}
