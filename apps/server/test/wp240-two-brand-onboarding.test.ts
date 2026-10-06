/**
 * WP240：第二个品牌走首次设置，**一个字节都不许写到第一个品牌身上**。
 *
 * 起因（Fable 10-06，Windows 真机 ci.8）：已有品牌 INMO（启动品牌），新建品牌 Rollout、切过去，
 * `GET /v1/onboarding/state` 回 `brand_name: "INMO"`、`needs_setup: false`。往下查发现首次设置
 * 那一面整个是按启动品牌装的：分析确认写的是启动品牌的档案 / 品牌名 / 知识库，向导建的分配也
 * 落在启动品牌。这一档两个品牌各走一遍首次设置，逐项钉住互不串。
 *
 * 不联网：抓取口是 `@agentsws/brand-intake` 的夹具表。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PageFetch } from '@agentsws/brand-intake'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-06T09:00:00.000Z'

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'brand-intake',
  'test',
  'fixtures',
)
const SHOP = 'https://nordvik.example'
const PAGES: Record<string, string> = {
  [`${SHOP}/robots.txt`]: 'robots.txt',
  [`${SHOP}/`]: 'shop-home.html',
  [`${SHOP}/pages/about`]: 'shop-about.html',
  [`${SHOP}/pages/contact`]: 'shop-contact.html',
  [`${SHOP}/policies/refund-policy`]: 'shop-refund.html',
  [`${SHOP}/policies/shipping-policy`]: 'shop-shipping.html',
  [`${SHOP}/products/granite-wallet`]: 'product-wallet.html',
  [`${SHOP}/products/fjord-tote`]: 'product-tote.html',
}
const replay: PageFetch = async (url) => {
  const name = PAGES[url]
  if (name === undefined) return { ok: false, status: 404, text: async () => '' }
  return { ok: true, status: 200, text: async () => readFileSync(join(FIXTURES, name), 'utf8') }
}

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => {
      t += 1
      return new Date(t).toISOString()
    },
  }
}

function seeded(seed = 11): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

async function boot(): Promise<Server> {
  const server = await createServer({
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_WORKSPACE_NAME: 'INMO' },
    mdns: () => ({ reason: '测试里不开局域网' }),
    brandIntakeFetch: replay,
  })
  servers.push(server)
  return server
}

interface Who {
  workspace_id: string
  token: string
  assignment: string
}

async function call<T>(
  server: Server,
  who: Who,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data?: T; message?: string }> {
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.set('Authorization', `Bearer ${who.token}`)
  headers.set('X-Assignment', who.assignment)
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

function inmo(server: Server): Who {
  return {
    workspace_id: server.bootstrap.workspace.id,
    token: server.bootstrap.internalToken,
    assignment: server.bootstrap.ownerAssignment.id,
  }
}

async function orgId(server: Server): Promise<string> {
  const orgs = await call<{ id: string }[]>(server, inmo(server), 'GET', '/v1/orgs')
  const id = orgs.data?.[0]?.id
  if (id === undefined) throw new Error('启动之后应该有一个组织')
  return id
}

/** 公司页「加一个品牌」（不复制设置）→「切到这个品牌」。 */
async function addBrand(server: Server, name: string): Promise<Who> {
  const org = await orgId(server)
  const created = await call<{ workspace_id: string }>(
    server,
    inmo(server),
    'POST',
    `/v1/orgs/${org}/brands`,
    { name },
  )
  expect(created.status).toBe(201)
  const workspace_id = created.data?.workspace_id ?? ''
  const switched = await call<{ session_token?: string }>(
    server,
    inmo(server),
    'POST',
    `/v1/orgs/${org}/brands/${workspace_id}/switch`,
  )
  const token = switched.data?.session_token ?? ''
  const assignment = server.roles.assignments
    .listByPerson(server.bootstrap.person.id, { workspace_id })
    .find((a) => a.revoked_at === undefined)
  if (assignment === undefined) throw new Error('新品牌里应该自带一条 owner 分配')
  return { workspace_id, token, assignment: assignment.id }
}

interface State {
  needs_setup: boolean
  workspace_name: string
  brand_name: string
  added_brand?: boolean
  profile?: { legal_name: string; brand_name: string; storefront_platform: string }
}

const state = async (server: Server, who: Who): Promise<State> => {
  const res = await call<State>(server, who, 'GET', '/v1/onboarding/state')
  expect(res.status).toBe(200)
  if (res.data === undefined) throw new Error('state 应该有回执')
  return res.data
}

/** 第 ① 步：INMO 首次设置把公司全称填成 INMO（真机上就是这么填的）。 */
async function setUpInmo(server: Server): Promise<void> {
  const res = await call(server, inmo(server), 'PUT', '/v1/workspace/profile', {
    legal_name: 'INMO',
    brand_name: 'INMO',
    storefront_platform: 'shopify',
  })
  expect(res.status).toBe(200)
}

