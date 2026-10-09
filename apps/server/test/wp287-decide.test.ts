/**
 * WP287（Luoye 10-09 真机）：① 个人模式里唯一的人点复盘卡报「无权限：approval.approve（range=own）」。
 * 根因：老复盘卡挂在底座职责 `common.member` 上，工作台按卡上的那条分配发决定，那条没有批准权。
 * 通用规则：发给他的卡他必须点得动——请求头那条没有批准权、他名下别的分配有，就照样能点。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

let server: Server
const ws = (): string => server.bootstrap.workspace.id
const me = (): string => server.bootstrap.person.id

const call = async (path: string, assignment: string, body?: unknown): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', assignment)
  if (body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

const reviewCard = async (role_id: string): Promise<ApprovalItem> =>
  (await server.txn.approvals.create({
    workspace_id: ws(),
    schema_version: 1,
    kind: 'review',
    role_id,
    subject: { object: { type: 'review', id: 'rev_1' } },
    dedupe_key: `t:review:${role_id}`,
    title: '今天的复盘：你处理 2 张，AI 1 张',
    summary: '待办完成 1/2，会议 0 个。',
    payload: {
      cards: { ai_handled: 1, you_handled: 2, auto_sent: 0, blocked: 0 },
      todos: { done: 1, total: 2, completion_pct: 50 },
      meetings: { count: 0, outputs: 0 },
    },
    evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
    proposer: { kind: 'system', id: 'work.reviewer' },
    automation: { level_at_creation: 'L1' },
    routing: {
      recipients: [{ person: me(), via: 'role_holder' }],
      rule: 'role_holder',
      escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'queue',
  } as never)) as ApprovalItem

beforeEach(async () => {
  server = await createServer({
    clock: { now: () => '2026-10-09T12:00:00.000Z' },
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
})

afterEach(async () => {
  await server.close()
})

describe('WP287 ① 唯一的人对自己工作区的所有卡都能点', () => {
  it('卡挂在底座职责上、按那条（没有批准权的）分配发决定 → 照样能点', async () => {
    expect(await server.organizations.modeOf(ws())).toBe('solo')
    const member = server.roles.assignments.create({
      person_id: me(),
      workspace_id: ws(),
      role_id: 'common.member',
      granted_by: me(),
      ranges: [],
    })
    const card = await reviewCard('common.member')
    const res = await call(`/v1/approvals/${card.id}/decide`, member.id, { action: 'approve' })
    expect(res.status).toBe(200)
    expect((await server.txn.approvals.get(card.id))?.state).not.toBe('pending')
  })

  it('首页牌堆里发给他的卡都在（点得动的才进来）', async () => {
    const card = await reviewCard('common.owner')
    const home = (await (await call('/v1/home', server.bootstrap.ownerAssignment.id)).json()) as {
      data: { queue: { id: string }[] }
    }
    expect(JSON.stringify(home.data.queue)).toContain(card.id)
  })

  it('「N 张等你定」只数真要定的：到期了（还没被清理记成过期）的不算、不进牌堆', async () => {
    const live = await reviewCard('common.owner')
    const stale = (await server.txn.approvals.create({
      ...(live as unknown as Record<string, unknown>),
      dedupe_key: 't:review:stale',
      expires_at: '2026-10-09T00:00:00.000Z',
    } as never)) as ApprovalItem
    const home = (await (await call('/v1/home', server.bootstrap.ownerAssignment.id)).json()) as {
      data: { queue: { id: string }[] }
    }
    const ids = JSON.stringify(home.data.queue)
    expect(ids).toContain(live.id)
    expect(ids).not.toContain(stale.id)
  })
})
