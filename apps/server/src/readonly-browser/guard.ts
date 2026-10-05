/**
 * WP228：只读浏览器的两道闸——**在驱动层判，不靠提示词**。
 *
 * 1. {@link requestVerdict}：浏览器发出的每一个请求都先过这里。只放「白名单站点上的 GET 页面」，
 *    其余一律掐掉：POST / PUT / DELETE（提交表单、点赞、评论都走这些）、白名单外的站、
 *    图片 / 样式 / 脚本 / 字体（读文字用不着，还省流量、少留痕）。页面脚本本来就关着
 *    （`javaScriptEnabled: false`），这一道是第二道。
 * 2. {@link detectWall}：页面开回来先看是不是被拦了——429、验证码、网络安全拦截页、登录墙、
 *    跳去白名单外的站。是就**停下照实说**，不绕、不换身份、不重试。
 *
 * 两个都是纯函数，测试直接钉。
 */
import { hostAllowed } from '@agentsws/contracts'

export interface GuardRequest {
  method: string
  url: string
  /** Chrome 的资源类型（`document` / `stylesheet` / `image` / `script` / `xhr` …）。 */
  resourceType: string
}

export type RequestVerdict = { allow: true } | { allow: false; why: string }

/** 网址的主机名；解析不了回空串（空串过不了任何白名单）。 */
export function hostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : ''
  } catch {
    return ''
  }
}

/** 这个请求放不放。只放白名单站点上的 GET 页面（含 iframe 的页面）。 */
export function requestVerdict(req: GuardRequest, allowedHosts: readonly string[]): RequestVerdict {
  const method = req.method.toUpperCase()
  if (method !== 'GET') return { allow: false, why: `只读：不发 ${method} 请求` }
  if (req.resourceType !== 'document')
    return { allow: false, why: `只读文字：不取 ${req.resourceType}` }
  const host = hostOf(req.url)
  if (!hostAllowed(host, allowedHosts))
    return { allow: false, why: `${host || req.url} 不在白名单里` }
  return { allow: true }
}

/** 页面里收集到的几样迹象（由页面里那段只读脚本数出来）。 */
export interface PageSignals {
  title: string
  /** 页面正文开头一截（小写），用来认拦截页的几句话。 */
  text: string
  passwordInputs: number
  /** 页面里 iframe / script 的地址（认验证码用）。 */
  frameSources: string[]
  /** 认得出的帖子 / 评论有几条。 */
  items: number
}

export type WallKind = 'rate_limited' | 'captcha' | 'blocked' | 'login' | 'off_site'

export interface Wall {
  kind: WallKind
  message: string
}

const CAPTCHA_SOURCES = [
  'recaptcha',
  'hcaptcha',
  'challenges.cloudflare.com',
  'arkoselabs',
  'funcaptcha',
  'captcha',
]
const CAPTCHA_TEXT = [
  'verify you are human',
  "prove you're human",
  'prove you are human',
  'are you a robot',
  'complete the captcha',
  '人机验证',
]
const BLOCK_TEXT = [
  "you've been blocked by network security",
  'you have been blocked',
  'whoa there, pardner',
  'too many requests',
  'access denied',
]
const LOGIN_PATHS = [/^\/login\b/u, /^\/account\/login\b/u, /^\/register\b/u, /^\/signin\b/u]
const LOGIN_TEXT = [
  'log in to continue',
  'log in to view',
  'you must be logged in',
  'sign in to continue',
  'log in to see',
  'over 18',
  'mature content',
]

/**
 * 开回来的这一页是不是被拦了。`status` 是主文档的 HTTP 状态码；`finalUrl` 是跟完跳转之后的地址。
 * 认不出拦截就回 `undefined`（再交给解析器看认不认得出内容）。
 */
export function detectWall(input: {
  status: number
  finalUrl: string
  allowedHosts: readonly string[]
  signals?: PageSignals
}): Wall | undefined {
  const host = hostOf(input.finalUrl)
  if (!hostAllowed(host, input.allowedHosts))
    return {
      kind: 'off_site',
      message: `页面跳去了白名单外的站（${host || input.finalUrl}），已停下。`,
    }
  if (input.status === 429)
    return { kind: 'rate_limited', message: '站点说请求太多了（429），已停下，过一会儿再取。' }
  const s = input.signals
  const text = s?.text ?? ''
  const frames = (s?.frameSources ?? []).map((f) => f.toLowerCase())
  if (
    frames.some((f) => CAPTCHA_SOURCES.some((c) => f.includes(c))) ||
    CAPTCHA_TEXT.some((t) => text.includes(t))
  )
    return { kind: 'captcha', message: '页面要做人机验证，我们不绕，已停下。' }
  if (input.status === 403 || BLOCK_TEXT.some((t) => text.includes(t)))
    return { kind: 'blocked', message: '站点拦下了这次访问，已停下，不换身份重试。' }
  let path = ''
  try {
    path = new URL(input.finalUrl).pathname
  } catch {}
  const loginPage = LOGIN_PATHS.some((re) => re.test(path))
  const loginWall =
    (s?.items ?? 0) === 0 &&
    ((s?.passwordInputs ?? 0) > 0 || LOGIN_TEXT.some((t) => text.includes(t)))
  if (loginPage || loginWall)
    return { kind: 'login', message: '这一页要登录才能看。只读浏览器不登录任何账号，已停下。' }
  // 别的 4xx / 5xx（版不存在、站点出错）不算被拦：这一次没取到，照实说，不暂停这一路
  return undefined
}
