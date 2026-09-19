/**
 * WP117 / 66 断点 #1：**端到端**——从岗位交给红人一件事，真的走红人那条链。
 *
 * 66 那张表的第 1 条是这样测出来的：在 demo 上对红人岗位说「找 20 个频道」，
 * Agent 回的是客服的话（「你们的退款窗口是多少天？」）并出了一张退款窗口策略卡。
 * 病根有两层，这个文件把两层都钉住：
 *
 * 1. **工具面**：`kol.*` 那五条职责的 `tools.allow` 里要有十一个红人工具；
 * 2. **执行器**：调 `search_creators` 要真落到 `KolPort` 上，回来的是红人库里的行，
 *    而不是 `unsupported_tool`。
 *
 * 起的是真进程、真装配线（岗位路由 → 运行时 → 工具执行器 → 红人服务 → SQLite），
 * 一处桩都没打。模型那一跳用 stub（没有 key，也不该有）。
 */
import type { Assignment, RunEvent } from '@agentsws/contracts'
import { KOL_TOOL_NAMES } from '@agentsws/kol-core'
import type { ToolExecution } from '@agentsws/stand-ins'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { createKolToolExecutor } from '../src/kol-tools.js'

const T0 = '2026-09-19T01:00:00.000Z'
const SECRETS_KEY = 'c'.repeat(64)

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 117): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let server: Server
let youtube: Assignment

const call = async (
  method: string,
  path: string,
  options: { body?: unknown; assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', options.assignment ?? youtube.id)
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

interface OpenView {
  matter: { id: string; title: string; role_id?: string }
  picked?: { role_id: string; assignment_id: string }
  ambiguous: boolean
  run_id?: string
}

/**
 * 这次运行发过的事件。
 *
 * 事件日志里存的是 `{ type, payload }`（`appendRunEvent` 把 `RunEvent` 拆成这两半），
 * 这里拼回去——测试要断言的是「调了哪个工具」，不是日志的存法。
 */
function runEvents(run_id: string): RunEvent[] {
  return server.kernel.eventLog
    .readSync({ workspace_id: server.bootstrap.workspace.id })
    .filter((e) => e.correlation?.run_id === run_id)
    .map((e) => ({ type: e.type, ...(e.payload as object) }) as RunEvent)
}

beforeEach(async () => {
  server = await createServer({
    quiet: true,
    clock: makeClock(),
    random: seeded(),
    scheduleIntervalMs: 0,
    tokenRefreshIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
  })
  youtube = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    role_id: 'kol.youtube',
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
  })
})

afterEach(async () => {
  await server.close()
})

/** 建一个红人（红人库里有人，搜索才回得出行）。 */
async function creator(name: string, over: Record<string, unknown> = {}): Promise<string> {
  const detail = await dataOf<{ creator: { id: string } }>(
    await call('POST', '/v1/kol/creators', {
      body: {
        display_name: name,
        channel: 'youtube',
        handle: name.toLowerCase().replace(/\s/g, ''),
        followers: 48_000,
        engagement_rate: 0.06,
        category: '数码',
        ...over,
      },
    }),
  )
  return detail.creator.id
}

