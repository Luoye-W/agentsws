/**
 * WP282（决策 281 / 286–290）：按人看积分，本机这一头。
 *
 * 钉住：
 * 1. 谁看得到谁判在本机：② 全员；③ owner / admin 全员、别人只看自己（强制带 `member=<自己>`）；① 只有自己；
 * 2. 云上只回有用量的人，本机按名册补 0 行、补名字；只看自己时没用量也有一行 0、「没标注」清零；
 * 3. 替身云认 `group=member` / `member` / `month`（写错 400），按人合计 + 没标注 = 总数；
 * 4. 走真装配线：`GET /v1/cloud/usage/members` ① 只有自己、② 同事也看全员；参数写错 400；没关联不是错。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CloudMemberUsageView,
  MemberUsageReport,
  OrganizationMode,
  UsageReport,
} from '@agentsws/contracts'
import { emptyMemberUsageBlocks, isMemberUsageReport, MEMBER_HEADER } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CloudFetch, createCloud } from '../src/cloud.js'
import {
  CLOUD_STAND_IN_BASE_URL,
  type CloudStandIn,
  cloudStandIn,
  createServer,
  type Server,
} from '../src/index.js'
import { fillMemberUsage, memberUsageScopeOf } from '../src/member-usage.js'
import { CLOUD_TOKEN_SECRET_ID } from '../src/models.js'
import type { SecretStore } from '../src/secret-store.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

vi.setConfig({ testTimeout: 20_000 })

const clock = { now: () => '2026-10-09T08:00:00.000Z' }

const sample = (): MemberUsageReport => ({
  group: 'member',
  from: '2026-09-30T16:00:00.000Z',
  to: '2026-10-09T08:00:00.000Z',
  timezone: 'Asia/Shanghai',
  rows: [
    {
      key: 'p_a',
      name: '李默',
      credits: 44,
      quantity: 6,
      calls: 3,
      blocks: {
        ai: { credits: 10, calls: 1 },
        data: { credits: 4, calls: 1 },
        service: { credits: 30, calls: 1 },
      },
    },
    {
      key: 'p_b',
      credits: 2,
      quantity: 1,
      calls: 1,
      blocks: { ...emptyMemberUsageBlocks(), ai: { credits: 2, calls: 1 } },
    },
  ],
  unattributed: {
    credits: 2.5,
    quantity: 2,
    calls: 1,
    blocks: { ...emptyMemberUsageBlocks(), data: { credits: 2.5, calls: 1 } },
  },
  total_credits: 48.5,
})

describe('WP282 谁看得到谁、补 0 行', () => {
  it('② 全员；③ 管理者全员、别人只看自己；① 只有自己', () => {
    expect(memberUsageScopeOf('peers', false)).toBe('all')
    expect(memberUsageScopeOf('company', true)).toBe('all')
    expect(memberUsageScopeOf('company', false)).toBe('self')
    expect(memberUsageScopeOf('solo', true)).toBe('self')
  })

  it('全员：名字按名册补，没用量的同事补 0 行排在后面；离开了的不补', () => {
    const out = fillMemberUsage(sample(), {
      scope: 'all',
      self: 'p_a',
      names: { p_a: '名册里的李默', p_b: '陈晓', p_c: '王岚', p_gone: '走了的人' },
      active: ['p_c', 'p_a', 'p_b'],
    })
    expect(out.rows.map((r) => [r.key, r.name, r.credits])).toEqual([
      ['p_a', '李默', 44], // 云上给了名字就用云上的
      ['p_b', '陈晓', 2],
      ['p_c', '王岚', 0],
    ])
    expect(out.rows[2]?.blocks).toEqual(emptyMemberUsageBlocks())
    expect(out.unattributed.credits).toBe(2.5)
    expect(out.total_credits).toBe(48.5)
  })

  it('只看自己：只有本人一行（没用量也有一行 0），没标注清零', () => {
    const mine = fillMemberUsage(sample(), { scope: 'self', self: 'p_b', names: { p_b: '陈晓' } })
    expect(mine.rows).toHaveLength(1)
    expect(mine.rows[0]).toMatchObject({ key: 'p_b', name: '陈晓', credits: 2 })
    expect(mine.unattributed.credits).toBe(0)
    expect(mine.total_credits).toBe(2)
    const none = fillMemberUsage(
      { ...sample(), rows: [] },
      { scope: 'self', self: 'p_new', names: { p_new: '新人' } },
    )
    expect(none.rows).toEqual([
      {
        key: 'p_new',
        name: '新人',
        credits: 0,
        quantity: 0,
        calls: 0,
        blocks: emptyMemberUsageBlocks(),
      },
    ])
  })
})

/** 只认一把令牌的最小加密库替身（不落盘）。 */
function vault(token: string | undefined): SecretStore {
  return {
    available: true,
    get: (id: string) =>
      id === CLOUD_TOKEN_SECRET_ID && token !== undefined ? { token } : undefined,
    record: () => undefined,
  } as unknown as SecretStore
}

