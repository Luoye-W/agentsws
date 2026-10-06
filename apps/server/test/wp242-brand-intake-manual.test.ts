/**
 * WP242：第 ② 步网站读不到时**就地手填**品牌资料（Fable 10-06：卡在 0 页时只给「之后去设置里填」）。
 *
 * 钉住：
 * 1. 被拦（429）时那一句带状态码，并给「换个网址再读 / 就在下面手动填」两条路；
 * 2. `POST /v1/brand-intake/manual`：品牌名、一句话、客服邮箱、币种、市场——与「看着没问题」同一条写法，
 *    写的是**这个品牌**（Rollout），INMO 一个字节不动；走过就不再要设置；
 * 3. 一格都没填 / 邮箱不像邮箱 → 400。
 */
import type { PageFetch } from '@agentsws/brand-intake'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const SHOP = 'https://rollout.example'

/** 店铺对脚本一律 429（真机上从 Windows / Mac 直接 curl 都是这样）。 */
const blocked: PageFetch = async () => ({ ok: false, status: 429, text: async () => '' })

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

async function boot(): Promise<Server> {
  let t = Date.parse('2026-10-06T09:00:00.000Z')
  const server = await createServer({
    clock: { now: () => new Date((t += 1)).toISOString() },
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_WORKSPACE_NAME: 'INMO' },
    mdns: () => ({ reason: '测试里不开局域网' }),
    brandIntakeFetch: blocked,
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
  const headers = new Headers({
    Authorization: `Bearer ${who.token}`,
    'X-Assignment': who.assignment,
    'content-type': 'application/json',
  })
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
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
  const set = await call(server, inmo, 'PUT', '/v1/workspace/profile', {
    legal_name: 'INMO',
    brand_name: 'INMO',
    storefront_platform: 'shopify',
  })
  expect(set.status).toBe(200)
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
  failure?: string
  failure_kind?: string
  profile: Record<string, { value: unknown; edited?: boolean } | undefined>
}

interface State {
  needs_setup: boolean
  brand_name: string
  profile?: { markets?: string[] }
}

describe('WP242 第 ② 步读不到网站：说清楚 + 就地手填', () => {
  it('429：一句带状态码的人话，给「换个网址再读 / 手动填」', async () => {
    const server = await boot()
    const rollout = await rolloutOf(server)
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
    expect(run?.status).toBe('failed')
    expect(run?.failure_kind).toBe('blocked')
    expect(run?.failure).toContain('拦了自动读取（429）')
    expect(run?.failure).toContain('换个网址再读')
    expect(run?.failure).toContain('手动填')
  })

  it('就地手填：写进 Rollout（品牌名、市场），INMO 不动；走过就不再要设置', async () => {
    const server = await boot()
    const rollout = await rolloutOf(server)
    const inmoBefore = server.onboarding.brandProfile(server.bootstrap.workspace.id)
    const out = await call<Run>(server, rollout, 'POST', '/v1/brand-intake/manual', {
      edits: {
        brand_name: 'Rollout Outdoors',
        one_liner: '户外滑板与配件',
        support_email: 'support@rollout.example',
        currency: 'usd',
        markets: ['US', 'CA'],
      },
    })
    expect(out.status, out.message).toBe(201)
    expect(out.data?.status).toBe('confirmed')
    expect(out.data?.profile.currency?.value).toBe('USD')
    expect(out.data?.profile.one_liner?.edited).toBe(true)

    const r = (await call<State>(server, rollout, 'GET', '/v1/onboarding/state')).data
    expect(r?.brand_name).toBe('Rollout Outdoors')
    expect(r?.needs_setup).toBe(false)
    expect(server.onboarding.brandProfile(rollout.workspace_id as never).markets).toEqual([
      'US',
      'CA',
    ])
    // INMO：品牌名、档案、公司全称都没变
    const i = (await call<State>(server, inmoOf(server), 'GET', '/v1/onboarding/state')).data
    expect(i?.brand_name).toBe('INMO')
    expect(server.onboarding.brandProfile(server.bootstrap.workspace.id)).toEqual(inmoBefore)
    expect(server.onboarding.companyProfile()?.legal_name).toBe('INMO')
    // 最近那一次就是这条（回到这一步时按它恢复现场）
    const latest = await call<Run>(server, rollout, 'GET', '/v1/brand-intake/runs/latest')
    expect(latest.data?.id).toBe(out.data?.id)
  })

  it('一格都没填 / 邮箱不像邮箱：400', async () => {
    const server = await boot()
    const rollout = await rolloutOf(server)
    expect(
      (await call(server, rollout, 'POST', '/v1/brand-intake/manual', { edits: {} })).status,
    ).toBe(400)
    expect(
      (
        await call(server, rollout, 'POST', '/v1/brand-intake/manual', {
          edits: { support_email: 'not-an-email' },
        })
      ).status,
    ).toBe(400)
  })
})
