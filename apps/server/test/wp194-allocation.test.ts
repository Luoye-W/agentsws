/**
 * WP194：成员 / 岗位额度在本机这一头。
 *
 * 钉住：
 * 1. 打云时带「谁 / 哪个岗位」（`X-Agentsws-Member` / `X-Agentsws-Position`）——显式的与作用域里的都算；
 * 2. 公司「积分」页只给公司的 owner / admin（别人 403 人话）；「我的额度」谁都能看自己的；
 * 3. 改额度时顺手推公司时区（只推 IANA 名）；
 * 4. 删成员时把他在云上的额度行清掉（尽力而为）；
 * 5. 走真装配线 + 替身云：owner 看得到报表、改得了上限（审计记的是本机那个人）、删人清额度。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AllocationLimitChanged,
  CloudAllocationView,
  CloudMyAllocationView,
} from '@agentsws/contracts'
import { ALLOCATION_EXHAUSTED_MESSAGE, MEMBER_HEADER, POSITION_HEADER } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CloudFetch, createCloud } from '../src/cloud.js'
import { withCloudAttribution } from '../src/cloud-attribution.js'
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

vi.setConfig({ testTimeout: 20_000 })

const clock = { now: () => '2026-09-29T08:00:00.000Z' }

/** 只认一把令牌的最小加密库替身（不落盘）。 */
function vault(token: string | undefined): SecretStore {
  return {
    available: true,
    get: (id: string) =>
      id === CLOUD_TOKEN_SECRET_ID && token !== undefined ? { token } : undefined,
    record: () => undefined,
  } as unknown as SecretStore
}