function harness(mode: OrganizationMode, opts: { token?: string | null; status?: number } = {}) {
  const hits: { url: URL; headers: Record<string, string> }[] = []
  const fetch: CloudFetch = async (input, init) => {
    hits.push({ url: new URL(input), headers: init.headers })
    const status = opts.status ?? 200
    return {
      ok: status < 400,
      status,
      json: async () => (status < 400 ? { data: sample() } : { message: '云上没答应' }),
    }
  }
  const token = opts.token === undefined ? 'wst_test_not_real' : opts.token
  const cloud = createCloud({
    clock,
    secrets: vault(token ?? undefined),
    env: { AGENTSWS_CLOUD_BASE_URL: 'https://cloud.test.invalid' },
    fetch,
    mode: () => mode,
    canManage: (actor) => (actor.person_id === 'p_boss' ? 'owner' : undefined),
    directory: () => ({
      members: { p_a: '李默', p_b: '陈晓', p_boss: '王岚' },
      positions: {},
      notify_emails: [],
      active: ['p_boss', 'p_a', 'p_b'],
    }),
  })
  return { cloud, hits }
}

const actor = (person_id: string) => ({
  workspace_id: 'ws_1',
  person_id,
  assignment_id: `asg_${person_id}`,
  role_id: 'support.aftersales',
})

