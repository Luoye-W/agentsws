/**
 * WP244（Fable 10-07 Windows 真机 ci.10）：在 Rollout 下读一家**刚开的 Shopify 空店**。
 *
 * 钉住：
 * 1. 分析结果标 `fresh_store`，品牌名 / 一句话不填（不是「My Store」），平台照认；
 * 2. 「看着没问题」之后：Rollout 的品牌名不变成 My Store；Shopify 默认生成的隐私政策**不进知识库**；
 * 3. 第 ② 步确认过之后 `state.business_done`（向导重开时从第 ③ 步接着走）；之前没有。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PageFetch } from '@agentsws/brand-intake'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const SHOP = 'https://rollout.example'
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/brand-intake/test/fixtures',
)
const page = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

/** Shopify 默认店：首页 + 那份自动生成的隐私政策；别的一律 404。 */
const freshShop: PageFetch = async (url) => {
  const body =
    url === `${SHOP}/`
      ? page('fresh-home.html')
      : url === `${SHOP}/policies/privacy-policy`
        ? page('fresh-privacy.html')
        : undefined
  return body === undefined
    ? { ok: false, status: 404, text: async () => '' }
    : { ok: true, status: 200, text: async () => body }
}

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

async function boot(): Promise<Server> {
  let t = Date.parse('2026-10-07T09:00:00.000Z')
  const server = await createServer({
    clock: {
      now: () => {
        t += 1
        return new Date(t).toISOString()
      },
    },
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_WORKSPACE_NAME: 'INMO' },
    mdns: () => ({ reason: '测试里不开局域网' }),
    brandIntakeFetch: freshShop,
  })
  servers.push(server)
  return server
}

interface Who {
  token: string
  assignment: string
  workspace_id: string
}

async function call<T>(
  server: Server,
  who: Who,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data?: T; message?: string }> {
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers: new Headers({
        Authorization: `Bearer ${who.token}`,
        'X-Assignment': who.assignment,
        'content-type': 'application/json',
      }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const parsed = (await res.json()) as { data?: T; message?: string }
  return {
    status: res.status,
    ...(parsed.data === undefined ? {} : { data: parsed.data }),
    ...(parsed.message === undefined ? {} : { message: parsed.message }),
  }
}

const inmoOf = (server: Server): Who => ({
  token: server.bootstrap.internalToken,
  assignment: server.bootstrap.ownerAssignment.id,
  workspace_id: server.bootstrap.workspace.id,
})

async function rolloutOf(server: Server): Promise<Who> {
  const inmo = inmoOf(server)
  await call(server, inmo, 'PUT', '/v1/workspace/profile', {
    legal_name: 'INMO',
    brand_name: 'INMO',
    storefront_platform: 'shopify',
  })
  const org = (await call<{ id: string }[]>(server, inmo, 'GET', '/v1/orgs')).data?.[0]?.id ?? ''
  const created = await call<{ workspace_id: string }>(
    server,
    inmo,
    'POST',
    `/v1/orgs/${org}/brands`,
    { name: 'Rollout' },
  )
  const workspace_id = created.data?.workspace_id ?? ''
  const switched = await call<{ session_token?: string }>(
    server,
    inmo,
    'POST',
    `/v1/orgs/${org}/brands/${workspace_id}/switch`,
  )
  const assignment = server.roles.assignments
    .listByPerson(server.bootstrap.person.id, { workspace_id })
    .find((a) => a.revoked_at === undefined)
  return {
    token: switched.data?.session_token ?? '',
    assignment: assignment?.id ?? '',
    workspace_id,
  }
}

interface Run {
  id: string
  status: string
  fresh_store?: boolean
  profile: Record<string, { value: unknown } | undefined>
}

interface State {
  needs_setup: boolean
  brand_name: string
  business_done?: true
}

describe('WP244 在 Rollout 下读一家刚开的 Shopify 空店', () => {
  it('认出空店：不填 My Store；确认后品牌名不变、默认政策不进知识库；第 ② 步记成做过', async () => {
    const server = await boot()
    const rollout = await rolloutOf(server)
    const before = (await call<State>(server, rollout, 'GET', '/v1/onboarding/state')).data
    expect(before?.needs_setup).toBe(true)
    expect(before?.business_done).toBeUndefined()

    const started = await call<Run>(server, rollout, 'POST', '/v1/brand-intake/runs', {
      urls: [`${SHOP}/`],
    })
    let run: Run | undefined
    for (let i = 0; i < 200; i++) {
      run = (await call<Run>(server, rollout, 'GET', `/v1/brand-intake/runs/${started.data?.id}`))
        .data
      if (run?.status !== 'running') break
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(run?.status).toBe('awaiting_confirm')
    expect(run?.fresh_store).toBe(true)
    expect(run?.profile.brand_name).toBeUndefined()
    expect(run?.profile.one_liner).toBeUndefined()
    expect(run?.profile.policies).toBeUndefined()
    expect(run?.profile.storefront_platform?.value).toBe('shopify')

    const confirmed = await call<Run>(
      server,
      rollout,
      'POST',
      `/v1/brand-intake/runs/${run?.id}/confirm`,
      {},
    )
    expect(confirmed.status, confirmed.message).toBe(200)

    const after = (await call<State>(server, rollout, 'GET', '/v1/onboarding/state')).data
    expect(after?.brand_name).toBe('Rollout')
    expect(after?.business_done).toBe(true)

    // 知识库里没有那份默认隐私政策（也没有任何带 My Store 的条目）
    const cards =
      (await call<unknown[]>(server, rollout, 'GET', '/v1/knowledge/cards?status=proposed')).data ??
      []
    expect(JSON.stringify(cards)).not.toContain('My Store')
    expect(JSON.stringify(cards)).not.toMatch(/privacy/i)
  })
})
