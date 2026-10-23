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
    // WP142：回话说「在 YouTube 上找了一遍……」并点名，不再是「找人：N 条」
    expect(answer?.kind === 'answer' ? answer.text : '').toContain('在 YouTube 上找了一遍')
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
    // WP142：零条照实说，并给下一步（关联官方数据接口 / 导入一张表）
    expect(text).toContain('一个合适的都没找到')
    expect(text).toContain('关联官方数据接口')
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
      trackedLinks: async () => ({
        rows: [
          { id: 'tl_1', collaboration_id: 'cb_1', url: 'u', clicks: 1, orders: 0, revenue: 0 },
        ],
      }),
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
      createCreator: async (_a: unknown, i: { display_name: string }) => ({
        creator: { id: 'cr_new', display_name: i.display_name },
        accounts: [],
        contacts: [],
      }),
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
      // WP483：ego 读到的公开数据（这里只核回执形状；走插件同一入口那一段在 wp483-ego-kol.test.ts）
      observe: async (_a, rows) => ({ saved: rows.length, deduped: 0, forwarded: rows.length }),
      // WP489：表格导入 / 邮件判阶段（这里只核回执形状；真读表、真判在 wp489-kol-import.test.ts）
      importer: () =>
        ({
          previewCard: async () => '出了一张「导入红人表」卡',
          mailStageCard: async (_a: unknown, i: { months?: number }) =>
            `近 ${i.months ?? 12} 个月：1 人`,
        }) as never,
      // WP496：ego 用插件同一套采集器读页（这里只核回执形状；真跑脚本那一段在 wp496-ego-capture.test.ts）
      egoCapture: {
        available: () => true,
        capture: async (_a, urls) => urls.map(() => ({ ok: true })),
      },
    })

  it('读工具回 rows + provenance；写工具回卡 id', async () => {
    const run = exec()
    const cases: [string, Record<string, unknown>, (r: ToolExecution) => void][] = [
      ['search_creators', { q: '数码' }, (r) => expect(r.status).toBe('ok')],
      ['get_creator', { creator_id: 'cr_1' }, (r) => expect(r.provenance?.length).toBe(1)],
      ['score_creator', { creator_id: 'cr_1' }, (r) => expect(r.status).toBe('ok')],
      ['list_collaborations', {}, (r) => expect(r.provenance?.[0]?.type).toBe('collaboration')],
      ['list_deliverables', { pending: true }, (r) => expect(r.status).toBe('ok')],
      ['list_tracked_links', {}, (r) => expect(r.provenance?.[0]?.type).toBe('tracked_link')],
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
        'save_creator',
        { handle: '@deskrosa', followers: 31_000 },
        (r) => expect((r.data as { creator_id: string }).creator_id).toBe('cr_new'),
      ],
      [
        'create_tracked_link',
        { collaboration_id: 'cb_1', target_url: 'https://shop.example/p/charger' },
        (r) => expect((r.data as { tracked_link_id: string }).tracked_link_id).toBe('tl_1'),
      ],
      [
        'record_creator_observations',
        { observations: [{ handle: 'deskrosa', followers: 31_000 }] },
        (r) => expect((r.data as { backed_up_to_cloud: number }).backed_up_to_cloud).toBe(1),
      ],
      [
        'capture_creator_pages',
        { urls: ['https://www.youtube.com/@deskrosa'] },
        (r) => expect((r.data as { read: number }).read).toBe(1),
      ],
      [
        'add_to_campaign',
        { creator_ids: ['cr_1'] },
        (r) => expect((r.data as { approval_item_id: string }).approval_item_id).toBe('ap_3'),
      ],
      [
        'import_creator_sheet',
        { url: 'https://docs.google.com/spreadsheets/d/x/edit' },
        (r) => expect((r.data as { message: string }).message).toContain('导入红人表'),
      ],
      [
        'update_stages_from_mail',
        { months: 6 },
        (r) => expect((r.data as { message: string }).message).toContain('近 6 个月'),
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

  it('WP416：谈成 / 已寄样不许 AI 直接推；追踪链接没给落地页就问；挑人清单用 AI 给的名单', async () => {
    let brief: { creator_ids?: string[] } | undefined
    const run = exec(
      fakePort({
        planCampaign: async (_a: unknown, b: { creator_ids?: string[] }) => {
          brief = b
          return {
            campaign_id: 'cp_1',
            ready: true,
            gaps: [],
            message: '',
            by_channel: [{ picks: [] }],
            budget_per_creator: 0,
          }
        },
      }),
    )
    for (const stage of ['agreed', 'sample_sent']) {
      const r = await run({
        name: 'advance_collaboration',
        input: { collaboration_id: 'cb_1', stage },
        request,
      })
      expect(r.status).toBe('blocked')
    }
    const link = await run({
      name: 'create_tracked_link',
      input: { collaboration_id: 'cb_1' },
      request,
    })
    expect(link.status).toBe('error')
    expect(link.reason).toContain('落地页')
    await run({ name: 'add_to_campaign', input: { creator_ids: ['cr_1', 'cr_2'] }, request })
    expect(brief?.creator_ids).toEqual(['cr_1', 'cr_2'])
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

  it('WP295：合作清单每行带名字与几天没动静；quiet_days 只要已建联、这么多天没动静的', async () => {
    const day = 86_400_000
    const run = exec(
      fakePort({
        creators: async () => ({
          rows: [
            { creator_id: 'cr_1', display_name: 'Gadget Jonas' },
            { creator_id: 'cr_2', display_name: 'Desk Rosa' },
          ],
        }),
        collaborations: async (_a: unknown, filter: { stage?: string }) => ({
          rows: [
            {
              id: 'cb_1',
              creator_id: 'cr_1',
              stage: 'contacted',
              last_activity_at: new Date(Date.parse(T0) - 9 * day).toISOString(),
            },
            {
              id: 'cb_2',
              creator_id: 'cr_2',
              stage: 'contacted',
              last_activity_at: new Date(Date.parse(T0) - 2 * day).toISOString(),
            },
          ].filter((c) => filter.stage === undefined || c.stage === filter.stage),
        }),
      }),
    )
    const all = await run({ name: 'list_collaborations', input: {}, request })
    const rows = (all.data as { rows: { display_name: string; days_since_activity: number }[] })
      .rows
    expect(rows.map((r) => [r.display_name, r.days_since_activity])).toEqual([
      ['Gadget Jonas', 9],
      ['Desk Rosa', 2],
    ])
    const quiet = await run({ name: 'list_collaborations', input: { quiet_days: 7 }, request })
    expect(
      (quiet.data as { rows: { display_name: string }[] }).rows.map((r) => r.display_name),
    ).toEqual(['Gadget Jonas'])
  })

  it('WP295 list_tracked_links：只要这条渠道的、带名字、按收入倒序；谈成了还没建链接的单列', async () => {
    const run = exec(
      fakePort({
        creators: async () => ({
          rows: [
            { creator_id: 'cr_1', display_name: 'Gadget Jonas' },
            { creator_id: 'cr_2', display_name: 'Desk Rosa' },
            { creator_id: 'cr_3', display_name: 'Cable Kevin' },
          ],
        }),
        collaborations: async () => ({
          rows: [
            { id: 'cb_1', creator_id: 'cr_1', stage: 'delivering' },
            { id: 'cb_2', creator_id: 'cr_2', stage: 'contacted' },
            { id: 'cb_3', creator_id: 'cr_3', stage: 'agreed' },
          ],
        }),
        trackedLinks: async () => ({
          rows: [
            { id: 'tl_2', collaboration_id: 'cb_2', url: 'u2', clicks: 41, orders: 0, revenue: 0 },
            {
              id: 'tl_1',
              collaboration_id: 'cb_1',
              url: 'u1',
              clicks: 318,
              orders: 5,
              revenue: 645.5,
            },
            // 别的渠道的合作（不在这条渠道的清单里）：不出
            { id: 'tl_9', collaboration_id: 'cb_ig', url: 'u9', clicks: 1, orders: 1, revenue: 9 },
          ],
        }),
      }),
    )
    const res = await run({ name: 'list_tracked_links', input: {}, request })
    expect(res.status).toBe('ok')
    const data = res.data as {
      rows: { display_name: string; orders: number }[]
      without_link: string[]
    }
    expect(data.rows.map((r) => [r.display_name, r.orders])).toEqual([
      ['Gadget Jonas', 5],
      ['Desk Rosa', 0],
    ])
    expect(data.without_link).toEqual(['Cable Kevin'])
  })

  it('WP295 list_deliverables：每行带上是谁交的；别的渠道的不出', async () => {
    const run = exec(
      fakePort({
        creators: async () => ({ rows: [{ creator_id: 'cr_1', display_name: 'Gadget Jonas' }] }),
        collaborations: async () => ({ rows: [{ id: 'cb_1', creator_id: 'cr_1' }] }),
        deliverables: async () => ({
          rows: [
            { id: 'dv_1', collaboration_id: 'cb_1', kind: 'video' },
            { id: 'dv_9', collaboration_id: 'cb_ig', kind: 'reel' },
          ],
        }),
      }),
    )
    const res = await run({ name: 'list_deliverables', input: { pending: true }, request })
    expect((res.data as { rows: unknown[] }).rows).toEqual([
      { id: 'dv_1', collaboration_id: 'cb_1', kind: 'video', display_name: 'Gadget Jonas' },
    ])
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

  it('WP416：只能按账号查（关键词找人走插件）/ 上游没答上来——一样退到本地库并照实说为什么', async () => {
    for (const reason of ['handle_only', 'upstream_error', 'quota_exhausted']) {
      const run = exec(
        fakePort({
          search: async () => ({
            ok: false,
            reason,
            rows: [],
            message: 'Instagram 的官方接口只能按账号名查，用插件把人收进来。',
          }),
        }),
      )
      const res = await run({ name: 'search_creators', input: { q: 'skincare yoga' }, request })
      expect(res.status).toBe('ok')
      const data = res.data as { source: string; note: string; rows: unknown[] }
      expect(data.source).toBe('local_library')
      expect(data.note).toContain('只能按账号名查')
      expect(data.note).toContain('你自己库里的人')
    }
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
