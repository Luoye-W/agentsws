/**
 * WP353：一页开回来，是不是被拦了（纯函数，测试直接钉）。只认，不绕：认出来就照实说、换下一路。
 */
import type { OpenResult, PageSignals } from './channel.js'

export type BlockKind = 'captcha' | 'login' | 'rate_limited' | 'blocked'

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
  try {
    path = new URL(res.final_url).pathname
  } catch {}
  const signals: PageSignals | undefined = res.serp?.signals ?? res.page?.signals
  if (path.startsWith('/sorry')) return { kind: 'captcha', message: '要人机验证' }
  if (res.status === 429) return { kind: 'rate_limited', message: '说请求太多了（429）' }
  const text = signals?.text ?? ''
  // 结果页里的摘要、帖子正文也可能带这些字——只有一条结果都没认出来 / 正文很短时才按文字认
  const empty =
    res.serp !== undefined ? res.serp.items.length === 0 : (res.page?.text.length ?? 0) < 800
  if (signals?.captcha === true && empty) return { kind: 'captcha', message: '要人机验证' }
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
