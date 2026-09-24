/**
 * WP140（docs/78 内测前走查的 demo 那几条）：
 *
 * - 云账号那一跳在 demo 里是替身：发登录信 → 已关联（余额、价目三块、充值四档），
 *   **整个 demo 进程没有一次请求打到 cloud.agentsws.com**（全局 fetch 换成记录器）；
 */
import { resolve } from 'node:path'
import type { CloudAccountView } from '@agentsws/api'
import type { CloudCreditsView, TopupTiers } from '@agentsws/contracts'
import { CLOUD_STAND_IN_BASE_URL } from '@agentsws/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDemo, type Demo } from '../src/demo.js'

const ROOT = resolve(import.meta.dirname, '../../..')

let demo: Demo
let base: string
const outbound: string[] = []

const call = async (
  path: string,
  init: { method?: string; body?: unknown; assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers({
    Authorization: `Bearer ${demo.server.bootstrap.internalToken}`,
  })
  headers.set('X-Assignment', init.assignment ?? demo.server.bootstrap.ownerAssignment.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
}

const data = async <T>(res: Response): Promise<T> => {
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

beforeAll(async () => {
  const realFetch = globalThis.fetch
  // 这个进程里每一次真出站都记下来；只放行本机回环口
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    outbound.push(target)
    const host = new URL(target).hostname
    if (host !== '127.0.0.1' && host !== 'localhost') throw new Error(`demo 里不许出网：${target}`)
    return realFetch(input, init)
  })
  demo = await createDemo({
    root: ROOT,
    quiet: true,
    staticDir: resolve(ROOT, 'apps/workstation/dist'),
    cloudAutoLinkAfterMs: 0,
  })
  base = (await demo.server.listen(0)).url
}, 60_000)

afterAll(async () => {
  await demo.close()
  vi.restoreAllMocks()
})

describe('WP140 demo 的云账号替身', () => {
  it('发登录信 → 信发出去了 → 已关联：余额、价目、充值四档都有；没有一次打到生产云', async () => {
    const before = await data<CloudAccountView>(await call('/v1/cloud/account'))
    expect(before.linked).toBe(false)
    expect(before.cloud_base_url).toBe(CLOUD_STAND_IN_BASE_URL)

    const sent = await data<{ delivered: string }>(
      await call('/v1/cloud/account/link', {
        method: 'POST',
        body: { email: 'tester@example.com' },
      }),
    )
    expect(sent.delivered).toBe('email')
    await demo.cloud.settled()

    expect((await data<CloudAccountView>(await call('/v1/cloud/account'))).linked).toBe(true)
    const credits = await data<CloudCreditsView>(await call('/v1/cloud/credits'))
    expect(credits.linked).toBe(true)
    expect(credits.balance?.available).toBeGreaterThan(0)
    const tiers = await data<TopupTiers>(await call('/v1/cloud/topup/tiers'))
    expect(tiers.tiers).toHaveLength(4)

    expect(demo.cloud.requests().some((r) => r.url.endsWith('/v1/cloud/auth/magic-link'))).toBe(
      true,
    )
    expect(outbound.some((u) => u.includes('cloud.agentsws.com'))).toBe(false)
    expect(outbound.every((u) => new URL(u).hostname === '127.0.0.1')).toBe(true)
  })
})