interface Hit {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

function harness(token: string | null = 'wst_test_not_real') {
  const hits: Hit[] = []
  const fetch: CloudFetch = async (input, init) => {
    const body = (init as { body?: string }).body
    hits.push({
      url: input,
      method: init.method,
      headers: init.headers,
      ...(body === undefined ? {} : { body: JSON.parse(body) as unknown }),
    })
    const path = new URL(input).pathname
    const data =
      path === '/v1/wallet/allocation/limits'
        ? { row: { kind: 'member', subject_id: 'p_b', used: 0, reserved: 0, calls: 0 }, audit: {} }
        : path === '/v1/wallet/allocation/me'
          ? { month: '2026-09', timezone: 'Asia/Shanghai', member_id: 'p_b', used: 3, reserved: 0 }
          : path === '/v1/wallet/allocation'
            ? { month: '2026-09', members: [], positions: [] }
            : { ok: true }
    return { ok: true, status: 200, json: async () => ({ data }) }
  }
  const cloud = createCloud({
    clock,
    secrets: vault(token ?? undefined),
    env: { AGENTSWS_CLOUD_BASE_URL: 'https://cloud.test.invalid' },
    fetch,
    positionOf: (role_id) => (role_id === 'support.aftersales' ? 'cs' : undefined),
    canManage: (actor) => actor.person_id === 'p_boss',
    timeZone: () => 'Asia/Shanghai',
  })
  return { cloud, hits }
}

const boss = {
  workspace_id: 'ws_1',
  person_id: 'p_boss',
  assignment_id: 'asg_boss',
  role_id: 'common.owner',
}
const staff = {
  workspace_id: 'ws_1',
  person_id: 'p_b',
  assignment_id: 'asg_b',
  role_id: 'support.aftersales',
}

describe('WP194 本机：带「谁」与谁能管', () => {
  it('公司那一页只给 owner / admin；别人 403 人话', async () => {
    const { cloud } = harness()
    await expect(cloud.port.allocation?.(staff, {})).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      cloud.port.setAllocationLimit?.(staff, {
        kind: 'member',
        subject_id: 'p_b',
        monthly_limit: 5,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(cloud.port.allocationAudit?.(staff)).rejects.toMatchObject({ code: 'forbidden' })
    const view = (await cloud.port.allocation?.(boss, {})) as CloudAllocationView
    expect(view.linked).toBe(true)
  })

  it('「我的额度」带本人与岗位；谁都能看自己的', async () => {
    const { cloud, hits } = harness()
    const mine = (await cloud.port.myAllocation?.(staff)) as CloudMyAllocationView
    expect(mine.mine?.used).toBe(3)
    const hit = hits.find((h) => h.url.endsWith('/v1/wallet/allocation/me'))
    expect(hit?.headers[MEMBER_HEADER]).toBe('p_b')
    expect(hit?.headers[POSITION_HEADER]).toBe('cs')
  })

  it('改额度：先推公司时区，再带着改的人去改', async () => {
    const { cloud, hits } = harness()
    const out = (await cloud.port.setAllocationLimit?.(boss, {
      kind: 'member',
      subject_id: 'p_b',
      monthly_limit: 20,
    })) as AllocationLimitChanged
    expect(out.row.subject_id).toBe('p_b')
    expect(hits.map((h) => new URL(h.url).pathname)).toEqual([
      '/v1/wallet/allocation/settings',
      '/v1/wallet/allocation/limits',
    ])
    expect(hits[0]?.body).toEqual({ timezone: 'Asia/Shanghai' })
    expect(hits[1]?.headers[MEMBER_HEADER]).toBe('p_boss')
  })

  it('作用域里的归属进了每一跳（余额那一跳也带）；没有作用域就不带', async () => {
    const { cloud, hits } = harness()
    await withCloudAttribution({ member_id: 'p_b', position_id: 'cs' }, () =>
      cloud.port.credits(staff),
    )
    expect(hits[0]?.headers[MEMBER_HEADER]).toBe('p_b')
    expect(hits[0]?.headers[POSITION_HEADER]).toBe('cs')
    hits.length = 0
    const other = harness()
    await other.cloud.port.credits(staff)
    expect(other.hits[0]?.headers[MEMBER_HEADER]).toBeUndefined()
  })

  it('删人清额度：带着删人的那个人去清；没关联就什么都不打', async () => {
    const { cloud, hits } = harness()
    expect(await cloud.forgetMember('p_b', 'p_boss')).toBe(true)
    expect(hits[0]?.url).toMatch(/\/v1\/wallet\/allocation\/members\/remove$/)
    expect(hits[0]?.body).toEqual({ member_id: 'p_b' })
    expect(hits[0]?.headers[MEMBER_HEADER]).toBe('p_boss')
    const unlinked = harness(null)
    expect(await unlinked.cloud.forgetMember('p_b', 'p_boss')).toBe(false)
    expect(unlinked.hits).toHaveLength(0)
    expect((await unlinked.cloud.port.allocation?.(boss, {}))?.linked).toBe(false)
  })
})

describe('WP194 替身云本身', () => {
  it('额度那几条只认替身签过的令牌；不带令牌 401，不编数据', async () => {
    const standIn = cloudStandIn({ autoLinkAfterMs: -1 })
    standIn.seedAllocation({
      usage: [{ member_id: 'p_a', position_id: 'cs', bucket: 'ai', credits: 12, calls: 30 }],
      limits: [{ kind: 'member', subject_id: 'p_a', monthly_limit: 10 }],
    })
    for (const path of ['/v1/wallet/allocation', '/v1/wallet/allocation/me'])
      expect((await standIn.fetch(`${CLOUD_STAND_IN_BASE_URL}${path}`, {})).status).toBe(401)
  })
})

describe('WP194 真装配线 + 替身云', () => {
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
  const data = async <T>(res: Response): Promise<T> => {
    expect(res.status).toBe(200)
    return ((await res.json()) as { data: T }).data
  }

  beforeEach(async () => {
    seen.length = 0
    dir = mkdtempSync(join(tmpdir(), 'agentsws-wp194-'))
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

  it('owner 看得到报表、改得了上限；「我的额度」到了说那句人话；删人清额度', async () => {
    const owner = server.bootstrap.person.id
    const ws = server.bootstrap.workspace.id
    const view = await data<CloudAllocationView>(await api('/v1/cloud/allocation'))
    expect(view.linked).toBe(true)
    expect(view.report?.month).toMatch(/^\d{4}-\d{2}$/)

    // 一个同事：建人 + 进工作区 + 在替身里种一些用量
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
    standIn.seedAllocation({
      usage: [{ member_id: owner, bucket: 'ai', credits: 6, calls: 3 }],
    })

    const set = await data<AllocationLimitChanged>(
      await api('/v1/cloud/allocation/limits', {
        method: 'POST',
        body: JSON.stringify({ kind: 'member', subject_id: 'p_mate', monthly_limit: 8 }),
      }),
    )
    expect(set.audit.actor).toBe(owner)
    const bad = await api('/v1/cloud/allocation/limits', {
      method: 'POST',
      body: JSON.stringify({ kind: 'member', subject_id: 'bad id', monthly_limit: 1 }),
    })
    expect(bad.status).toBe(400)
    expect((await api('/v1/cloud/allocation?month=2026-13')).status).toBe(400)

    // 给自己也设一个比已用少的上限 → 「我的额度」是用完了
    await api('/v1/cloud/allocation/limits', {
      method: 'POST',
      body: JSON.stringify({ kind: 'member', subject_id: owner, monthly_limit: 5 }),
    })
    const mine = await data<CloudMyAllocationView>(await api('/v1/cloud/allocation/me'))
    expect(mine.mine).toMatchObject({ member_id: owner, used: 6, monthly_limit: 5, percent: 120 })
    const meHit = seen.find((s) => s.url.endsWith('/v1/wallet/allocation/me'))
    expect(meHit?.headers[MEMBER_HEADER]).toBe(owner)

    // 替身的官方模型口：超了的人回 402 那句人话
    const token = seen.find((s) => s.url.endsWith('/v1/wallet/allocation/me'))?.headers
      .Authorization
    const chat = await standIn.fetch(`${CLOUD_STAND_IN_BASE_URL}/v1/ai/chat/completions`, {
      method: 'POST',
      headers: { Authorization: token ?? '', [MEMBER_HEADER]: owner },
      body: '{}',
    })
    expect(chat.status).toBe(402)
    expect(((await chat.json()) as { message: string }).message).toBe(ALLOCATION_EXHAUSTED_MESSAGE)

    // 删人：云上他的额度行清掉
    const removed = await api(`/v1/workspaces/${ws}/members/p_mate`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    const after = await data<CloudAllocationView>(await api('/v1/cloud/allocation'))
    expect(
      after.report?.members.find((m) => m.subject_id === 'p_mate')?.monthly_limit,
    ).toBeUndefined()
    const removeHit = seen.find((s) => s.url.endsWith('/v1/wallet/allocation/members/remove'))
    expect(removeHit?.headers[MEMBER_HEADER]).toBe(owner)
  })
})
