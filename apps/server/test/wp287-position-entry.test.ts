/**
 * WP287（Luoye 10-09 Windows 真机）：岗位入口问一句答一句、不卡在选职责、失败要看得见。
 * 真装配线（路由 → 岗位面 → 工作模型 → 运行时 stub），只在失败那几条上把运行时适配器换成替身。
 */
import type { MatterEvent, RunEvent, RunRequest, RunResult } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-09T02:00:00.000Z'

function makeClock(start = T0) {
  const t = Date.parse(start)
  return { now: () => new Date(t).toISOString() }
}

let server: Server
const WEB_OPS_ROLES = ['dtc.store', 'dtc.content', 'dtc.email-marketing', 'dtc.fulfillment']

const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  if (body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

const dataOf = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: unknown; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data as T
}

interface OpenView {
  mode?: 'ask' | 'task'
  answer?: { outcome: string; text: string; sources: string[]; failure?: string }
  matter: { id: string; ask?: boolean; role_id?: string }
  picked?: { role_id: string }
  ambiguous: boolean
  approval_item_id?: string
  run_id?: string
}

const open = async (title: string, extra: Record<string, unknown> = {}): Promise<OpenView> =>
  dataOf<OpenView>(await call('POST', '/v1/positions/web-ops/matters', { title, ...extra }))

const timeline = (id: string): MatterEvent[] => server.work.store.listMatterEvents(id)
const openMatters = async (): Promise<number> =>
  (await dataOf<{ open_matters: number }>(await call('GET', '/v1/positions/web-ops'))).open_matters

const eventsOf = async (type: string): Promise<Record<string, unknown>[]> => {
  const out: Record<string, unknown>[] = []
  for await (const e of server.kernel.eventLog.read({
    workspace_id: server.bootstrap.workspace.id,
  }))
    if (e.type === type) out.push(e.payload as Record<string, unknown>)
  return out
}

const result = (req: RunRequest, status: RunResult['status'], summary: string): RunResult => ({
  request_id: req.id,
  status,
  outputs: [],
  provenance: { run_id: req.id, seen: {}, read_full: [], recorded_at: T0 },
  memory_candidates: [],
  lessons: [],
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    tool_calls: 0,
    seconds: 0,
    cost_base: 0,
  },
  session_ref: { runtime: 'stub', session_id: 's' },
  summary,
})

/** 把运行时换成「一启动就失败」（真机现场：工具参数表 dsh 不认）。 */
const failRuns = () => {
  const adapter = server.runtime?.adapter
  if (adapter === undefined) throw new Error('没有运行时')
  return vi
    .spyOn(adapter, 'run')
    .mockImplementation(async (req: RunRequest, sink: (e: RunEvent) => void) => {
      sink({
        type: 'run.failed',
        error: {
          code: 'internal',
          message: 'tools[3].input_schema: unsupported keyword',
          retryable: false,
        },
      })
      return result(req, 'failed', 'dsh 组合装配失败：tools[3].input_schema: unsupported keyword')
    })
}

beforeEach(async () => {
  server = await createServer({
    clock: makeClock(),
    quiet: true,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
  for (const role_id of WEB_OPS_ROLES)
    server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id,
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store', id: 'store_1' }],
    })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await server.close()
})

