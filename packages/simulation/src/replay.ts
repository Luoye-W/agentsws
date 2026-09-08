/**
 * 回放校验（17 §6.1 用例 1，"铁律自动校验"）。
 *
 * 只读事件日志：取该次运行的 `simulation.run_request` + `context.injected` + `prompt.assembled`，
 * 用运行时同一个装配函数重组 prompt，与 `prompt.assembled.hash` 比对。
 * 不碰内核内部状态——能不能重组，只由日志说了算。
 */
import type { EventEnvelope, RunId, RunRequest } from '@agentsws/contracts'
import { SqliteEventLog, systemClock, systemRandom } from '@agentsws/kernel'
import { assemblePromptHash, contextItemHash } from '@agentsws/stand-ins'
import { SimulationError } from './errors.js'

export interface ReplayItemCheck {
  item_id: string
  kind: string
  ok: boolean
  expected: string
  actual: string
}

export interface ReplayResult {
  run_id: RunId
  ok: boolean
  /** 事件日志里这次运行的事件条数 */
  events: number
  prompt: { expected: string; actual: string; ok: boolean }
  static_prefix_hash?: string
  total_tokens?: number
  items: ReplayItemCheck[]
  problems: string[]
}

const payloadOf = (e: EventEnvelope): Record<string, unknown> =>
  e.payload !== null && typeof e.payload === 'object' && !Array.isArray(e.payload)
    ? (e.payload as Record<string, unknown>)
    : {}

/** 从一串（已按 id 排好序的）运行事件里回放校验。 */
export function replayFromEvents(run_id: RunId, events: readonly EventEnvelope[]): ReplayResult {
  const problems: string[] = []
  const requestEvent = events.find((e) => e.type === 'simulation.run_request')
  const assembled = events.find((e) => e.type === 'prompt.assembled')
  if (requestEvent === undefined) {
    throw new SimulationError('not_found', `事件日志里没有运行 ${run_id} 的 RunRequest`, { run_id })
  }
  if (assembled === undefined) {
    throw new SimulationError(
      'not_found',
      `运行 ${run_id} 没有 prompt.assembled 事件（可能在装配前就冻结了）`,
      { run_id },
    )
  }
  const request = payloadOf(requestEvent).request as RunRequest | undefined
  if (request === undefined) {
    throw new SimulationError('invalid_input', `运行 ${run_id} 的 RunRequest 载荷不可读`)
  }

  const expected = String(payloadOf(assembled).hash)
  const actual = assemblePromptHash(request)
  if (expected !== actual) problems.push(`prompt 哈希不一致：${actual} != ${expected}`)

  const injected = events.filter((e) => e.type === 'context.injected')
  const items: ReplayItemCheck[] = []
  if (injected.length !== request.context.length) {
    problems.push(
      `context.injected 条数 ${injected.length} != RunRequest ${request.context.length}`,
    )
  }
  for (const [i, item] of request.context.entries()) {
    const e = injected[i]
    const expectedHash = e === undefined ? '' : String(payloadOf(e).hash)
    const actualHash = contextItemHash(item)
    const ok = e !== undefined && payloadOf(e).item_id === item.id && expectedHash === actualHash
    if (!ok) problems.push(`上下文项 ${item.id} 与事件不符`)
    items.push({
      item_id: item.id,
      kind: item.kind,
      ok,
      expected: expectedHash,
      actual: actualHash,
    })
  }

  const prefix = payloadOf(assembled).static_prefix_hash
  const tokens = payloadOf(assembled).total_tokens
  return {
    run_id,
    ok: problems.length === 0,
    events: events.length,
    prompt: { expected, actual, ok: expected === actual },
    ...(typeof prefix === 'string' ? { static_prefix_hash: prefix } : {}),
    ...(typeof tokens === 'number' ? { total_tokens: tokens } : {}),
    items,
    problems,
  }
}

/** 从 SQLite 事件日志文件回放校验一次运行（`agentsws replay <run_id> --db <path>`）。 */
export async function replayRun(run_id: RunId, dbPath: string): Promise<ReplayResult> {
  const log = new SqliteEventLog({ dbPath, clock: systemClock, random: systemRandom })
  try {
    const events: EventEnvelope[] = []
    for await (const e of log.replayRun(run_id)) events.push(e)
    if (events.length === 0) {
      throw new SimulationError('not_found', `事件日志里没有运行 ${run_id}`, { run_id, dbPath })
    }
    return replayFromEvents(run_id, events)
  } finally {
    log.close()
  }
}

/** 列出事件日志里所有 run_id（CLI 找不到 run 时给个提示）。 */
export async function listRuns(dbPath: string, workspace_id?: string): Promise<string[]> {
  const log = new SqliteEventLog({ dbPath, clock: systemClock, random: systemRandom })
  try {
    const rows = log.database
      .prepare(
        workspace_id === undefined
          ? 'SELECT DISTINCT run_id FROM events WHERE run_id IS NOT NULL ORDER BY run_id'
          : 'SELECT DISTINCT run_id FROM events WHERE run_id IS NOT NULL AND workspace_id = ? ORDER BY run_id',
      )
      .all(...(workspace_id === undefined ? [] : [workspace_id])) as { run_id: string }[]
    return rows.map((r) => r.run_id)
  } finally {
    log.close()
  }
}
