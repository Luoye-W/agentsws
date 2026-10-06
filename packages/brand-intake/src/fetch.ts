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

/**
 * 只取公开页面的 GET。测试塞夹具，生产塞 `globalThis.fetch`。
 *
 * WP240：回执上多一个可选的 `url`（跟完跳转之后落在哪）——Shopify 开着访问密码的店会把
 * 每一页都 302 到 `/password`，看落点是认出它最准的一招。夹具不给也行（再看页面内容）。
 */
export type PageFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; url?: string; text(): Promise<string> }>

/** WP240：读不到的是哪一种（与契约里的 `BrandIntakeFailureKind` 同一组值）。 */
export type FetchFailureKind = 'blocked' | 'dns' | 'timeout' | 'unreachable'

export const BRAND_INTAKE_USER_AGENT =
  'agentsws-brand-intake/1.0 (+https://github.com/Luoye-W/agentsws)'

export const BRAND_INTAKE_TIMEOUT_MS = 10_000

/** WP240：robots.txt 等多久（读不到就按"没有规则"走，不该把首页也拖住）。 */
export const ROBOTS_TIMEOUT_MS = 5_000

/** 一页最多读多少字符。再多也不会让第一版档案更准，只会让模型那一步更贵。 */
export const MAX_PAGE_CHARS = 400_000

export interface FetchedPage {
  url: string
  ok: boolean
  status: number
  html: string
  /** 没拿到的时候那一句人话。 */
  reason?: string
  /** WP240：没拿到的是哪一种（界面按它给下一步）。 */
  failure_kind?: FetchFailureKind
  /** WP240：跟完跳转之后落在哪（抓取口给了才有）。 */
  final_url?: string
}

/** HTTP 状态码翻成人话。**不说"请求失败"**——那等于没说。 */
function sayStatus(status: number): string {
  if (status === 403) return '对方拒绝了（403）'
  if (status === 404) return '这个页面不存在（404）'
  if (status === 429) return '对方在限流（429），先不抓了'
  // WP242：Shopify 对它认定的机器人回 430（Security Rejection）
  if (status === 430) return '对方的机器人防护拦了（430）'
  if (status === 401) return '要登录才看得到（401）'
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
  options: { timeoutMs?: number; cookie?: string } = {},
): Promise<FetchedPage> {
  const timeoutMs = options.timeoutMs ?? BRAND_INTAKE_TIMEOUT_MS
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: {
        'user-agent': BRAND_INTAKE_USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
        // WP240：只有用户填了店铺访问密码、解开之后才有这一格（只活在这一次抓取里）
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const final = typeof res.url === 'string' && res.url !== '' ? { final_url: res.url } : {}
    if (!res.ok)
      return {
        url,
        ok: false,
        status: res.status,
        html: '',
        reason: sayStatus(res.status),
        ...(BLOCKED_STATUSES.has(res.status) ? { failure_kind: 'blocked' as const } : {}),
        ...final,
      }
    const text = await res.text()
    // WP242：回了 200 但其实是一张「验证你是不是机器人」的页（Cloudflare / 店铺防护）——当被拦
    if (isBotChallengePage(text))
      return {
        url,
        ok: false,
        status: res.status,
        html: '',
        reason: '对方的机器人防护拦了（要人点一下验证）',
        failure_kind: 'blocked',
        ...final,
      }
    return { url, ok: true, status: res.status, html: text.slice(0, MAX_PAGE_CHARS), ...final }
  } catch (err) {
    const kind = failureKindOf(err)
    const message = err instanceof Error ? err.message : String(err)
    return {
      url,
      ok: false,
      status: 0,
      html: '',
      reason:
        kind === 'timeout'
          ? '等太久了，先不抓了'
          : kind === 'dns'
            ? '找不到这个域名（还没解析，或者网址拼错了）'
            : `连不上（${message}${causeCodeOf(err) === undefined ? '' : ` · ${causeCodeOf(err)}`}）`,
      failure_kind: kind,
    }
  }
}

/** WP242：算「被拦」的状态码（429 限流、430 Shopify 机器人防护、401 / 403 拒绝）。 */
const BLOCKED_STATUSES = new Set([401, 403, 429, 430])

/**
 * WP242：这一页是不是「验证你是不是机器人」的那一张（回 200，但内容只是一道验证）。
 * 只认标题：很多正常页面也挂着防护脚本，按脚本认会误伤。
 */
export function isBotChallengePage(html: string): boolean {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html.slice(0, 20_000))?.[1]?.trim() ?? ''
  return /^(just a moment|attention required|access denied|verifying you are human|checking your browser)/i.test(
    title,
  )
}

