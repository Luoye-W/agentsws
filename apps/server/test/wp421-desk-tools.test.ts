/**
 * WP421（自查 general 组，决策 1266–1270）：公关 / 内容与搜索 / B2B / 设计的读数与起草工具。
 *
 * 钉住的事：
 *
 * 1. 工具按职责给（`deskToolsFor` 一张表），执行器再判一次：别的职责点名调是 `blocked`；
 * 2. 端到端（stub，真服务）：快捷问题进 Run → 调对应工具 → 回话照抄工具的结论，没有工具名；
 *    起草新闻稿出卡（库里一篇草稿）、下设计需求单落库；读不到的照实说（不当成 0）；
 * 3. 存联系人必须有来源网址；`search_facts` 是知识库检索（记录源认它）。
 */
import type { Assignment, RunEvent } from '@agentsws/contracts'
import { DESK_TOOL_NAMES, deskToolsFor, toolWordZh } from '@agentsws/stand-ins'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDeskToolExecutor } from '../src/desk-tools.js'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-19T01:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)

describe('按职责给（一张表）', () => {
  it('新闻稿 / 论坛 / 内容 / B2B / 设计各拿各的；复制出来的职责按原职责给', () => {
    expect(deskToolsFor('pr.press')).toEqual(['draft_press_release', 'list_press_releases'])
    expect(deskToolsFor('pr.forums')).toEqual(['draft_forum_post', 'list_forum_posts'])
    // WP446：读 GEO 归 SEO 与 GEO；向设计岗下单还在内容与博客
    expect(deskToolsFor('dtc.seo')).toContain('query_geo_metrics')
    expect(deskToolsFor('dtc.content')).not.toContain('query_geo_metrics')
    expect(deskToolsFor('dtc.content')).toContain('request_design')
    expect(deskToolsFor('b2b.fulfillment')).toEqual(['list_b2b_records'])
    expect(deskToolsFor('b2b.sales-custom')).toEqual(['list_b2b_records', 'save_b2b_contacts'])
    expect(deskToolsFor('design.amazon')).toEqual(['get_brand_system', 'list_design_requests'])
    expect(deskToolsFor('b2b.exhibition')).toContain('request_design')
    expect(deskToolsFor('pr.monitoring')).toEqual([])
    expect(deskToolsFor('site.shopify-theme')).toEqual([])
    expect([...DESK_TOOL_NAMES].sort()).toEqual(DESK_TOOL_NAMES)
    for (const n of DESK_TOOL_NAMES) expect(toolWordZh(n)).not.toBe('一个工具')
  })

  it('执行器再判一次：别的职责点名调是 blocked', async () => {
    const exec = createDeskToolExecutor({})
    const out = await exec({
      name: 'list_b2b_records',
      input: { kind: 'samples' },
      request: {
        workspace_id: 'ws_1',
        actor: { person_id: 'per_1', assignment_id: 'asg_1', role_id: 'dtc.support' },
      } as never,
    })
    expect(out.status).toBe('blocked')
  })

  it('存联系人必须有来源网址（没来源的名单后面也发不了开发信）', async () => {
    const exec = createDeskToolExecutor({
      b2b: () => ({ store: {} as never, port: { importCsv: async () => ({}) } as never }),
    })
    const out = await exec({
      name: 'save_b2b_contacts',
      input: { list_name: '德国分销', contacts: [{ company: 'Volthaus' }] },
      request: {
        workspace_id: 'ws_1',
        actor: { person_id: 'per_1', assignment_id: 'asg_1', role_id: 'b2b.outbound' },
      } as never,
    })
    expect(out.status).toBe('error')
    expect(out.reason).toContain('来源网址')
  })
})

let server: Server

async function call(
  method: string,
  path: string,
  options: { body?: unknown; assignment: string },
): Promise<Response> {
  const headers = new Headers({ Authorization: `Bearer ${server.bootstrap.internalToken}` })
  headers.set('X-Assignment', options.assignment)
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

const toolsCalled = (run_id: string): string[] =>
  server.kernel.eventLog
    .readSync({ workspace_id: server.bootstrap.workspace.id })
    .filter((e) => e.correlation?.run_id === run_id && e.type === 'tool.call')
    .map((e) => (e.payload as Extract<RunEvent, { type: 'tool.call' }>).tool)

const assign = (role_id: string): Assignment =>
  server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    role_id,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'brand', id: server.bootstrap.workspace.id }],
  })

