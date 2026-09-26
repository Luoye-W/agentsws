/**
 * WP153（09-26 真账号冒烟 §3）：店主查得到「有哪些岗位、有哪些连接」。
 *
 * 冒烟原话：店主职责被问到时只能说「这个工作区没有给我能列出岗位和连接的工具」。
 * 这个文件钉住：
 *
 * 1. 店主能调 `list_positions` / `list_connections`，回来的是真岗位、真连接名；
 * 2. 别的职责没有这两个工具（执行器也拦：点名调也是 `blocked`）；
 * 3. 返回里没有任何敏感字段（id、邮箱、token、密钥、凭据）——就算上游对象里有也带不出来；
 * 4. 端到端（stub）：回答里有岗位名、没有工具名，摘要是这件事本身，不是「查了退货政策」。
 */
import type { Assignment, RunEvent, RunRequest } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { createOwnerToolExecutor, rangeText } from '../src/owner-tools.js'

const T0 = '2026-09-26T01:00:00.000Z'
const SECRETS_KEY = 'd'.repeat(64)

/** 返回里不许出现的键（任何一层）。 */
const SENSITIVE =
  /^(id|.*_id|email|token|.*token.*|secret.*|.*key|password|credential.*|identity|account.*|header.*)$/i

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) keysDeep(v, out)
  else if (value !== null && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      out.push(k)
      keysDeep(v, out)
    }
  return out
}

const request = (role_id: string): RunRequest =>
  ({
    actor: { person_id: 'per_1', assignment_id: 'asg_1', role_id },
  }) as unknown as RunRequest

/** 上游对象故意带上一堆不该出去的字段——出参必须是白名单。 */
const exec = createOwnerToolExecutor({
  positions: async () =>
    [
      {
        id: 'pos_care',
        name: '客服',
        roles: [{ role_id: 'dtc.support', name: '售后客服', default: true }],
        holders: [
          {
            person_id: 'per_1',
            email: 'owner@example.com',
            name: '罗叶',
            ranges: [{ kind: 'brand', id: 'brd_secret_1' }],
          },
        ],
      },
      { id: 'pos_kol', name: '红人营销', roles: [], holders: [] },
    ] as never,
  directory: async () =>
    [
      {
        kind: 'shopify',
        name: { zh: 'Shopify 店铺' },
        state: 'connected',
        identity: { account_id: 'acct_9' },
        token: 'shpat_xxx',
      },
      { kind: 'email', name: { zh: '邮箱' }, state: 'error', state_detail: '要重新授权' },
      { kind: 'ga4', name: { zh: 'GA4' }, state: 'not_connected' },
    ] as never,
  gaps: async () =>
    [
      {
        kind: 'ga4',
        name: { zh: 'GA4' },
        required: true,
        needed_by: ['网站运营'],
        connect_service: 'ga4',
      },
    ] as never,
  activeRoleIds: () => ['dtc.support'],
})

describe('店主的两个只读工具（执行器）', () => {
  it('owner 能调：回来的是岗位名 / 职责 / 谁在岗 / 范围', async () => {
    const res = await exec({ name: 'list_positions', input: {}, request: request('common.owner') })
    expect(res.status).toBe('ok')
    expect(res.data).toEqual({
      positions: [
        {
          name: '客服',
          duties: ['售后客服'],
          holders: [{ name: '罗叶', range: '1 个品牌', has_range: true }],
          staffed: true,
        },
        { name: '红人营销', duties: [], holders: [], staffed: false },
      ],
    })
  })

  it('owner 能调：已连 / 出错 / 哪条职责要它但还没连', async () => {
    const res = await exec({
      name: 'list_connections',
      input: {},
      request: request('common.owner'),
    })
    expect(res.status).toBe('ok')
    expect(res.data).toEqual({
      connected: [
        { name: 'Shopify 店铺', state: 'connected' },
        { name: '邮箱', state: 'error', note: '要重新授权' },
      ],
      missing: [{ name: 'GA4', required: true, needed_by: ['网站运营'] }],
    })
  })

  it('返回里没有任何敏感字段（上游对象带了也出不去）', async () => {
    for (const name of ['list_positions', 'list_connections']) {
      const res = await exec({ name, input: {}, request: request('common.owner') })
      const keys = keysDeep(res.data)
      expect(keys.filter((k) => SENSITIVE.test(k))).toEqual([])
      const text = JSON.stringify(res.data)
      for (const leak of [
        'owner@example.com',
        'shpat_xxx',
        'acct_9',
        'brd_secret_1',
        'per_1',
        'pos_',
      ])
        expect(text).not.toContain(leak)
    }
  })

  it('别的职责点名调也是 blocked', async () => {
    for (const role of ['dtc.support', 'kol.youtube', 'common.member']) {
      const res = await exec({ name: 'list_positions', input: {}, request: request(role) })
      expect(res.status).toBe('blocked')
    }
  })

  it('范围说人话，不出 id', () => {
    expect(rangeText([])).toBe('还没划范围')
    expect(
      rangeText([
        { kind: 'store', id: 's1' },
        { kind: 'store', id: 's2' },
        { kind: 'brand', id: 'b1' },
      ]),
    ).toBe('2 个店铺、1 个品牌')
  })
})

