/**
 * WP428（决策 1246 改）：聊天窗设置里「有把握就直接答」缺省开 +「严格 / 适中 / 宽松」，真服务打 HTTP。
 */
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

let server: Server
let url: string
let ownerAsg: Assignment

const owner = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', ownerAsg.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}

beforeEach(async () => {
  server = await createServer({
    quiet: true,
    env: { AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
  })
  url = (await server.listen(0)).url
  ownerAsg = server.bootstrap.ownerAssignment
})

afterEach(async () => {
  await server.close()
})

type Settings = { auto_answer?: boolean; auto_answer_strictness?: string }

const read = async (): Promise<Settings> =>
  ((await (await owner('/v1/chat/widget/settings')).json()) as { data: Settings }).data

const put = async (body: Record<string, unknown>): Promise<Response> =>
  owner('/v1/chat/widget/settings', {
    method: 'PUT',
    body: JSON.stringify({ allowed_origins: [], ...body }),
  })

describe('WP428 聊天窗设置：按把握直接答', () => {
  it('缺省开（没有关掉那一格）、适中档；关了才存 false；只改外观不动它', async () => {
    const first = await read()
    expect(first.auto_answer).not.toBe(false)
    expect(first.auto_answer_strictness).toBeUndefined()

    expect((await put({ auto_answer: false })).status).toBe(200)
    expect((await read()).auto_answer).toBe(false)
    // 只改外观（没带这一格）= 保持原样
    expect((await put({ greeting: '在的' })).status).toBe(200)
    expect((await read()).auto_answer).toBe(false)

    expect((await put({ auto_answer: true, auto_answer_strictness: 'strict' })).status).toBe(200)
    const after = await read()
    expect(after.auto_answer).not.toBe(false)
    expect(after.auto_answer_strictness).toBe('strict')
  })

  it('档位只认三种（不让人填数字）', async () => {
    expect((await put({ auto_answer_strictness: 0.7 })).status).toBe(400)
    expect((await put({ auto_answer_strictness: 'whatever' })).status).toBe(400)
  })
})
