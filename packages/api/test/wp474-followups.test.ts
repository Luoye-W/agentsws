/**
 * WP474：网关这一侧只加的几处——
 * - `POST /v1/approvals/:id/undo`：撤回本人刚才那一下（「不要」→ reopen；「通过」→ 取消窗口里 unapprove；撤不了 409）；
 * - `GET /v1/approvals/:id` 多带 `undo`（还撤不撤得回、到哪一刻）；
 * - `GET / PUT /v1/settings/work-hours`「我的作息」（端口没有就 501；下班要晚于上班、按半小时对齐）。
 */
import type { ApprovalItem, ApprovalUndo, WorkHours } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createGateway, type GatewayDeps, type WorkActor, type WorkPort } from '../src/index.js'
import { approvalItem, harness } from './helpers.js'

type Bus = GatewayDeps['approvals']

function withUndo(
  bus: Bus,
  how: ApprovalUndo | undefined,
  workspace_id: string,
): { calls: string[]; restore: ApprovalItem } {
  const calls: string[] = []
  const restore = approvalItem({ id: 'ap_undo', state: 'pending', workspace_id })
  Object.assign(bus, {
    undoable: async (id: string, by: string) => {
      calls.push(`undoable:${id}:${by}`)
      return how
    },
    reopen: async (id: string, by: string) => {
      calls.push(`reopen:${id}:${by}`)
      return restore
    },
    unapprove: async (id: string, by: string) => {
      calls.push(`unapprove:${id}:${by}`)
      return restore
    },
  })
  return { calls, restore }
}

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

describe('WP474 撤回刚才那一下', () => {
  it('「不要」的：走 reopen，回放回来的卡', async () => {
    const h = await harness()
    h.approvals.seed(
      approvalItem({ id: 'ap_undo', state: 'rejected', workspace_id: h.workspace_id }),
    )
    const { calls } = withUndo(h.approvals, { kind: 'reopen' }, h.workspace_id)
    const res = await h.post('/v1/approvals/ap_undo/undo', {})
    expect(res.status).toBe(200)
    const out = await data<{ item: ApprovalItem; undone: string }>(res)
    expect(out.undone).toBe('reopen')
    expect(out.item.state).toBe('pending')
    expect(calls).toEqual([`undoable:ap_undo:${h.person_id}`, `reopen:ap_undo:${h.person_id}`])
  })

  it('「通过」的：取消窗口里走 unapprove；详情上带 undo 和截止时刻', async () => {
    const h = await harness()
    h.approvals.seed(
      approvalItem({ id: 'ap_undo', state: 'approved', workspace_id: h.workspace_id }),
    )
    const until = '2026-09-07T09:02:00.000Z'
    const { calls } = withUndo(h.approvals, { kind: 'unapprove', until }, h.workspace_id)
    const detail = await data<ApprovalItem & { undo?: ApprovalUndo }>(
      await h.get('/v1/approvals/ap_undo'),
    )
    expect(detail.undo).toEqual({ kind: 'unapprove', until })
    const res = await h.post('/v1/approvals/ap_undo/undo', {})
    expect(res.status).toBe(200)
    expect((await data<{ undone: string }>(res)).undone).toBe('unapprove')
    expect(calls.at(-1)).toBe(`unapprove:ap_undo:${h.person_id}`)
  })

  it('撤不回（过了窗口 / 已经发了）：409 UNDO_CLOSED，什么都不动；详情上不带 undo', async () => {
    const h = await harness()
    h.approvals.seed(
      approvalItem({ id: 'ap_undo', state: 'applied', workspace_id: h.workspace_id }),
    )
    const { calls } = withUndo(h.approvals, undefined, h.workspace_id)
    const detail = await data<ApprovalItem & { undo?: ApprovalUndo }>(
      await h.get('/v1/approvals/ap_undo'),
    )
    expect(detail).not.toHaveProperty('undo')
    const res = await h.post('/v1/approvals/ap_undo/undo', {})
    expect(res.status).toBe(409)
    const body = (await res.json()) as { details?: { reason?: string } }
    expect(body.details?.reason).toBe('UNDO_CLOSED')
    expect(calls.some((c) => c.startsWith('reopen') || c.startsWith('unapprove'))).toBe(false)
  })
})

describe('WP474 我的作息', () => {
  const HOURS: WorkHours = {
    start_min: 600,
    end_min: 1140,
    weekends: true,
    live_buffer_min: 60,
    avoid_lunch: true,
  }

  async function setup(withHours: boolean) {
    const h = await harness()
    let saved: WorkHours | undefined
    const port = {
      ...(withHours
        ? {
            workHours: (_a: WorkActor) => saved ?? HOURS,
            setWorkHours: (_a: WorkActor, input: WorkHours) => {
              saved = input
              return input
            },
          }
        : {}),
    } as unknown as WorkPort
    const gateway = createGateway({ ...h.deps, work: port })
    const call = (method: string, path: string, body?: unknown): Promise<Response> => {
      const headers = new Headers({
        Authorization: `Bearer ${h.token}`,
        'X-Assignment': h.assignment.id,
      })
      if (body !== undefined) headers.set('content-type', 'application/json')
      return gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
    }
    return { call, saved: () => saved }
  }

  it('读、改', async () => {
    const { call, saved } = await setup(true)
    expect(await data<WorkHours>(await call('GET', '/v1/settings/work-hours'))).toEqual(HOURS)
    const next = { ...HOURS, weekends: false }
    const res = await call('PUT', '/v1/settings/work-hours', next)
    expect(res.status).toBe(200)
    expect(saved()).toEqual(next)
  })

  it('下班不晚于上班、不按半小时、直播留空超过 120 分钟：400', async () => {
    const { call } = await setup(true)
    for (const bad of [
      { ...HOURS, end_min: 600 },
      { ...HOURS, start_min: 610 },
      { ...HOURS, live_buffer_min: 180 },
    ])
      expect((await call('PUT', '/v1/settings/work-hours', bad)).status).toBe(400)
  })

  it('端口没有这一格：501', async () => {
    const { call } = await setup(false)
    expect((await call('GET', '/v1/settings/work-hours')).status).toBe(501)
    expect((await call('PUT', '/v1/settings/work-hours', HOURS)).status).toBe(501)
  })
})
