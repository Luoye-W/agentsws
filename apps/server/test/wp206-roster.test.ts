/**
 * WP206：名册推上云（网页「成员额度」页列人）+ 设置 → 积分那句「给同事分额度 → 在网页上」。
 *
 * 钉住：
 * 1. 同步引擎：启动推一次；没变不推；变了推；空名册不推；没关联什么都不做；刚关联上强推；
 * 2. 云面：`syncRoster` 打的是 `POST /v1/wallet/allocation/roster`；没关联不打；
 *    「我的额度」只给 owner / admin 带网页「成员额度」页的地址；
 * 3. 真装配线 + 替身云：关联上之后名册推上去了（只有名字）；删人 → 名册里没他了、云上停用，
 *    之后带他的头再扣费回 402「这个人已经不在公司了」。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AllocationRosterRequest } from '@agentsws/contracts'
import { MEMBER_HEADER, MEMBER_LEFT_MESSAGE } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CloudFetch, createCloud } from '../src/cloud.js'
import { createRosterSync, isRosterEvent, rosterFingerprint } from '../src/cloud-roster.js'
import {
  CLOUD_STAND_IN_BASE_URL,
  type CloudStandIn,
  cloudStandIn,
  createServer,
  type Server,
} from '../src/index.js'
import { CLOUD_TOKEN_SECRET_ID } from '../src/models.js'
import type { SecretStore } from '../src/secret-store.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

vi.setConfig({ testTimeout: 30_000 })

const ROSTER: AllocationRosterRequest = {
  members: [{ id: 'p_boss', name: '王岚', positions: ['cs'] }],
  positions: [{ id: 'cs', name: '客服' }],
}

describe('WP206 名册同步引擎', () => {
  const setup = (linked = true) => {
    const pushed: AllocationRosterRequest[] = []
    let roster = ROSTER
    const sync = createRosterSync({
      build: async () => roster,
      push: async (r) => {
        pushed.push(r)
        return true
      },
      linked: () => linked,
      debounceMs: 5,
      dailyMs: 60_000,
    })
    return {
      sync,
      pushed,
      set: (next: AllocationRosterRequest) => {
        roster = next
      },
    }
  }

  it('启动推一次；没变不推；变了推；空名册不推', async () => {
    const { sync, pushed, set } = setup()
    expect(await sync.syncNow(true)).toBe(true)
    expect(await sync.syncNow()).toBe(false)
    set({ ...ROSTER, members: [...ROSTER.members, { id: 'p_b', name: '陈晓' }] })
    expect(await sync.syncNow()).toBe(true)
    set({ members: [], positions: [] })
    expect(await sync.syncNow(true)).toBe(false)
    expect(pushed).toHaveLength(2)
    sync.close()
  })

  it('攒一下再推：连着变好几次只推一次；刚关联上（force）内容没变也推', async () => {
    const { sync, pushed } = setup()
    await sync.syncNow(true)
    sync.poke()
    sync.poke()
    await new Promise((r) => setTimeout(r, 40))
    expect(pushed).toHaveLength(1)
    sync.poke(true)
    await vi.waitFor(() => expect(pushed).toHaveLength(2))
    sync.close()
  })

  it('没关联：什么都不做', async () => {
    const { sync, pushed } = setup(false)
    sync.start()
    expect(await sync.syncNow(true)).toBe(false)
    expect(pushed).toHaveLength(0)
    sync.close()
  })

  it('指纹与顺序无关；哪些事件算名册变了', () => {
    const a = rosterFingerprint({
      members: [
        { id: 'a', name: 'A', positions: ['x', 'y'] },
        { id: 'b', name: 'B' },
      ],
      positions: [],
    })
    const b = rosterFingerprint({
      members: [
        { id: 'b', name: 'B', positions: [] },
        { id: 'a', name: 'A', positions: ['y', 'x'] },
      ],
      positions: [],
    })
    expect(a).toBe(b)
    for (const t of ['membership.removed', 'position.deleted', 'assignment.granted'])
      expect(isRosterEvent(t)).toBe(true)
    expect(isRosterEvent('cloud.account_linked')).toBe(true)
    expect(isRosterEvent('run.started')).toBe(false)
  })
})

function vault(token: string | undefined): SecretStore {
  return {
    available: true,
    get: (id: string) =>
      id === CLOUD_TOKEN_SECRET_ID && token !== undefined ? { token } : undefined,
    record: () => undefined,
  } as unknown as SecretStore
}

describe('WP206 云面', () => {
  const harness = (token: string | undefined) => {
    const hits: { path: string; method: string; body?: unknown }[] = []
    const fetch: CloudFetch = async (input, init) => {
      const body = (init as { body?: string }).body
      hits.push({
        path: new URL(input).pathname,
        method: init.method,
        ...(body === undefined ? {} : { body: JSON.parse(body) as unknown }),
      })
      return { ok: true, status: 200, json: async () => ({ data: { used: 0, reserved: 0 } }) }
    }
    const cloud = createCloud({
      clock: { now: () => '2026-09-30T08:00:00.000Z' },
      secrets: vault(token),
      env: { AGENTSWS_CLOUD_BASE_URL: 'https://cloud.test.invalid' },
      fetch,
      canManage: (actor) =>
        actor.person_id === 'p_boss'
          ? 'owner'
          : actor.person_id === 'p_admin'
            ? 'admin'
            : undefined,
    })
    return { cloud, hits }
  }
  const actor = (person_id: string) => ({
    workspace_id: 'ws_1',
    person_id,
    assignment_id: `asg_${person_id}`,
    role_id: 'common.member',
  })

  it('syncRoster 打 POST /v1/wallet/allocation/roster；没关联不打', async () => {
    const linked = harness('wst_test_not_real')
    expect(await linked.cloud.syncRoster(ROSTER)).toBe(true)
    expect(linked.hits).toEqual([
      { path: '/v1/wallet/allocation/roster', method: 'POST', body: ROSTER },
    ])
    const unlinked = harness(undefined)
    expect(await unlinked.cloud.syncRoster(ROSTER)).toBe(false)
    expect(unlinked.hits).toHaveLength(0)
  })

  it('「我的额度」只给 owner / admin 带网页「成员额度」页地址（没关联也给）', async () => {
    const { cloud } = harness('wst_test_not_real')
    const owner = await cloud.port.myAllocation(actor('p_boss'))
    expect(owner).toMatchObject({
      role: 'owner',
      allocation_url: 'https://cloud.test.invalid/account/allocation',
    })
    expect(await cloud.port.myAllocation(actor('p_admin'))).toMatchObject({ role: 'admin' })
    const member = await cloud.port.myAllocation(actor('p_b'))
    expect(member.role).toBeUndefined()
    expect(member.allocation_url).toBeUndefined()
    const off = harness(undefined)
    expect(await off.cloud.port.myAllocation(actor('p_boss'))).toMatchObject({
      linked: false,
      role: 'owner',
    })
  })
})

describe('WP206 真装配线 + 替身云', () => {
  let dir: string
  let server: Server
  let url: string
  let standIn: CloudStandIn
  const seen: { url: string; headers: Record<string, string> }[] = []

  const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
    headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    return fetch(`${url}${path}`, { ...init, headers })
  }

  beforeEach(async () => {
    seen.length = 0
    dir = mkdtempSync(join(tmpdir(), 'agentsws-wp206-'))
    standIn = cloudStandIn({ autoLinkAfterMs: 0 })
    server = await createServer({
      dbDir: dir,
      quiet: true,
      env: { [SECRETS_KEY_ENV]: 'd'.repeat(64), AGENTSWS_CLOUD_BASE_URL: CLOUD_STAND_IN_BASE_URL },
      tokenRefreshIntervalMs: 0,
      scheduleIntervalMs: 0,
      cloudFetch: async (input, init) => {
        seen.push({ url: input, headers: { ...(init?.headers ?? {}) } })
        return standIn.fetch(input, init)
      },
    })
    url = (await server.listen(0)).url
  })

  afterEach(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('关联上就推名册（只有名字）；删人 → 名册里没他、云上停用，再扣费 402「这个人已经不在公司了」', async () => {
    const ws = server.bootstrap.workspace.id
    const owner = server.bootstrap.person.id
    const mate = await server.identity.createPerson({
      id: 'p_mate',
      email: 'mate@example.com',
      name: '同事',
    })
    await server.identity.addMember({
      workspace_id: ws,
      person_id: mate.id,
      role: 'member',
      ranges: [],
    })
    // 还没关联：一跳都不打
    expect(seen.some((s) => s.url.endsWith('/v1/wallet/allocation/roster'))).toBe(false)

    await api('/v1/cloud/account/link', {
      method: 'POST',
      body: JSON.stringify({ email: 'boss@example.com' }),
    })
    await standIn.settled()
    await vi.waitFor(() => expect(standIn.roster()?.members.map((m) => m.id)).toContain('p_mate'), {
      timeout: 10_000,
      interval: 100,
    })
    const roster = standIn.roster() as AllocationRosterRequest
    expect(roster.members.find((m) => m.id === owner)?.name).toBe(server.bootstrap.person.name)
    // 只有名字：没有邮箱、没有别的
    expect(JSON.stringify(roster)).not.toContain('@example.com')
    expect(roster.positions.length).toBeGreaterThan(0)

    const removed = await api(`/v1/workspaces/${ws}/members/p_mate`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    await vi.waitFor(
      () => expect(standIn.roster()?.members.map((m) => m.id)).not.toContain('p_mate'),
      { timeout: 10_000, interval: 100 },
    )
    const token = seen.find((s) => s.url.endsWith('/v1/wallet/allocation/roster'))?.headers
      .Authorization
    const chat = await standIn.fetch(`${CLOUD_STAND_IN_BASE_URL}/v1/ai/chat/completions`, {
      method: 'POST',
      headers: { Authorization: token ?? '', [MEMBER_HEADER]: 'p_mate' },
      body: '{}',
    })
    expect(chat.status).toBe(402)
    expect(((await chat.json()) as { message: string }).message).toBe(MEMBER_LEFT_MESSAGE)
  })

  it('替身也有同一道保护：一下子没了一半以上（且 ≥3 人）→ 不收回，没了的照旧留在名册里', async () => {
    await api('/v1/cloud/account/link', {
      method: 'POST',
      body: JSON.stringify({ email: 'boss@example.com' }),
    })
    await standIn.settled()
    await vi.waitFor(() => expect(standIn.roster()).toBeDefined(), {
      timeout: 10_000,
      interval: 100,
    })
    const token = seen.find((s) => s.url.endsWith('/v1/wallet/allocation/roster'))?.headers
      .Authorization
    const push = async (ids: string[]) =>
      (await (
        await standIn.fetch(`${CLOUD_STAND_IN_BASE_URL}/v1/wallet/allocation/roster`, {
          method: 'POST',
          headers: { Authorization: token ?? '', 'content-type': 'application/json' },
          body: JSON.stringify({ members: ids.map((id) => ({ id, name: id })), positions: [] }),
        })
      ).json()) as { data: { reclaimed: unknown[]; guarded?: { missing: number; of: number } } }
    await push(['p_a', 'p_b', 'p_c', 'p_d'])
    const held = await push(['p_a'])
    expect(held.data.guarded).toEqual({ missing: 3, of: 4 })
    expect(held.data.reclaimed).toEqual([])
    expect(
      standIn
        .roster()
        ?.members.map((m) => m.id)
        .sort(),
    ).toEqual(['p_a', 'p_b', 'p_c', 'p_d'])
    // 少了一两个照常收回
    const one = await push(['p_a', 'p_b', 'p_c'])
    expect(one.data.guarded).toBeUndefined()
    expect(one.data.reclaimed).toEqual([{ kind: 'member', subject_id: 'p_d' }])
  })
})
