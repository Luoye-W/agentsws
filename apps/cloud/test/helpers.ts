/** 云侧测试的共用装配：可推的钟、可捕获的邮件、内存库。 */

import type { Clock } from '@agentsws/contracts'
import { type CloudMail, type CloudServer, createCloudServer } from '../src/index.js'

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

export interface Harness {
  server: CloudServer
  clock: TestClock
  /** 发出去的信（登录链接在 `text` 里）。 */
  mails: CloudMail[]
  /** 最近一封信里的那条链接。 */
  lastLink(): string
  call(
    path: string,
    init?: { method?: string; body?: unknown; token?: string },
  ): Promise<{ status: number; body: { data?: unknown; code?: string; message?: string } }>
  close(): Promise<void>
}

export function harness(options: { clock?: TestClock } = {}): Harness {
  const clock = options.clock ?? testClock()
  const mails: CloudMail[] = []
  const server = createCloudServer({
    clock,
    quiet: true,
    env: { AGENTSWS_CLOUD_BASE_URL: 'https://cloud.example.test' },
    mail: async (mail) => {
      mails.push(mail)
    },
  })
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
      const headers = new Headers()
      if (init.body !== undefined) headers.set('content-type', 'application/json')
      if (init.token !== undefined) headers.set('Authorization', `Bearer ${init.token}`)
      const res = await server.fetch(
        new Request(`http://cloud.test${path}`, {
          method: init.method ?? 'GET',
          headers,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        }),
      )
      const text = await res.text()
      return {
        status: res.status,
        body: text === '' ? {} : (JSON.parse(text) as { data?: unknown }),
      }
    },
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
