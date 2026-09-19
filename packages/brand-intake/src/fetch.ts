/**
 * 抓取那一口（70 §5）。
 *
 * 与 `@agentsws/model-gateway` 的 `PageFetch` **同一个形状**，理由也同一条：
 * 这是一个只取公开页面、只读 HTML、永远不带凭据的 GET。用完整的 `fetch` 类型
 * 会把 body、redirect、credentials 这些我们不该有的能力也一起交出去。
 *
 * 四条纪律：
 *
 * 1. **不带凭据**。一个 header 都不加，只有 UA 与 Accept。
 * 2. **UA 认得出是我们**。被站长封是他的权利，但他得先知道要封谁。
 * 3. **抓不到就说抓不到**。这一层不抛，回 `{ ok: false, reason }`——一个页面
 *    抓不到不该让整次分析炸掉，而且"关于页 404"本身就是一条要告诉用户的信息。
 * 4. **遵 robots**。`Disallow` 的路径一个都不抓；robots 读不到就按"可以抓"走
 *    （读不到不等于禁止，但读到了就算数）。
 */

/** 只取公开页面的 GET。测试塞夹具，生产塞 `globalThis.fetch`。 */
export type PageFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export const BRAND_INTAKE_USER_AGENT =
  'agentsws-brand-intake/1.0 (+https://github.com/Luoye-W/agentsws)'

export const BRAND_INTAKE_TIMEOUT_MS = 10_000

/** 一页最多读多少字符。再多也不会让第一版档案更准，只会让模型那一步更贵。 */
export const MAX_PAGE_CHARS = 400_000

export interface FetchedPage {
  url: string
  ok: boolean
  status: number
  html: string
  /** 没拿到的时候那一句人话。 */
  reason?: string
}

/** HTTP 状态码翻成人话。**不说"请求失败"**——那等于没说。 */
function sayStatus(status: number): string {
  if (status === 403) return '对方拒绝了（403）'
  if (status === 404) return '这个页面不存在（404）'
  if (status === 429) return '对方在限流（429），先不抓了'
  if (status >= 500) return `对方服务器出错（${String(status)}）`
  return `没取到（${String(status)}）`
}

/**
 * 抓一页。**永不抛。**
 *
 * `AbortSignal.timeout` 而不是自己起一个定时器：超时之后连接真的会断，
 * 而不是我们不等了、对面还在发。
 */
export async function fetchPage(
  doFetch: PageFetch,
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<FetchedPage> {
  const timeoutMs = options.timeoutMs ?? BRAND_INTAKE_TIMEOUT_MS
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { 'user-agent': BRAND_INTAKE_USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok)
      return { url, ok: false, status: res.status, html: '', reason: sayStatus(res.status) }
    const text = await res.text()
    return { url, ok: true, status: res.status, html: text.slice(0, MAX_PAGE_CHARS) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const timedOut = /abort|timeout/i.test(message)
    return {
      url,
      ok: false,
      status: 0,
      html: '',
      reason: timedOut ? '等太久了，先不抓了' : `连不上（${message}）`,
    }
  }
}

/**
 * robots.txt 里针对**我们**的 `Disallow` 路径。
 *
 * 只认 `User-agent: *`——我们不给自己单开一段规则，站长也不会为我们写一段。
 *
 * 通配符**必须整条编译**，不能取第一个 `*` 之前的前缀当前缀匹配：Shopify 的
 * robots 里永远有一条 `/*​/cart/`，按前缀算的话它等于 `/`，于是每一家 Shopify
 * 店都会被判成"整站不让抓"。
 */
export function parseRobotsDisallow(robotsTxt: string): string[] {
  const out: string[] = []
  let applies = false
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (line === '') continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (key === 'user-agent') {
      applies = value === '*'
      continue
    }
    if (key === 'disallow' && applies && value !== '') out.push(value)
  }
  return out
}

/** 一条 `Disallow` 编译成正则（`*` 任意串、`$` 结尾锚）。 */
function compileRule(rule: string): RegExp | undefined {
  try {
    const anchored = rule.endsWith('$')
    const body = anchored ? rule.slice(0, -1) : rule
    const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}${anchored ? '$' : ''}`)
  } catch {
    return undefined
  }
}

/** 这个路径被 robots 拦着吗。 */
export function isDisallowed(pathname: string, disallow: string[]): boolean {
  for (const rule of disallow) {
    const re = compileRule(rule)
    if (re !== undefined && re.test(pathname)) return true
  }
  return false
}

/** 取一个站的 robots（取不到就是"没有规则"，不是"整站不让抓"）。 */
export async function fetchRobots(doFetch: PageFetch, origin: string): Promise<string[]> {
  const res = await fetchPage(doFetch, `${origin}/robots.txt`)
  return res.ok ? parseRobotsDisallow(res.html) : []
}