async function analyze(server: Server, who: Who): Promise<string> {
  const started = await call<{ id: string }>(server, who, 'POST', '/v1/brand-intake/runs', {
    urls: [`${SHOP}/`],
  })
  expect(started.status).toBe(201)
  const id = started.data?.id ?? ''
  for (let i = 0; i < 200; i++) {
    const run = await call<{ status: string }>(server, who, 'GET', `/v1/brand-intake/runs/${id}`)
    if (run.data?.status !== 'running') return id
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('分析没跑完')
}

describe('WP240 第二个品牌的首次设置不串品牌', () => {
  it('新建品牌：state 按这个品牌回（品牌名、要不要设置、是不是加的品牌）', async () => {
    const server = await boot()
    await setUpInmo(server)
    const rollout = await addBrand(server, 'Rollout')

    const r = await state(server, rollout)
    expect(r.brand_name).toBe('Rollout')
    expect(r.workspace_name).toBe('Rollout')
    // 建品牌那一刻起的那份影子档案不算"设过"：新品牌要走首次设置
    expect(r.needs_setup).toBe(true)
    expect(r.added_brand).toBe(true)
    // 公司全称照旧是公司的（组织级），品牌名是 Rollout 自己的
    expect(r.profile?.legal_name ?? 'INMO').toBe('INMO')

    const i = await state(server, inmo(server))
    expect(i.brand_name).toBe('INMO')
    expect(i.needs_setup).toBe(false)
    expect(i.added_brand).toBeUndefined()
  })

  it('在 Rollout 下做分析并确认：写的是 Rollout 的档案与知识，INMO 一个字节不动', async () => {
    const server = await boot()
    await setUpInmo(server)
    const before = server.onboarding.brandProfile(server.bootstrap.workspace.id)
    const rollout = await addBrand(server, 'Rollout')

    const run = await analyze(server, rollout)
    const confirmed = await call<{ status: string }>(
      server,
      rollout,
      'POST',
      `/v1/brand-intake/runs/${run}/confirm`,
      {},
    )
    expect(confirmed.status).toBe(200)

    // INMO：品牌名、档案、公司全称都没变
    const i = await state(server, inmo(server))
    expect(i.brand_name).toBe('INMO')
    expect(i.profile?.legal_name).toBe('INMO')
    expect(server.onboarding.brandProfile(server.bootstrap.workspace.id)).toEqual(before)
    // Rollout：平台从站上看出来了，档案是它自己的；品牌名仍是建品牌时起的那个
    const r = await state(server, rollout)
    expect(r.brand_name).toBe('Rollout')
    expect(r.needs_setup).toBe(false)
    expect(server.onboarding.brandProfile(rollout.workspace_id).storefront_platform).toBe('shopify')
    // 公司全称没被分析结果顶掉（公司级的已经有了，加品牌不再问）
    expect(server.onboarding.companyProfile()?.legal_name).toBe('INMO')

    // 知识：首批条目进 Rollout，INMO 那边一条都没有
    const cardsOf = async (who: Who) =>
      (
        await call<{ workspace_id: string }[]>(
          server,
          who,
          'GET',
          '/v1/knowledge/cards?status=proposed',
        )
      ).data ?? []
    const rolloutCards = await cardsOf(rollout)
    expect(rolloutCards.length).toBeGreaterThan(0)
    expect(rolloutCards.every((c) => c.workspace_id === rollout.workspace_id)).toBe(true)
    expect(
      (await cardsOf(inmo(server))).filter((c) => c.workspace_id === rollout.workspace_id),
    ).toEqual([])
    expect(
      (await cardsOf(inmo(server))).some((c) => JSON.stringify(c).includes('brand-intake')),
    ).toBe(false)
  })

  it('在 Rollout 下完成第 ④ 步：分配建在 Rollout，INMO 的分配一条不多', async () => {
    const server = await boot()
    await setUpInmo(server)
    const inmoBefore = server.roles.assignments
      .listByWorkspace(server.bootstrap.workspace.id)
      .filter((a) => a.revoked_at === undefined).length
    const rollout = await addBrand(server, 'Rollout')

    const applied = await call<{
      created_assignments: { id: string }[]
      ranges: { kind: string; id: string; label: string }[]
    }>(server, rollout, 'POST', '/v1/onboarding/apply', {
      position_ids: [],
      role_ids: [],
      positions: [{ name: '客服', role_ids: ['dtc.support'], template_id: 'customer-care' }],
    })
    expect([200, 201]).toContain(applied.status)
    const ids = applied.data?.created_assignments.map((a) => a.id) ?? []
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids)
      expect(server.roles.assignments.get(id)?.workspace_id).toBe(rollout.workspace_id)
    // 没连店就挂整个品牌——挂的是 Rollout，不是 INMO
    expect(applied.data?.ranges).toEqual([
      { kind: 'brand', id: rollout.workspace_id, label: '整个品牌（Rollout）' },
    ])
    expect(
      server.roles.assignments
        .listByWorkspace(server.bootstrap.workspace.id)
        .filter((a) => a.revoked_at === undefined).length,
    ).toBe(inmoBefore)
  })

  it('设置页在 Rollout 下保存：品牌名写 Rollout；公司全称没改就不碰组织', async () => {
    const server = await boot()
    await setUpInmo(server)
    const rollout = await addBrand(server, 'Rollout')
    const org = await orgId(server)
    const orgBefore = server.onboarding.companyProfile()

    const r = await state(server, rollout)
    const saved = await call(server, rollout, 'PUT', '/v1/workspace/profile', {
      legal_name: r.profile?.legal_name ?? 'INMO',
      brand_name: r.brand_name,
      vertical: 'goods',
      storefront_platform: 'shopify',
    })
    expect(saved.status).toBe(200)
    expect((await state(server, rollout)).brand_name).toBe('Rollout')
    expect((await state(server, inmo(server))).brand_name).toBe('INMO')
    expect(server.onboarding.companyProfile()).toEqual(orgBefore)

    // 在 Rollout 下改品牌名：只改 Rollout
    await call(server, rollout, 'PUT', '/v1/workspace/profile', {
      legal_name: 'INMO',
      brand_name: 'Rollout Audio',
    })
    expect((await state(server, rollout)).brand_name).toBe('Rollout Audio')
    expect((await state(server, inmo(server))).brand_name).toBe('INMO')
    const brands = await call<{ name: string }[]>(
      server,
      inmo(server),
      'GET',
      `/v1/orgs/${org}/brands`,
    )
    expect(brands.data?.map((b) => b.name).sort()).toEqual(['INMO', 'Rollout Audio'])
  })

  it('两个品牌各走一遍首次设置：档案、品牌名、岗位、分析结果互不串', async () => {
    const server = await boot()
    const a = inmo(server)
    // INMO：第一个品牌，分析确认会顺带定下公司全称
    const runA = await analyze(server, a)
    await call(server, a, 'POST', `/v1/brand-intake/runs/${runA}/confirm`, {
      edits: { brand_name: 'INMO' },
    })
    const plan = {
      position_ids: [],
      role_ids: [],
      positions: [{ name: '客服', role_ids: ['dtc.support'], template_id: 'customer-care' }],
    }
    const appliedA = await call<{ created_assignments: { id: string }[] }>(
      server,
      a,
      'POST',
      '/v1/onboarding/apply',
      plan,
    )
    const company = server.onboarding.companyProfile()?.legal_name

    const b = await addBrand(server, 'Rollout')
    expect((await state(server, b)).needs_setup).toBe(true)
    const runB = await analyze(server, b)
    await call(server, b, 'POST', `/v1/brand-intake/runs/${runB}/confirm`, {})
    const appliedB = await call<{ created_assignments: { id: string }[] }>(
      server,
      b,
      'POST',
      '/v1/onboarding/apply',
      plan,
    )

    // 品牌名各是各的；公司全称还是 INMO 那一轮定下的
    expect((await state(server, a)).brand_name).toBe('INMO')
    expect((await state(server, b)).brand_name).toBe('Rollout')
    expect(server.onboarding.companyProfile()?.legal_name).toBe(company)
    // 岗位分配：各建在自己品牌里，同一条职责两边各一条
    const wsOf = (r: typeof appliedA) =>
      (r.data?.created_assignments ?? []).map(
        (x) => server.roles.assignments.get(x.id)?.workspace_id,
      )
    expect(wsOf(appliedA).every((w) => w === a.workspace_id)).toBe(true)
    expect(wsOf(appliedB).every((w) => w === b.workspace_id)).toBe(true)
    expect(appliedB.data?.created_assignments.length).toBe(
      appliedA.data?.created_assignments.length,
    )
    // 分析结果：各自的「最近那一次」是各自的
    const latest = async (who: Who) =>
      (
        await call<{ id: string; workspace_id: string }>(
          server,
          who,
          'GET',
          '/v1/brand-intake/runs/latest',
        )
      ).data
    expect((await latest(a))?.id).toBe(runA)
    expect((await latest(b))?.id).toBe(runB)
    expect((await call(server, a, 'GET', `/v1/brand-intake/runs/${runB}`)).status).toBe(404)
  })

  it('切品牌后品牌一览的「当前」跟着会话走', async () => {
    const server = await boot()
    await setUpInmo(server)
    const rollout = await addBrand(server, 'Rollout')
    const org = await orgId(server)
    const asRollout = await call<{ workspace_id: string; current: boolean }[]>(
      server,
      rollout,
      'GET',
      `/v1/orgs/${org}/brands`,
    )
    expect(asRollout.data?.find((b) => b.current)?.workspace_id).toBe(rollout.workspace_id)
    const asInmo = await call<{ workspace_id: string; current: boolean }[]>(
      server,
      inmo(server),
      'GET',
      `/v1/orgs/${org}/brands`,
    )
    expect(asInmo.data?.find((b) => b.current)?.workspace_id).toBe(server.bootstrap.workspace.id)
  })
})