// ── 端到端：真进程、真装配线，模型那一跳是 stub ─────────────────────────────

let server: Server
let owner: Assignment

function makeClock(start = T0) {
  const t = Date.parse(start)
  return { now: () => new Date(t).toISOString() }
}

const call = async (
  method: string,
  path: string,
  options: { body?: unknown; assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', options.assignment ?? owner.id)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  )
}

const dataOf = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: unknown; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data as T
}

function runEvents(run_id: string): RunEvent[] {
  return server.kernel.eventLog
    .readSync({ workspace_id: server.bootstrap.workspace.id })
    .filter((e) => e.correlation?.run_id === run_id)
    .map((e) => ({ type: e.type, ...(e.payload as object) }) as RunEvent)
}

const toolsCalled = (run_id: string): string[] =>
  runEvents(run_id)
    .filter((e): e is Extract<RunEvent, { type: 'tool.call' }> => e.type === 'tool.call')
    .map((e) => e.tool)

describe('端到端（stub）：店主问岗位和连接', () => {
  beforeEach(async () => {
    server = await createServer({
      quiet: true,
      clock: makeClock(),
      random: () => 0.42,
      scheduleIntervalMs: 0,
      tokenRefreshIntervalMs: 0,
      env: { AGENTSWS_OWNER_EMAIL: 'owner@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
    })
    const held = server.roles.assignments
      .listByRole('common.owner', { workspace_id: server.bootstrap.workspace.id })
      .find((a) => a.revoked_at === undefined)
    if (held === undefined) throw new Error('bootstrap 没给店主职责')
    owner = held
  })

  afterEach(async () => {
    await server.close()
  })

  const ASK = '帮我看看有哪些岗位和连接，最该先处理哪三件事'

  it('调了两个只读工具；回答里有真岗位名、没有工具名；摘要是这件事本身', async () => {
    const out = await dataOf<{
      matter: { id: string }
      picked?: { role_id: string }
      run_id?: string
    }>(
      // 不点名职责：店主岗位上直接问，岗位内路由要把它交给「工作区所有者」（WP153）
      await call('POST', '/v1/positions/owner/matters', { body: { title: ASK } }),
    )
    expect(out.run_id).toBeDefined()
    expect(out.picked?.role_id).toBe('common.owner')
    const run_id = out.run_id ?? ''
    expect(toolsCalled(run_id)).toEqual(['list_positions', 'list_connections'])
    const results = runEvents(run_id).filter(
      (e): e is Extract<RunEvent, { type: 'tool.result' }> => e.type === 'tool.result',
    )
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok'])

    const completed = runEvents(run_id).find(
      (e): e is Extract<RunEvent, { type: 'run.completed' }> => e.type === 'run.completed',
    )
    expect(completed?.summary).toMatch(/^这个工作区现在有 \d+ 个岗位/)
    expect(completed?.summary).not.toMatch(/退货|查了/)

    const view = await dataOf<{
      matter: { context: { summary: string } }
      timeline: { kind: string; text: string }[]
    }>(await call('GET', `/v1/matters/${out.matter.id}`))
    const reply = view.timeline.find((e) => e.kind === 'agent_message')?.text ?? ''
    // 岗位名来自制度面（真装配）：随便挑一个真实存在的岗位名，回答里得有
    const positions = await server.org.port.positions({
      workspace_id: server.bootstrap.workspace.id,
      person_id: owner.person_id,
      assignment_id: owner.id,
      role_id: 'common.owner',
    })
    expect(positions.length).toBeGreaterThan(0)
    for (const p of positions) expect(reply).toContain(p.name)
    expect(reply).toContain('**最该先处理的')
    expect(reply).not.toMatch(/list_positions|list_connections|search_policies/)
    expect(view.matter.context.summary).toContain('个岗位')
  })

  it('别的职责的工具面里没有这两个工具（问同一句也不会去调）', async () => {
    const care = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id: 'dtc.support',
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store', id: 'store_1' }],
    })
    const out = await dataOf<{ run_id?: string }>(
      await call('POST', `/v1/positions/${care.id}/matters`, {
        body: { title: ASK, role_id: 'dtc.support' },
        assignment: care.id,
      }),
    )
    expect(out.run_id).toBeDefined()
    const called = toolsCalled(out.run_id ?? '')
    expect(called).not.toContain('list_positions')
    expect(called).not.toContain('list_connections')
  })
})