describe('WP282 本机云客户端', () => {
  it('② 同事也看全员：不带 member，没用量的发起人补 0 行', async () => {
    const { cloud, hits } = harness('peers')
    const view = (await cloud.port.usageByMember?.(actor('p_b'), {})) as CloudMemberUsageView
    expect(view.scope).toBe('all')
    expect(hits[0]?.url.pathname).toBe('/v1/wallet/usage')
    expect(hits[0]?.url.searchParams.get('group')).toBe('member')
    expect(hits[0]?.url.searchParams.has('member')).toBe(false)
    // 区间不给就让云上按公司时区切本月（决策 286），本机不传 from / to
    expect(hits[0]?.url.searchParams.has('from')).toBe(false)
    expect(hits[0]?.headers[MEMBER_HEADER]).toBe('p_b')
    expect(view.report?.rows.map((r) => r.key)).toEqual(['p_a', 'p_b', 'p_boss'])
    expect(view.report?.rows.find((r) => r.key === 'p_boss')).toMatchObject({
      name: '王岚',
      credits: 0,
    })
  })

  it('③ 普通成员：本机强制带 member=自己，给别人的也不算数', async () => {
    const { cloud, hits } = harness('company')
    const view = (await cloud.port.usageByMember?.(actor('p_b'), {
      member: 'p_a',
    })) as CloudMemberUsageView
    expect(view.scope).toBe('self')
    expect(hits[0]?.url.searchParams.get('member')).toBe('p_b')
    expect(view.report?.rows.map((r) => r.key)).toEqual(['p_b'])
    expect(view.report?.unattributed.credits).toBe(0)
  })

  it('③ owner 看全员；可以只筛一个人（那时不补别人）', async () => {
    const { cloud, hits } = harness('company')
    const all = (await cloud.port.usageByMember?.(actor('p_boss'), {
      month: '2026-09',
    })) as CloudMemberUsageView
    expect(all.scope).toBe('all')
    expect(hits[0]?.url.searchParams.get('month')).toBe('2026-09')
    expect(all.report?.rows).toHaveLength(3)
    const one = (await cloud.port.usageByMember?.(actor('p_boss'), {
      member: 'p_a',
    })) as CloudMemberUsageView
    expect(hits[1]?.url.searchParams.get('member')).toBe('p_a')
    expect(one.report?.rows.map((r) => r.key)).toEqual(['p_a', 'p_b'])
  })

  it('① 只有自己', async () => {
    const { cloud, hits } = harness('solo')
    const view = (await cloud.port.usageByMember?.(actor('p_boss'), {})) as CloudMemberUsageView
    expect(view.scope).toBe('self')
    expect(hits[0]?.url.searchParams.get('member')).toBe('p_boss')
  })

  it('没关联不是错（不打云）；云上拒了回一句人话', async () => {
    const unlinked = harness('peers', { token: null })
    const view = (await unlinked.cloud.port.usageByMember?.(
      actor('p_b'),
      {},
    )) as CloudMemberUsageView
    expect(view).toMatchObject({ linked: false, scope: 'all' })
    expect(view.reason).toBeTruthy()
    expect(unlinked.hits).toHaveLength(0)
    const refused = harness('peers', { status: 400 })
    const bad = (await refused.cloud.port.usageByMember?.(actor('p_b'), {})) as CloudMemberUsageView
    expect(bad).toMatchObject({ linked: true, reason: '云上没答应' })
    expect(bad.report).toBeUndefined()
  })
})

