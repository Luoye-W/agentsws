/**
 * 39 待办 B：**备份恢复后先跑对账，再放开出站**（15 §5.8 / 31 §3.2）。
 *
 * 造一条认识不完整的变更 → 重启 → 出站自动停 → 对账完成 → 出站放开，
 * `GET /v1/health` 的 `reconcile` 那一格全程看得见。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StagedChange } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, RECONCILE_HALT_REASON, type Server } from '../src/index.js'

const T0 = '2026-09-10T00:00:00.000Z'
const ORDER = { type: 'order', id: 'ord_1042' } as const

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

let servers: Server[] = []
let dir: string | undefined

afterEach(async () => {
  for (const s of servers.reverse()) await s.close()
  servers = []
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

async function start(over: Parameters<typeof createServer>[0] = {}): Promise<Server> {
  const s = await createServer({
    clock: { now: () => T0 },
    random: seeded(),
    quiet: true,
    startRun: false,
    scheduleIntervalMs: 0,
    dbDir: dir,
    env: { AGENTSWS_OWNER_EMAIL: 'owner@localhost' },
    ...over,
  })
  servers.push(s)
  return s
}

function change(s: Server, over: Partial<StagedChange>): StagedChange {
  return {
    id: 'chg_lost',
    schema_version: 1,
    workspace_id: s.bootstrap.workspace.id,
    role_id: s.bootstrap.ownerAssignment.role_id,
    assignment_id: s.bootstrap.ownerAssignment.id,
    run_id: 'run_1',
    change_set_id: 'cs_1',
    kind: 'refund',
    target: ORDER,
    before: { refunded: 0 },
    after: { refunded: 42 },
    guardrail: { verdict: 'allow', hits: [], effective_mandate_hash: 'm:1', evaluated_at: T0 },
    notes: [],
    created_by: { kind: 'agent', id: 'agent_aftersales' },
    status: 'unknown',
    risk_class: 'medium',
    expires_at: T0,
    created_at: T0,
    updated_at: T0,
    ...over,
  } as StagedChange
}

/** `GET /v1/health` 是 public 的，不用带凭据。 */
async function health(s: Server): Promise<Record<string, unknown>> {
  const res = await s.gateway.fetch(new Request('http://127.0.0.1/v1/health'))
  const body = (await res.json()) as { data: Record<string, unknown> }
  return body.data
}

describe('对账未完成前不放出站（39 待办 B）', () => {
  it('干净的库：出站不停，health 的 reconcile = done / pending 0', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentsws-reconcile-clean-'))
    const s = await start()
    expect(s.reconcile.state()).toBe('done')
    expect(s.kernel.halt.isHalted('outbound')).toBe(false)
    expect(await health(s)).toMatchObject({ reconcile: { state: 'done', pending: 0 } })
  })

  it('造一条 unknown 变更 → 重启 → outbound 停 → 对账完成 → 放开', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentsws-reconcile-'))
    // ① 第一次起来：往落盘的账本里塞一条「响应丢了」的退款
    const first = await start()
    first.txn.runtime.store.putChange(change(first, { status: 'unknown' }))
    await first.close()

    // ② 重启（同一个数据目录 = 从备份恢复的等价物）：装配时就该把出站闸拉下来
    const s = await start({
      verifyChange: (c) =>
        c.id === 'chg_lost' ? { status: 'applied', execution_id: 'exec_upstream_9' } : undefined,
    })
    expect(s.reconcile.state()).toBe('pending')
    expect(s.kernel.halt.isHalted('outbound')).toBe(true)
    expect(s.kernel.halt.state().outbound.reason).toBe(RECONCILE_HALT_REASON)
    expect(await health(s)).toMatchObject({
      status: 'halted',
      reconcile: { state: 'pending', pending: 1 },
    })

    // ③ 跑对账：上游说「退款其实成了」→ 收口
    const report = await s.reconcile.run()
    expect(report).toMatchObject({ state: 'done', checked: 1, applied: ['chg_lost'] })
    expect(s.txn.runtime.store.getChange('chg_lost')?.status).toBe('applied')

    // ④ 放开出站
    expect(s.kernel.halt.isHalted('outbound')).toBe(false)
    expect(await health(s)).toMatchObject({ reconcile: { state: 'done', pending: 0 } })
  })

  it('半路断掉的 applying 先收拢成 unknown，再进对账队列', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentsws-reconcile-applying-'))
    const first = await start()
    first.txn.runtime.store.putChange(change(first, { id: 'chg_mid', status: 'applying' }))
    await first.close()

    const s = await start({ verifyChange: () => ({ status: 'failed', message: '上游没有这笔' }) })
    expect(s.kernel.halt.isHalted('outbound')).toBe(true)
    const report = await s.reconcile.run()
    expect(report).toMatchObject({ state: 'done', failed: ['chg_mid'] })
    expect(s.txn.runtime.store.getChange('chg_mid')?.status).toBe('failed')
    expect(s.kernel.halt.isHalted('outbound')).toBe(false)
  })

  it('查不出来的留成人工对账项，出站**保持停着**', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentsws-reconcile-unresolved-'))
    const first = await start()
    first.txn.runtime.store.putChange(change(first, { status: 'unknown' }))
    await first.close()

    // 缺省的 verify 就是问后端自己；重启之后它什么都不记得 → 答不上来
    const s = await start()
    const report = await s.reconcile.run()
    expect(report).toMatchObject({ state: 'pending', unresolved: ['chg_lost'] })
    expect(s.txn.runtime.store.getChange('chg_lost')?.status).toBe('unknown')
    // 机器不该在自己都不确定的时候对外说话
    expect(s.kernel.halt.isHalted('outbound')).toBe(true)
    expect(await health(s)).toMatchObject({ reconcile: { state: 'pending', pending: 1 } })
  })

  it('人自己停的出站档，对账完了也不替他放开', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentsws-reconcile-user-halt-'))
    const first = await start()
    first.txn.runtime.store.putChange(change(first, { status: 'unknown' }))
    await first.close()

    const s = await start({
      env: { AGENTSWS_OWNER_EMAIL: 'owner@localhost', AGENTSWS_HALT: 'outbound' },
      verifyChange: () => ({ status: 'applied' }),
    })
    expect(s.kernel.halt.isHalted('outbound')).toBe(true)
    const report = await s.reconcile.run()
    expect(report.state).toBe('done')
    // 档不是我们挂的，就不是我们放
    expect(s.kernel.halt.isHalted('outbound')).toBe(true)
    expect(report.outbound_halted).toBe(true)
  })
})
