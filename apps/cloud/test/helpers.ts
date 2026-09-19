/** 云侧测试的共用装配：可推的钟、可捕获的邮件、内存库。 */

import type { CloudRoute } from '@agentsws/api'
import type { Clock } from '@agentsws/contracts'
import {
  type CloudMail,
  type CloudServer,
  createCloudServer,
  type MailSender,
  type SignupBonusHooks,
} from '../src/index.js'

export interface TestClock extends Clock {
  advance(ms: number): void
  set(iso: string): void
}

export function testClock(start = '2026-09-15T00:00:00.000Z'): TestClock {
  let at = Date.parse(start)
  return {
    now: () => new Date(at).toISOString(),
    advance: (ms) => {
      at += ms
    },
    set: (iso) => {
      at = Date.parse(iso)
    },
  }
}

/** 一次 HTTP 调用；`headers` 给的是原样的头（WP110 的限流按 `X-Forwarded-For` 认来源）。 */
export interface CallInit {
  method?: string
  body?: unknown
  token?: string
  headers?: Record<string, string>
}

export interface RawResponse {
  status: number
  text: string
  headers: Headers
}

export interface Harness {
  server: CloudServer
  clock: TestClock
  /** 发出去的信（登录链接在 `text` 里）。 */
  mails: CloudMail[]
  /** 最近一封信里的那条链接。 */
  lastLink(): string
  call(
    path: string,
    init?: CallInit,
  ): Promise<{
    status: number
    body: { data?: unknown; code?: string; message?: string }
    headers: Headers
  }>
  /** 不解析 JSON 的那一档（网页那两页是 HTML）。 */
  raw(path: string, init?: CallInit): Promise<RawResponse>
  close(): Promise<void>
}

export interface HarnessOptions {
  clock?: TestClock
  /** 额外挂的路由包（WP110 的 admin 就走这条）。 */
  modules?: CloudRoute[][]
  /** 换一个投递实现（默认是往 `mails` 里推）。 */
  mail?: MailSender
  /** 覆盖环境变量（默认只有 `AGENTSWS_CLOUD_BASE_URL`）。 */
  env?: Record<string, string | undefined>
  /**
   * WP121（70 §2）：注册赠送的两个口。
   *
   * **默认不给 = 这个 harness 不送**，所以 WP110 / WP114 那些既有用例的钱一分
   * 没变；要验赠送的用例自己把口交进来。
   */
  signupBonus?: SignupBonusHooks
}

export function harness(options: HarnessOptions = {}): Harness {
  const clock = options.clock ?? testClock()
  const mails: CloudMail[] = []
  const server = createCloudServer({
    clock,
    quiet: true,
    env: { AGENTSWS_CLOUD_BASE_URL: 'https://cloud.example.test', ...options.env },
    mail:
      options.mail ??
      (async (mail) => {
        mails.push(mail)
      }),
    ...(options.modules === undefined ? {} : { modules: options.modules }),
    ...(options.signupBonus === undefined ? {} : { signupBonus: options.signupBonus }),
  })
  const fetchOnce = async (path: string, init: CallInit = {}): Promise<RawResponse> => {
    const headers = new Headers(init.headers ?? {})
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    if (init.token !== undefined) headers.set('Authorization', `Bearer ${init.token}`)
    const res = await server.fetch(
      new Request(`http://cloud.test${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    )
    return { status: res.status, text: await res.text(), headers: res.headers }
  }
  return {
    server,
    clock,
    mails,
    lastLink(): string {
      const last = mails.at(-1)
      if (last === undefined) throw new Error('还没发过信')
      const match = /https?:\/\/\S+/.exec(last.text)
      if (match === null) throw new Error('信里没有链接')
      return match[0]
    },
    async call(path, init = {}) {
      const res = await fetchOnce(path, init)
      return {
        status: res.status,
        body: res.text === '' ? {} : (JSON.parse(res.text) as { data?: unknown }),
        headers: res.headers,
      }
    },
    raw: fetchOnce,
    close: () => server.close(),
  }
}

/** 走一遍完整登录：发信 → 从链接里取 token → 换会话。 */
export async function login(h: Harness, email: string): Promise<{ session: string; org: string }> {
  await h.call('/v1/cloud/auth/magic-link', {
    method: 'POST',
    body: { email, callback_url: 'http://127.0.0.1:3000/v1/cloud/account/callback' },
  })
  const token = new URL(h.lastLink()).searchParams.get('token')
  if (token === null) throw new Error('链接里没有 token')
  const verified = await h.call('/v1/cloud/auth/verify', { method: 'POST', body: { token } })
  const data = verified.body.data as { session_token: string; org: { id: string } }
  return { session: data.session_token, org: data.org.id }
}