describe('WP287 ① 问一句当场答', () => {
  it('「现在店铺里有哪些产品」→ 当场答，不建进行中的事、不出选择卡', async () => {
    const out = await open('现在店铺里有哪些产品')
    expect(out.mode).toBe('ask')
    expect(out.matter.ask).toBe(true)
    expect(out.approval_item_id).toBeUndefined()
    expect(out.answer?.outcome).toBe('answered')
    expect(out.answer?.text.length).toBeGreaterThan(0)
    expect(out.run_id).toBeDefined()
    // 不进任何列表：岗位页「N 件在办」、工作、默认事项列表
    expect(await openMatters()).toBe(0)
    expect(server.work.listMatters().map((m) => m.id)).not.toContain(out.matter.id)
    const work = await dataOf<{ items: { id?: string; matter_id?: string }[] }>(
      await call('GET', '/v1/positions/web-ops/work'),
    )
    expect(JSON.stringify(work)).not.toContain(out.matter.id)
    expect(server.work.listMatters({ asks: true }).map((m) => m.id)).toContain(out.matter.id)
  })

  it('交办（「把 A 商品降价 10%」）照旧建一件事', async () => {
    const out = await open('把 A 商品降价 10%')
    expect(out.mode).toBe('task')
    expect(out.answer).toBeUndefined()
    expect(out.matter.ask).toBeUndefined()
    expect(out.picked?.role_id).toBe('dtc.store')
    expect(await openMatters()).toBe(1)
  })

  it('「转成一件事」→ 进「进行中」，时间线记一句', async () => {
    const out = await open('现在店铺里有哪些产品')
    const res = await call('POST', `/v1/matters/${out.matter.id}/promote`)
    expect(res.status).toBe(200)
    expect(server.work.getMatter(out.matter.id)?.ask).toBeUndefined()
    expect(await openMatters()).toBe(1)
    expect(timeline(out.matter.id).some((e) => e.text === '转成了一件事')).toBe(true)
  })

  it('答的时候出了卡（要动手）→ 自动转成一件事，回答里说一句', async () => {
    const adapter = server.runtime?.adapter
    if (adapter === undefined) throw new Error('没有运行时')
    vi.spyOn(adapter, 'run').mockImplementation(async (req: RunRequest) => {
      const matter_id = req.work_item?.id as string
      server.work.appendEvent(matter_id, {
        kind: 'card',
        text: '改价：A 商品 -10%',
        actor: { kind: 'agent', id: req.id },
        approval_item_id: 'apr_fake',
        run_id: req.id,
      })
      return result(req, 'completed', '出了一张改价卡')
    })
    const out = await open('A 商品现在多少钱')
    expect(out.mode).toBe('ask')
    expect(out.answer?.outcome).toBe('promoted')
    expect(server.work.getMatter(out.matter.id)?.ask).toBeUndefined()
    expect(await openMatters()).toBe(1)
  })

  it('「你好」当场回一句问要做什么（不起运行）', async () => {
    const out = await open('你好')
    expect(out.mode).toBe('ask')
    expect(out.answer?.text).toContain('想让我做什么')
    expect(out.run_id).toBeUndefined()
    expect(await openMatters()).toBe(0)
  })

  it('点名要开一件事（mode: task）就开一件事', async () => {
    const out = await open('现在店铺里有哪些产品', { mode: 'task' })
    expect(out.mode).toBe('task')
    expect(await openMatters()).toBe(1)
  })
})

describe('WP287 ② 岗位入口永远不出选择卡', () => {
  it('一个判据词都没命中（交办）→ 按先后取第一条，时间线记 settled 那一行，挂其余三条', async () => {
    const out = await open('整理一下', { mode: 'task' })
    expect(out.ambiguous).toBe(false)
    expect(out.approval_item_id).toBeUndefined()
    expect(out.picked?.role_id).toBe('dtc.store')
    const routed = timeline(out.matter.id).find((e) => e.actor.id === 'position_router')
    expect(routed?.route?.picked).toBe('dtc.store')
    expect(routed?.route?.options.map((o) => o.role_id)).toEqual([
      'dtc.content',
      'dtc.email-marketing',
      'dtc.fulfillment',
    ])
    const queue = await server.txn.approvals.queue({
      workspace_id: server.bootstrap.workspace.id,
      person_id: server.bootstrap.person.id,
      lane: 'mine',
    })
    expect(queue.filter((c) => c.kind === 'claim')).toEqual([])
    const routedEvents = await eventsOf('matter.routed')
    expect(routedEvents.at(-1)).toMatchObject({ settled: 'first_duty', mode: 'task' })
  })
})

describe('WP287 ③ 没跑成要看得见', () => {
  it('交办：运行一启动就失败 → 时间线「没跑成：<人话>」+ 失败标记，不写「跑完了」；原始错误只在事件日志', async () => {
    failRuns()
    const out = await open('把 A 商品降价 10%')
    const events = timeline(out.matter.id)
    const failed = events.find((e) => e.failed !== undefined)
    expect(failed?.text).toBe('没跑成：工坊这边出错了，已记下，点重试或稍后再试')
    expect(failed?.failed).toEqual({ code: 'internal', retryable: false })
    expect(events.find((e) => e.run_digest !== undefined)?.run_digest?.outcome).toBe('failed')
    expect(events.some((e) => e.text === '跑完了')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('input_schema')
    const raw = await eventsOf('run.failed')
    expect(JSON.stringify(raw)).toContain('input_schema')
  })

  it('重试：按原话再跑一次（不伪造人话），这次跑完了', async () => {
    const spy = failRuns()
    const out = await open('把 A 商品降价 10%')
    spy.mockRestore()
    const res = await call('POST', `/v1/matters/${out.matter.id}/retry`)
    expect(res.status).toBe(201)
    expect((await dataOf<{ run_id?: string }>(res)).run_id).toBeDefined()
    const events = timeline(out.matter.id)
    expect(events.filter((e) => e.kind === 'human_message')).toHaveLength(1)
    expect(events.some((e) => e.kind === 'run' && e.text === '重试了一次')).toBe(true)
    expect(events.filter((e) => e.run_digest?.outcome === 'completed')).toHaveLength(1)
  })

  it('问一句：没跑成 → 回答处是失败（人话），不当成答了', async () => {
    failRuns()
    const out = await open('现在店铺里有哪些产品')
    expect(out.answer?.outcome).toBe('failed')
    expect(out.answer?.failure).toBe('没跑成：工坊这边出错了，已记下，点重试或稍后再试')
  })
})