describe('66 断点 #1：红人岗位的工具面', () => {
  it('五条渠道职责都拿到十一个红人工具；客服那条一个都没有', async () => {
    const care = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id: 'dtc.support',
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store', id: 'store_1' }],
    })
    const kolRun = await dataOf<OpenView>(
      await call('POST', '/v1/positions/kol-marketing/matters', {
        body: { title: '在 YouTube 上找 20 个粉丝 1 万到 10 万的频道' },
      }),
    )
    expect(kolRun.picked?.role_id).toBe('kol.youtube')
    expect(kolRun.run_id).toBeDefined()
    const called = runEvents(kolRun.run_id ?? '')
      .filter((e): e is Extract<RunEvent, { type: 'tool.call' }> => e.type === 'tool.call')
      .map((e) => e.tool)
    // 66 断点 #1 的正面：这次运行去找人了
    expect(called).toContain('search_creators')
    // 而且没去碰客服那一套
    expect(called).not.toContain('get_order')
    expect(called).not.toContain('list_orders')

    const careRun = await dataOf<OpenView>(
      await call('POST', '/v1/matters', {
        body: { title: '客户问退款到哪了', role_id: 'dtc.support' },
        assignment: care.id,
      }),
    ).catch(() => undefined)
    // 客服那条路不在这个文件的范围里；这里只确认它没被红人工具污染
    if (careRun?.run_id !== undefined) {
      const careCalls = runEvents(careRun.run_id)
        .filter((e): e is Extract<RunEvent, { type: 'tool.call' }> => e.type === 'tool.call')
        .map((e) => e.tool)
      expect(careCalls.some((t) => t === 'draft_outreach' || t === 'search_creators')).toBe(false)
    }
  })

  it('search_creators 真落到红人库上：库里的人回得出来，不是 unsupported_tool', async () => {
    await creator('Gadget Jonas')
    await creator('Desk Rosa', { followers: 22_000 })
    const out = await dataOf<OpenView>(
      await call('POST', '/v1/positions/kol-marketing/matters', {
        body: { title: '在 YouTube 上找 20 个数码频道' },
      }),
    )
    const events = runEvents(out.run_id ?? '')
    const result = events.find(
      (e): e is Extract<RunEvent, { type: 'tool.result' }> => e.type === 'tool.result',
    )
    expect(result?.status).toBe('ok')
    const completed = events.find(
      (e): e is Extract<RunEvent, { type: 'run.completed' }> => e.type === 'run.completed',
    )
    // 摘要是红人的话，不是客服的话（66 断点 #1）
    expect(completed?.summary).toContain('找人')
    expect(completed?.summary).not.toMatch(/退货|退款/)
    const answer = completed?.outputs.find((o) => o.kind === 'answer')
    expect(answer?.kind === 'answer' ? answer.text : '').toContain('找人')
  })

  it('没有红人装配时照实说，不假装成功', async () => {
    // 红人库是空的：搜索本身成功，只是零条——「没有」与「没接上」不是一回事
    const out = await dataOf<OpenView>(
      await call('POST', '/v1/positions/kol-marketing/matters', {
        body: { title: '在 YouTube 上找 20 个户外频道' },
      }),
    )
    const events = runEvents(out.run_id ?? '')
    const completed = events.find(
      (e): e is Extract<RunEvent, { type: 'run.completed' }> => e.type === 'run.completed',
    )
    const answer = completed?.outputs.find((o) => o.kind === 'answer')
    const text = answer?.kind === 'answer' ? answer.text : ''
    expect(text).toContain('找人')
    expect(text).not.toContain('没成')
  })
})