/** WP242：`fetch failed` 背后的错误码（`ECONNRESET`……）；挖不出回 `undefined`。 */
export function causeCodeOf(err: unknown): string | undefined {
  let cur: unknown = err
  for (let i = 0; i < 5 && cur !== undefined && cur !== null; i++) {
    const code = (cur as { code?: unknown }).code
    if (i > 0 && typeof code === 'string') return code
    const errors = (cur as { errors?: unknown }).errors
    if (Array.isArray(errors) && errors.length > 0) {
      const first = (errors[0] as { code?: unknown } | undefined)?.code
      if (typeof first === 'string') return first
    }
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * WP240：一次抓取抛出来的错误是哪一种。
 *
 * Node 的 `fetch` 抛的是一句笼统的 `fetch failed`，真原因在 `cause.code` 上
 * （`ENOTFOUND` / `EAI_AGAIN` = 域名解析不了）。
 */
export function failureKindOf(err: unknown): FetchFailureKind {
  const codes: string[] = []
  let cur: unknown = err
  for (let i = 0; i < 4 && cur !== undefined && cur !== null; i++) {
    const rec = cur as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown }
    if (typeof rec.code === 'string') codes.push(rec.code)
    if (typeof rec.name === 'string') codes.push(rec.name)
    if (typeof rec.message === 'string') codes.push(rec.message)
    cur = rec.cause
  }
  const all = codes.join(' ')
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(all)) return 'dns'
  if (/abort|timeout|ETIMEDOUT/i.test(all)) return 'timeout'
  return 'unreachable'
}

/**
 * WP240：这一页是不是 Shopify 的「店铺访问密码」页。
 *
 * 开着密码的店，每一页都 302 到 `/password`，回来的是一张只有密码框的页面——
 * 按普通页面去解析，会把密码页上的那几行字当成政策、当成关于我们。认出来就该停下，
 * 照实告诉用户「店铺有访问密码」。
 */
export function isShopifyPasswordPage(html: string, finalUrl?: string): boolean {
  if (finalUrl !== undefined) {
    try {
      if (/\/password\/?$/.test(new URL(finalUrl).pathname)) return true
    } catch {
      // 落点不是个网址：只看内容
    }
  }
  return /value=["']storefront_password["']|class=["'][^"']*\btemplate-password\b|action=["'][^"']*\/password["']/i.test(
    html,
  )
}

/** WP240：提交店铺访问密码那一下用的 POST（不跟跳转，要读回执上的 `set-cookie`）。 */
export type StorefrontPasswordPost = (
  url: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
    redirect: 'manual'
    signal?: AbortSignal
  },
) => Promise<{
  status: number
  headers: { get(name: string): string | null; getSetCookie?: () => string[] }
}>

/**
 * WP240：用店铺访问密码解开一家 Shopify 店，回这一次抓取要带的 cookie；解不开回 `undefined`。
 *
 * 密码**只出现在这一个请求体里**：不进返回值、不进日志、不进异常文案。
 * Shopify 解开之后会种一个 `storefront_digest`——没种上就是密码不对（或者对方要人机验证）。
 */
export async function unlockShopifyStorefront(
  post: StorefrontPasswordPost,
  origin: string,
  password: string,
  options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
  try {
    const body = new URLSearchParams({
      form_type: 'storefront_password',
      utf8: '✓',
      password,
    }).toString()
    const res = await post(`${origin}/password`, {
      method: 'POST',
      headers: {
        'user-agent': BRAND_INTAKE_USER_AGENT,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html,application/xhtml+xml',
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? BRAND_INTAKE_TIMEOUT_MS),
    })
    const raw =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : (res.headers.get('set-cookie') ?? '').split(/,(?=\s*[A-Za-z0-9_-]+=)/)
    const pairs = raw
      .map((line) => line.split(';')[0]?.trim() ?? '')
      .filter((pair) => /^[^=\s]+=/.test(pair))
    if (!pairs.some((pair) => pair.startsWith('storefront_digest='))) return undefined
    return pairs.join('; ')
  } catch {
    return undefined
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
    if (re?.test(pathname) === true) return true
  }
  return false
}

/** 取一个站的 robots（取不到就是"没有规则"，不是"整站不让抓"）。 */
export async function fetchRobots(doFetch: PageFetch, origin: string): Promise<string[]> {
  // WP240：robots 只是"先看一眼规矩"，等它不该等满 10 秒——慢就按没有规则走
  const res = await fetchPage(doFetch, `${origin}/robots.txt`, { timeoutMs: ROBOTS_TIMEOUT_MS })
  return res.ok ? parseRobotsDisallow(res.html) : []
}
