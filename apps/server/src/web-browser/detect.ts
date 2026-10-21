/**
 * WP353：一页开回来，是不是被拦了（纯函数，测试直接钉）。只认，不绕：认出来就照实说、换下一路。
 *
 * WP454（docs/110 §2.2）：Google 的两种「不是结果页、也不算被拦」的页面也在这里认（只认 Google 的地址）：
 * - `interstitial`：过渡页（没 cookie 的新浏览器第一次搜会先拿到；脚本跑完再带 `sei=` 请求一次才是结果页）——
 *   只记「没出结果（过渡页）」、换下一路；**不计被拦次数、不暂停、不亮给人**；
 * - `consent`：cookie 同意页（`consent.google.*`）——要人选一次，**AI 不点**，亮给人。
 */
import type { OpenResult, PageSignals } from './channel.js'

export type BlockKind =
  | 'captcha'
  | 'login'
  | 'rate_limited'
  | 'blocked'
  | 'interstitial'
  | 'consent'

export interface Block {
  kind: BlockKind
  message: string
}

const CAPTCHA_TEXT = [
  'unusual traffic',
  'not a robot',
  'are you a robot',
  'verify you are human',
  'verify you are a human',
  'prove you are human',
  "prove you're human",
  'complete the security check',
  '人机验证',
  '异常流量',
]
const BLOCK_TEXT = ['access denied', "you've been blocked", 'you have been blocked']
/** Google 过渡页上的那两句（小写；`signals.text` 已经是小写）。 */
const INTERSTITIAL_TEXT = [
  'not redirected within a few seconds',
  "if you're having trouble accessing google search",
  'having trouble accessing google search',
]
const isGoogleHost = (host: string): boolean =>
  /(^|\.)google\.(com|[a-z]{2})(\.[a-z]{2})?$/u.test(host.toLowerCase())

const LOGIN_PATHS = [
  /^\/login\b/u,
  /^\/signin\b/u,
  /^\/authwall\b/u,
  /^\/uas\/login\b/u,
  /^\/checkpoint\b/u,
]
const LOGIN_TEXT = [
  'sign in to continue',
  'log in to continue',
  'join now to see',
  'sign in to view',
  'log in to view',
]

/** 一页开回来（`ok: true` 的那种）是不是被拦了；没被拦回 `undefined`。 */
export function blockOf(res: Extract<OpenResult, { ok: true }>): Block | undefined {
  let path = ''
  let host = ''
  try {
    const u = new URL(res.final_url)
    path = u.pathname
    host = u.hostname
  } catch {}
  const signals: PageSignals | undefined = res.serp?.signals ?? res.page?.signals
  if (isGoogleHost(host) && host.toLowerCase().startsWith('consent.'))
    return { kind: 'consent', message: 'Google 要你选一次 cookie 设置' }
  if (path.startsWith('/sorry')) return { kind: 'captcha', message: '要人机验证' }
  if (res.status === 429) return { kind: 'rate_limited', message: '说请求太多了（429）' }
  const text = signals?.text ?? ''
  // 结果页里的摘要、帖子正文也可能带这些字——只有一条结果都没认出来 / 正文很短时才按文字认
  const empty =
    res.serp !== undefined ? res.serp.items.length === 0 : (res.page?.text.length ?? 0) < 800
  if (signals?.captcha === true && empty) return { kind: 'captcha', message: '要人机验证' }
  if (
    empty &&
    isGoogleHost(host) &&
    (signals?.interstitial === true || INTERSTITIAL_TEXT.some((t) => text.includes(t)))
  )
    return { kind: 'interstitial', message: '没出结果（过渡页）' }
  if (empty && CAPTCHA_TEXT.some((t) => text.includes(t)))
    return { kind: 'captcha', message: '要人机验证' }
  if (res.status === 403 || (empty && BLOCK_TEXT.some((t) => text.includes(t))))
    return { kind: 'blocked', message: '拦下了这次访问' }
  if (res.page !== undefined) {
    const loginPath = LOGIN_PATHS.some((re) => re.test(path))
    const wall =
      (signals?.passwordInputs ?? 0) > 0 && res.page.text.length < 1500
        ? true
        : LOGIN_TEXT.some((t) => text.includes(t)) && res.page.text.length < 3000
    if (loginPath || wall) return { kind: 'login', message: '要登录才能看' }
  }
  return undefined
}