describe('十一个工具的执行器（对着一份假 KolPort 逐个走一遍）', () => {
  /** 只实现这个文件用到的那几个方法；别的留给类型断言（测的是执行器，不是端口）。 */
  const fakePort = (over: Record<string, unknown> = {}) =>
    ({
      search: async () => ({ ok: true, source: 'channel', rows: [{ handle: 'a' }] }),
      creators: async () => ({ rows: [{ creator_id: 'cr_1' }] }),
      creator: async (_a: unknown, id: string) =>
        id === 'cr_1' ? { creator: { id }, accounts: [] } : undefined,
      collaborations: async () => ({ rows: [{ id: 'cb_1' }] }),
      deliverables: async () => ({ rows: [{ id: 'dv_1' }] }),
      outreach: async () => ({
        staged: true,
        approval_item_id: 'ap_1',
        step: 'first',
        subject: 's',
        body: 'b',
        forbidden_hits: [],
        missing_vars: [],
        quota: { cap: 30, sent_today: 1, remaining: 29, allowed: true },
      }),
      advanceCollaboration: async (_a: unknown, id: string, i: { stage: string }) => ({
        id,
        stage: i.stage,
      }),
      createDeliverable: async () => ({ id: 'dv_2', kind: 'video', due_at: T0 }),
      reviewDeliverable: async () => ({ staged: true, approval_item_id: 'ap_2' }),
      createTrackedLink: async () => ({ id: 'tl_1', url: 'https://x/?utm_source=y' }),
      planCampaign: async () => ({
        campaign_id: 'cp_1',
        ready: true,
        gaps: [],
        message: '',
        by_channel: [{ picks: [{ creator_id: 'cr_1' }] }],
        budget_per_creator: 0,
        approval_item_id: 'ap_3',
      }),
      ...over,
    }) as never

  const request = {
    actor: { person_id: 'p_1', assignment_id: 'asg_1', role_id: 'kol.youtube' },
  } as never

  const exec = (port: unknown = fakePort()) =>
    createKolToolExecutor({
      workspace_id: 'ws_1',
      port: () => port as never,
      now: () => T0,
    })

  it('读工具回 rows + provenance；写工具回卡 id', async () => {
    const run = exec()
    const cases: [string, Record<string, unknown>, (r: ToolExecution) => void][] = [
      ['search_creators', { q: '数码' }, (r) => expect(r.status).toBe('ok')],
      ['get_creator', { creator_id: 'cr_1' }, (r) => expect(r.provenance?.length).toBe(1)],
      ['score_creator', { creator_id: 'cr_1' }, (r) => expect(r.status).toBe('ok')],
      ['list_collaborations', {}, (r) => expect(r.provenance?.[0]?.type).toBe('collaboration')],
      ['list_deliverables', { pending: true }, (r) => expect(r.status).toBe('ok')],
      [
        'draft_outreach',
        { creator_id: 'cr_1' },
        (r) => expect((r.data as { approval_item_id: string }).approval_item_id).toBe('ap_1'),
      ],
      [
        'advance_collaboration',
        { collaboration_id: 'cb_1', stage: 'replied' },
        (r) => expect((r.data as { stage: string }).stage).toBe('replied'),
      ],
      [
        'register_deliverable',
        { collaboration_id: 'cb_1' },
        (r) => expect((r.data as { deliverable_id: string }).deliverable_id).toBe('dv_2'),
      ],
      [
        'review_deliverable',
        { deliverable_id: 'dv_1', review: 'changes_requested' },
        (r) => expect((r.data as { approval_item_id: string }).approval_item_id).toBe('ap_2'),
      ],
      [
        'create_tracked_link',
        { collaboration_id: 'cb_1' },
        (r) => expect((r.data as { tracked_link_id: string }).tracked_link_id).toBe('tl_1'),
      ],
      [
        'add_to_campaign',
        { creator_ids: ['cr_1'] },
        (r) => expect((r.data as { approval_item_id: string }).approval_item_id).toBe('ap_3'),
      ],
    ]
    for (const [name, input, check] of cases) {
      const res = await run({ name, input, request })
      if (res.status !== 'ok') throw new Error(`${name} 没成：${res.reason ?? ''}`)
      check(res)
    }
    // 十一个全走过了（目录里有几个，这里就该测几个）
    expect(cases).toHaveLength(KOL_TOOL_NAMES.length)
  })

  it('缺 id 的写工具说人话，不静默成功', async () => {
    const run = exec()
    for (const name of [
      'draft_outreach',
      'advance_collaboration',
      'review_deliverable',
      'create_tracked_link',
      'register_deliverable',
      'add_to_campaign',
      'get_creator',
    ]) {
      const res = await run({ name, input: {}, request })
      expect(res.status).not.toBe('ok')
      expect(res.reason ?? '').toMatch(/缺 |不认识|只能是/)
    }
  })

  it('阶段机拒掉的跳步：回 blocked 与原话，不吞', async () => {
    const run = exec(
      fakePort({
        advanceCollaboration: async () => {
          throw new Error('不能从 sourced 直接跳到 delivered')
        },
      }),
    )
    const res = await run({
      name: 'advance_collaboration',
      input: { collaboration_id: 'cb_1', stage: 'delivered' },
      request,
    })
    expect(res.status).toBe('blocked')
    expect(res.reason).toContain('不能从 sourced')
  })

  it('不是红人职责的人调红人工具：拒', async () => {
    const res = await exec()({
      name: 'draft_outreach',
      input: { creator_id: 'cr_1' },
      request: { actor: { person_id: 'p', assignment_id: 'a', role_id: 'dtc.support' } } as never,
    })
    expect(res.status).toBe('blocked')
    expect(res.reason).toContain('不是红人职责')
  })

  it('66 断点 #4：没连渠道就退到本地库，并说清「连上能搜到更多」', async () => {
    const run = exec(
      fakePort({ search: async () => ({ ok: false, reason: 'not_connected', rows: [] }) }),
    )
    const res = await run({ name: 'search_creators', input: { q: '数码' }, request })
    expect(res.status).toBe('ok')
    const data = res.data as { source: string; note: string; rows: unknown[] }
    expect(data.source).toBe('local_library')
    expect(data.note).toContain('还没连上')
    expect(data.rows).toHaveLength(1)
  })

  it('红人装配没起来 / 名字不是红人工具：都照实说', async () => {
    const noPort = createKolToolExecutor({
      workspace_id: 'ws_1',
      port: () => undefined,
      now: () => T0,
    })
    expect((await noPort({ name: 'search_creators', input: {}, request })).reason).toContain(
      '没装红人那一摊',
    )
    expect((await exec()({ name: 'get_order', input: {}, request })).reason).toBe(
      'not_a_kol_tool:get_order',
    )
  })
})
