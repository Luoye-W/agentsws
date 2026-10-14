/**
 * 被拦了没有（与 `apps/server/src/readonly-browser/guard.ts` 的 `detectWall` 同一套认法，
 * 搬了一份不带 node 依赖的过来给插件用）。
 *
 * 认出来就**停下照实说**：不绕、不换身份、不重试（决策 555「被拦就停」）。
 */

export type WallKind = 'captcha' | 'login' | 'blocked' | 'off_site'

export interface PageLook {
  url: string
  title: string
  /** 页面正文开头一截（小写由这里自己做）。 */
  text: string
  /** 页面里 iframe / script 的地址（认验证码用）。 */
  frameSources: readonly string[]
  passwordInputs: number
}

const CAPTCHA_SOURCES = [
  'recaptcha',
  'hcaptcha',
  'challenges.cloudflare.com',
  'arkoselabs',
  'funcaptcha',
]
const CAPTCHA_TEXT = [
  'verify you are human',
  "prove you're human",
  'prove you are human',
  'are you a robot',
  'complete the captcha',
  "confirm it's you",
  'confirm it’s you',
  '人机验证',
  '确认是您本人',
]
const BLOCKED_TEXT = [
  'unusual activity',
  'temporarily blocked',
  "you're temporarily blocked",
  'too many requests',
  'automated queries',
  'your account has been restricted',
  '异常活动',
  '暂时被阻止',
]
const LOGIN_HOSTS = [/^accounts\.google\.com$/iu, /^(www\.|m\.)?facebook\.com$/iu]
const LOGIN_PATH = /\/(login|signin|servicelogin|checkpoint)\b/iu

export function detectPageWall(look: PageLook): { kind: WallKind; message: string } | undefined {
  const text = `${look.title}\n${look.text}`.toLowerCase()
  if (
    look.frameSources.some((s) => CAPTCHA_SOURCES.some((c) => s.toLowerCase().includes(c))) ||
    CAPTCHA_TEXT.some((t) => text.includes(t))
  )
    return {
      kind: 'captcha',
      message: '后台要你做一次验证（验证码 / 确认身份）。已停下，请你自己处理。',
    }
  if (BLOCKED_TEXT.some((t) => text.includes(t)))
    return { kind: 'blocked', message: '后台说操作太频繁或账户受限。已停下，今天不再动它。' }
  let host = ''
  let path = ''
  try {
    const u = new URL(look.url)
    host = u.hostname
    path = u.pathname
  } catch {}
  if (look.passwordInputs > 0 || (LOGIN_HOSTS.some((h) => h.test(host)) && LOGIN_PATH.test(path)))
    return {
      kind: 'login',
      message: '广告后台没登录（或登录掉了）。请你在这个标签页里登录，再让它接着做。',
    }
  return undefined
}
