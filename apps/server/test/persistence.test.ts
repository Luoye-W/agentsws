/**
 * WP18：给了数据目录（`AGENTSWS_DATA_DIR`）就整套走 SQLite —— 重启后
 * owner / 工作区 / 会话 token / 账本 / 审批项都还在，`unknown` 还在对账队列里。
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ObjectRef, StageInput } from '@agentsws/contracts'
import { MemoryTxnStore, SqliteTxnStore } from '@agentsws/txn'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-07T09:00:00.000Z'
const ORDER: ObjectRef = { type: 'order', id: 'ord_1042' }
const CUSTOMER: ObjectRef = { type: 'customer', id: 'cus_7' }

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 11): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('AGENTSWS_DATA_DIR：整套落盘', () => {
  let dir = ''
  const live: Server[] = []
  const clock = makeClock()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentsws-server-'))
  })
  afterEach(async () => {
    for (const s of live.splice(0)) await s.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const boot = async (dbDir?: string): Promise<Server> => {
    const s = await createServer({
      quiet: true,
      clock: { now: () => clock.now() },
      random: seeded(),
      env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com' },
      ...(dbDir === undefined ? {} : { dbDir }),
    })
    live.push(s)
    return s
  }

  it('不给数据目录：全部内存档（txn 用 MemoryTxnStore）', async () => {
    const s = await boot()
    expect(s.txn.runtime.store).toBeInstanceOf(MemoryTxnStore)
  })

  it('给了数据目录：txn 走 SqliteTxnStore，各包各自一个文件', async () => {
    const s = await boot(dir)
    expect(s.txn.runtime.store).toBeInstanceOf(SqliteTxnStore)
    await s.close()
    const files = readdirSync(dir).filter((f) => f.endsWith('.db') || f.endsWith('.sqlite'))
    expect(files).toContain('txn.sqlite')
    expect(files).toContain('identity.sqlite')
    expect(files).toContain('events.db')
  })

  it('重启：owner 与工作区还是同一份，不重复建；会话 token 仍然认', async () => {
    const first = await boot(dir)
    const token = first.bootstrap.internalToken
    const workspaceId = first.bootstrap.workspace.id
    const personId = first.bootstrap.person.id
    await first.close()

    const second = await boot(dir)
    expect(second.bootstrap.person.id).toBe(personId)
    expect(second.bootstrap.workspace.id).toBe(workspaceId)
    expect(second.bootstrap.ownerAssignment.id).toBe(first.bootstrap.ownerAssignment.id)
    expect(await second.identity.authenticate(token)).toMatchObject({
      person_id: personId,
      workspace_id: workspaceId,
    })
  })

  it('重启：staged 的变更与它的审批项还在账本里，能接着批准与施行', async () => {
    const first = await boot(dir)
    const person = first.bootstrap.person.id
    const assignment = first.roles.assignments.create({
      person_id: person,
      workspace_id: first.bootstrap.workspace.id,
      role_id: 'dtc.aftersales',
      granted_by: person,
      ranges: [{ kind: 'store', id: 'store_1' }],
    })
    const input = stageInput(first, assignment.id, person)
    const staged = await first.txn.ledger.stage(input)
    if (!staged.ok) throw new Error(staged.message)
    await first.close()

    const second = await boot(dir)
    second.backend.setRecord(ORDER, {
      record_version: 'v1',
      record: {
        total: 89,
        refunded: 0,
        financial_status: 'paid',
        delivered_at: '2026-09-01T09:00:00.000Z',
      },
    })
    const item = await second.txn.approvals.get(staged.approval.id)
    expect(item?.state).toBe('pending')
    expect(second.txn.runtime.store.getChange(staged.change.id)?.status).toBe('staged')

    const token = item?.deliveries[0]?.decision_token
    if (token === undefined) throw new Error('审批项没有 decision_token')
    await second.txn.approvals.decide(staged.approval.id, person, {
      decision_token: token,
      action: 'approve',
      via: 'workstation',
    })
    clock.advance(121_000)
    const out = await second.txn.executor.apply(staged.change.id)
    expect(out.status).toBe('applied')
  })

  it('15 §5.8：unknown 跨重启还在对账队列里', async () => {
    const first = await boot(dir)
    const store = first.txn.runtime.store
    store.putChange({
      id: 'chg_unknown',
      schema_version: 1,
      workspace_id: first.bootstrap.workspace.id,
      role_id: 'dtc.aftersales',
      assignment_id: 'asg_x',
      run_id: 'run_x',
      change_set_id: 'cs_x',
      kind: 'refund',
      risk_class: 'money',
      target: ORDER,
      before: {},
      after: {},
      guardrail: { verdict: 'allow', hits: [], effective_mandate_hash: 'h' },
      notes: [],
      created_by: { kind: 'agent', id: 'agent_1' },
      status: 'unknown',
      expires_at: '2026-09-14T09:00:00.000Z',
      created_at: T0,
      updated_at: T0,
    })
    await first.close()

    const second = await boot(dir)
    expect(second.txn.runtime.store.pendingReconcile().map((c) => c.id)).toEqual(['chg_unknown'])
  })
})

function stageInput(server: Server, assignment_id: string, person: string): StageInput {
  return {
    workspace_id: server.bootstrap.workspace.id,
    role_id: 'dtc.aftersales',
    assignment_id,
    run_id: 'run_1',
    change_set_id: 'cs_1',
    kind: 'refund',
    target: ORDER,
    before: {
      total: 89,
      refunded: 0,
      financial_status: 'paid',
      delivered_at: '2026-09-01T09:00:00.000Z',
    },
    after: { refund_amount: 42 },
    record_version: 'v1',
    money: {
      amount: 42,
      currency: 'USD',
      amount_base: 42,
      base_currency: 'USD',
      fx_rate: 1,
      fx_at: T0,
    },
    created_by: { kind: 'agent', id: 'agent_aftersales' },
    mandate: {
      caps: {
        max_auto_refund_amount: 50,
        within_policy_window_only: true,
        return_window_days: 14,
      },
      window: { max_count: 20, per: 'day' },
    },
    level: 'L1',
    provenance: {
      run_id: 'run_1',
      seen: { order: [ORDER.id], customer: [CUSTOMER.id] },
      read_full: [],
      recorded_at: T0,
    },
    requester: { channel: 'email', external_id: 'anna@example.com', resolved: CUSTOMER },
    target_owner: CUSTOMER,
    connection_id: 'conn_shopify',
    approval: {
      title: '退款 $42.00',
      summary: '订单已签收 6 天，在退货窗口内。',
      recipients: [{ person, via: 'role_holder' }],
      proposer: { kind: 'agent', id: 'agent_aftersales', assignment_id },
      separation_of_duties: false,
    },
  }
}