/** 在这条职责上开一件事（stub 按标题跑一轮），回调了哪些工具与 AI 的回话。 */
async function ask(a: Assignment, title: string): Promise<{ tools: string[]; reply: string }> {
  const out = await dataOf<{ matter: { id: string }; run_id?: string }>(
    await call('POST', `/v1/positions/${a.id}/matters`, {
      body: { title, role_id: a.role_id },
      assignment: a.id,
    }),
  )
  const view = await dataOf<{ timeline: { kind: string; text: string }[] }>(
    await call('GET', `/v1/matters/${out.matter.id}`, { assignment: a.id }),
  )
  return {
    tools: toolsCalled(out.run_id ?? ''),
    reply: view.timeline.find((e) => e.kind === 'agent_message')?.text ?? '',
  }
}

describe('端到端（stub，真服务）', () => {
  beforeEach(async () => {
    server = await createServer({
      quiet: true,
      clock: { now: () => T0 },
      random: () => 0.42,
      scheduleIntervalMs: 0,
      tokenRefreshIntervalMs: 0,
      env: { AGENTSWS_OWNER_EMAIL: 'owner@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
    })
  })
  afterEach(async () => {
    await server.close()
  })

  it('新闻稿：「起草一篇新品发布的新闻稿」→ 起草工具出卡，库里一篇草稿；回话没有工具名', async () => {
    const press = assign('pr.press')
    const { tools, reply } = await ask(press, '帮我起草一篇新品发布的新闻稿，下周三发')
    expect(tools).toEqual(['draft_press_release'])
    expect(reply).toContain('新闻稿草稿出卡了')
    expect(reply).not.toMatch(/draft_press_release/)
    const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
    const rows = brand.pr.releases({})
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('draft')
    expect(rows[0]?.quotes).toEqual([])
  })

  it('B2B 业务：「样品到哪了」→ 读 B2B 库；库是空的照实说', async () => {
    const sales = assign('b2b.sales')
    const empty = await ask(sales, '样品到哪了？')
    expect(empty.tools).toEqual(['list_b2b_records'])
    expect(empty.reply).toContain('B2B 库里还没有样品')
    server.b2b.put('b2b_account', {
      id: 'acc_volt',
      name: 'Volthaus',
      product_lines: [],
      stage: 'sampling',
      source: { kind: 'import', observed_at: T0 },
      created_at: T0,
      updated_at: T0,
    })
    server.b2b.put('b2b_sample', {
      id: 'smp_1',
      account_id: 'acc_volt',
      items: [{ sku: 'GAN-65', qty: 2 }],
      status: 'shipped',
      carrier: 'DHL',
      tracking_no: '123',
      ship_by: T0,
      updated_at: T0,
    })
    const one = await ask(sales, '样品到哪了？')
    expect(one.reply).toContain('Volthaus · GAN-65×2 · 已寄')
  })

  it('SEO 与 GEO：「AI 搜索里有没有我们」→ 读 GEO；没跑过照实说', async () => {
    const content = assign('dtc.seo')
    const { tools, reply } = await ask(content, 'AI 搜索里有没有我们？')
    expect(tools).toEqual(['query_geo_metrics'])
    expect(reply).toContain('还没跑过')
  })

  it('设计：别的岗位下单 → 需求单落库；设计岗「有哪些单等着我」读得到', async () => {
    const store = assign('dtc.store')
    const asked = await ask(store, '下一张单给设计岗：新品首页主视觉，桌面和手机各一张')
    expect(asked.tools).toEqual(['request_design'])
    expect(asked.reply).toContain('独立站设计')
    const designer = assign('design.dtc')
    const queue = await ask(designer, '有哪些单等着我？')
    expect(queue.tools).toEqual(['list_design_requests'])
    expect(queue.reply).toContain('有 1 张需求单')
  })
})
