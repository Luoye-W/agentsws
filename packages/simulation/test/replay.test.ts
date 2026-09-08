import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventEnvelope, RunRequest } from '@agentsws/contracts'
import { assemblePromptHash, contextItemHash } from '@agentsws/stand-ins'
import { afterAll, describe, expect, it } from 'vitest'
import { listRuns, loadScenario, replayFromEvents, replayRun, runScenario } from '../src/index.js'
import { PACK_DIR, pack, runPackScenario } from './helpers.js'

const temps: string[] = []
const tempDb = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agentsws-replay-'))
  temps.push(d)
  return join(d, 'events.db')
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

describe('17 §6.1 用例 1：回放事件日志重组 prompt 与 prompt.assembled.hash 一致', () => {
  it('从 SQLite 事件日志回放，每次运行都对得上', async () => {
    const db = tempDb()
    const scenario = loadScenario(`${PACK_DIR}/scenarios/aftersales/return-within-window.yml`)
    await runScenario(scenario, { pack: pack(), dbPath: db })

    const runs = await listRuns(db)
    expect(runs).toHaveLength(2)
    for (const id of runs) {
      const result = await replayRun(id, db)
      expect(result.problems, id).toEqual([])
      expect(result.ok, id).toBe(true)
      expect(result.prompt.actual).toBe(result.prompt.expected)
      // 每一条 context.injected 都能重算出同一个哈希
      expect(result.items.length).toBeGreaterThan(3)
      expect(result.items.every((i) => i.ok)).toBe(true)
      expect(result.static_prefix_hash).toMatch(/^[0-9a-f]{8,}$/)
      expect(result.total_tokens).toBeGreaterThan(0)
    }
  })

  it('找不到运行 / 数据库里没这次运行 → 报错而不是默默通过', async () => {
    const db = tempDb()
    const scenario = loadScenario(`${PACK_DIR}/scenarios/ops/budget-exhausted.yml`)
    await runScenario(scenario, { pack: pack(), dbPath: db })
    await expect(replayRun('run_nope', db)).rejects.toThrow(/没有运行/)
    // 熔断的运行没走到装配，回放会明说
    const runs = await listRuns(db)
    expect(runs.length).toBeGreaterThan(0)
    await expect(replayRun(runs[0] as string, db)).rejects.toThrow(/prompt.assembled/)
  })

  it('日志被改过 → 回放报不一致（铁律不是摆设）', async () => {
    const { evidence } = await runPackScenario('aftersales/return-within-window.yml')
    const run_id = evidence.runs[0]?.request.id as string
    const events = evidence.events.filter(
      (e) => e.correlation.run_id === run_id || e.type === 'simulation.run_request',
    )
    const cloned = structuredClone(events) as EventEnvelope[]
    const requestEvent = cloned.find((e) => e.type === 'simulation.run_request')
    expect(requestEvent).toBeDefined()
    const request = ((requestEvent?.payload ?? {}) as { request: RunRequest }).request
    const policy = request.context.find((c) => c.kind === 'policy')
    if (policy !== undefined) policy.content = { tampered: true }

    const result = replayFromEvents(run_id, cloned)
    expect(result.ok).toBe(false)
    expect(result.problems.some((p) => p.includes('prompt 哈希不一致'))).toBe(true)
    expect(result.items.find((i) => i.item_id === 'policy_workspace')?.ok).toBe(false)
  })

  it('装配函数与运行时是同一个（不是两处实现）', async () => {
    const { evidence } = await runPackScenario('aftersales/return-outside-window.yml')
    const run = evidence.runs[0]
    expect(run).toBeDefined()
    const assembled = evidence.events.find(
      (e) => e.type === 'prompt.assembled' && e.correlation.run_id === run?.request.id,
    )
    expect(assembled).toBeDefined()
    const hash = ((assembled?.payload ?? {}) as { hash?: string }).hash
    expect(assemblePromptHash(run?.request as RunRequest)).toBe(hash)
    for (const item of run?.request.context ?? []) {
      const injected = evidence.events.find(
        (e) =>
          e.type === 'context.injected' && (e.payload as { item_id: string }).item_id === item.id,
      )
      expect(((injected?.payload ?? {}) as { hash?: string }).hash, item.id).toBe(
        contextItemHash(item),
      )
    }
  })
})
