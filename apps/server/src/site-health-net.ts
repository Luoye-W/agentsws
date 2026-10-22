/**
 * WP448（docs/109 §4.4）：技术体检要的两口网络读——都是**只读 GET**，只碰我们自己的站与 Google 的公开测速接口。
 *
 * 1. 不跟跳转地抓一次（`redirect: 'manual'`）：状态码、`Location`、`X-Robots-Tag`。查跳转链、死链、站点地图里的坏地址用。
 *    只给体检用的那几个站内地址调；跳出自己站的那一跳由 `traceRedirects` 停住，不往外抓。
 * 2. PageSpeed Insights v5（Google 公开接口，不要 key、不花钱）：一次回包里同时有 CrUX 真实用户数据与
 *    Lighthouse 实验室数（`speedReadingOf` 优先真实用户）。每次体检只量两页（首页、一件商品）。
 */
import { BRAND_INTAKE_USER_AGENT, type PageFetch } from '@agentsws/brand-intake'
import type { RedirectProbe } from '@agentsws/site-core'

/** 真请求能用的那一口 fetch（`globalThis.fetch` 的子集）。 */
export type RawFetch = (
  url: string,
  init: {
    method: 'GET'
    redirect: 'manual'
    headers: Record<string, string>
    signal: AbortSignal
  },
) => Promise<{ status: number; headers: { get(name: string): string | null }; body?: unknown }>

const PROBE_TIMEOUT_MS = 10_000
const PAGESPEED_TIMEOUT_MS = 60_000

/** 不跟跳转地抓一次（真请求）。抓不到就抛，由调用方记成「打不开」。 */
export function manualRedirectProbe(doFetch: RawFetch): RedirectProbe {
  return async (url) => {
    const res = await doFetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': BRAND_INTAKE_USER_AGENT, accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    // 不读正文：只要状态码与头
    try {
      const body = res.body as { cancel?: () => Promise<void> } | undefined
      await body?.cancel?.()
    } catch {
      // 关不掉也没关系
    }
    const location = res.headers.get('location') ?? undefined
    const x_robots = res.headers.get('x-robots-tag') ?? undefined
    return {
      status: res.status,
      ...(location === undefined ? {} : { location }),
      ...(x_robots === undefined ? {} : { x_robots }),
    }
  }
}

/**
 * 测试 / demo 用的替身抓取（`PageFetch`）推出一口「不跟跳转」：它本来就不跳，状态码原样给。
 * 要演跳转的另给 `siteHealthProbe`。
 */
export function probeFromPageFetch(doFetch: PageFetch): RedirectProbe {
  return async (url) => {
    const r = await doFetch(url, { method: 'GET', headers: {} })
    return { status: r.status }
  }
}

export const PAGESPEED_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'

/** PageSpeed Insights 那一口（手机端、只要性能那一项）。读不到就抛。 */
export function pageSpeedReader(
  doFetch: (
    url: string,
    init: { signal: AbortSignal },
  ) => Promise<{
    ok: boolean
    json(): Promise<unknown>
  }>,
): (url: string) => Promise<unknown> {
  return async (url) => {
    const q = new URLSearchParams({ url, strategy: 'mobile', category: 'performance' })
    const res = await doFetch(`${PAGESPEED_ENDPOINT}?${q.toString()}`, {
      signal: AbortSignal.timeout(PAGESPEED_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error('pagespeed_unavailable')
    return res.json()
  }
}