describe('WP282 真装配线 + 替身云', () => {
  let dir: string
  let server: Server
  let url: string
  let standIn: CloudStandIn
  let cloudAuth = ''

  const api = async (
    path: string,
    init: RequestInit & { token?: string; assignment?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${init.token ?? server.bootstrap.internalToken}`)
    const asg = init.assignment ?? server.bootstrap.ownerAssignment.id
    if (asg !== '') headers.set('X-Assignment', asg)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    return fetch(`${url}${path}`, { ...init, headers })
  }
  const data = async <T>(res: Response): Promise<T> => {
    expect(res.status).toBe(200)
    return ((await res.json()) as { data: T }).data
  }
  const wallet = async <T>(query: string): Promise<{ status: number; data?: T }> => {
    const res = await standIn.fetch(`${CLOUD_STAND_IN_BASE_URL}/v1/wallet/usage?${query}`, {
      headers: { Authorization: cloudAuth },
    })
    const body = (await res.json()) as { data?: T }
    return { status: res.status, ...(body.data === undefined ? {} : { data: body.data }) }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentsws-wp282-'))
    standIn = cloudStandIn({ autoLinkAfterMs: 0 })
    server = await createServer({
      dbDir: dir,
      quiet: true,
      env: { [SECRETS_KEY_ENV]: 'd'.repeat(64), AGENTSWS_CLOUD_BASE_URL: CLOUD_STAND_IN_BASE_URL },
      tokenRefreshIntervalMs: 0,
      scheduleIntervalMs: 0,
      cloudFetch: async (input, init) => {
        const auth = init?.headers?.Authorization
        if (auth !== undefined) cloudAuth = auth
        return standIn.fetch(input, init)
      },
    })
    url = (await server.listen(0)).url
    // 没关联：不是错，说一句人话
    const before = await data<CloudMemberUsageView>(await api('/v1/cloud/usage/members'))
    expect(before.linked).toBe(false)
    await api('/v1/cloud/account/link', {
      method: 'POST',
      body: JSON.stringify({ email: 'boss@example.com' }),
    })
    await standIn.settled()
  })

  afterEach(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('替身认 group=member / member / month：按人 + 没标注 = 总数，写错 400', async () => {
    await data(await api('/v1/cloud/credits')) // 打一跳云，拿到替身签的令牌
    standIn.seedAllocation({
      usage: [
        { member_id: 'p_a', bucket: 'ai', credits: 6, calls: 3 },
        { member_id: 'p_a', bucket: 'other', credits: 30, calls: 1 },
        { member_id: 'p_b', bucket: 'data', credits: 1.5, calls: 2 },
        { bucket: 'ai', credits: 2, calls: 1 },
      ],
    })
    const all = await wallet<MemberUsageReport>('group=member')
    expect(all.status).toBe(200)
    const report = all.data as MemberUsageReport
    expect(isMemberUsageReport(report)).toBe(true)
    expect(report.rows.map((r) => [r.key, r.credits])).toEqual([
      ['p_a', 36],
      ['p_b', 1.5],
    ])
    expect(report.rows[0]?.blocks.service).toEqual({ credits: 30, calls: 1 })
    expect(report.unattributed.credits).toBe(2)
    expect(report.total_credits).toBe(39.5)
    const capability = await wallet<UsageReport>('group=capability')
    expect(capability.data?.total_credits).toBe(report.total_credits)

    const one = await wallet<MemberUsageReport>('group=member&member=p_b')
    expect(one.data?.rows.map((r) => r.key)).toEqual(['p_b'])
    expect(one.data?.unattributed.credits).toBe(0)
    expect((await wallet('group=member&month=2026-13')).status).toBe(400)
    expect((await wallet('group=member&month=2026-09&from=2026-09-01T00:00:00Z')).status).toBe(400)
    expect((await wallet('group=member&member=bad%20id')).status).toBe(400)
    expect((await wallet<MemberUsageReport>('group=member&month=2020-01')).data?.rows).toEqual([])
  })

  it('① 只有自己；② 来了同事，同事也看全员（没用量的补 0）', async () => {
    const owner = server.bootstrap.person.id
    const ws = server.bootstrap.workspace.id
    standIn.seedAllocation({
      usage: [
        { member_id: owner, bucket: 'ai', credits: 6, calls: 3 },
        { bucket: 'other', credits: 30, calls: 1 },
      ],
    })
    const solo = await data<CloudMemberUsageView>(await api('/v1/cloud/usage/members'))
    expect(solo.scope).toBe('self')
    expect(solo.report?.rows.map((r) => [r.key, r.credits])).toEqual([[owner, 6]])

    // 来一位同事 → ②
    const mate = await server.identity.createPerson({
      id: 'p_mate',
      email: 'mate@example.com',
      name: '林峰',
    })
    await server.identity.addMember({
      workspace_id: ws,
      person_id: mate.id,
      role: 'member',
      ranges: [],
    })
    const linkRes = await fetch(`${url}/v1/auth/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mate@example.com' }),
    })
    const link = ((await linkRes.json()) as { data: { token: string } }).data
    const verify = await fetch(`${url}/v1/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: link.token }),
    })
    const session = ((await verify.json()) as { data: { session_token: string } }).data
    const mateAsg = server.roles.assignments.create({
      person_id: mate.id,
      workspace_id: ws,
      role_id: 'common.member',
      ranges: [],
      granted_by: owner,
    }).id
    const peers = await data<CloudMemberUsageView>(
      await api('/v1/cloud/usage/members', { token: session.session_token, assignment: mateAsg }),
    )
    expect(peers.scope).toBe('all')
    expect(peers.report?.rows.map((r) => [r.key, r.credits])).toEqual([
      [owner, 6],
      ['p_mate', 0],
    ])
    expect(peers.report?.rows[1]?.name).toBe('林峰')
    expect(peers.report?.unattributed.credits).toBe(30)

    expect((await api('/v1/cloud/usage/members?month=2026-9')).status).toBe(400)
    expect(
      (await api('/v1/cloud/usage/members?month=2026-09&from=2026-09-01T00:00:00Z')).status,
    ).toBe(400)
    expect((await api('/v1/cloud/usage/members?member=bad%20id')).status).toBe(400)
  })
})
