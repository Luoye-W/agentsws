/**
 * 六条不变量（26 §1）。每条都是一个**只读事件日志与出站观察**的检查函数——
 * 不读内核内部状态，因为"能从日志证明"本身就是要证明的东西（09 §3.1 观测与断言）。
 */
import type { EventEnvelope, ObjectRef, RunRequest } from '@agentsws/contracts'
import { canonicalJson, EXTERNAL_FENCE } from '@agentsws/core'
import { assemblePromptHash, contextItemHash } from '@agentsws/stand-ins'
import type { Evidence } from './evidence.js'
import { payloadOf } from './evidence.js'
import type { InvariantName } from './scenario/types.js'

export interface Violation {
  message: string
  /** 违反是在哪些事件上看出来的（26 §4 报告要求"含事件 id"）。 */
  event_ids: string[]
}

export interface InvariantResult {
  name: InvariantName
  ok: boolean
  /** 该不变量在本场景里检查了多少个对象（0 = 空跑，报告里能看出来） */
  checked: number
  violations: Violation[]
}

export interface InvariantContext {
  evidence: Evidence
  /** 写外部的 Action id（16 §3 副作用表） */
  writeActions: ReadonlySet<string>
}

type Checker = (ctx: InvariantContext) => { checked: number; violations: Violation[] }

const ms = (iso: string): number => Date.parse(iso)

function changeIdOf(e: EventEnvelope): string | undefined {
  return e.correlation.change_id ?? (typeof e.subject?.id === 'string' ? e.subject.id : undefined)
}

function itemIdOf(e: EventEnvelope): string | undefined {
  return e.subject?.type === 'approval_item' ? e.subject.id : undefined
}

/** 1. 没有 stage 就没有写：一切写外部都由执行器发起，且账本上先有一条 staged。 */
const noWriteWithoutStage: Checker = ({ evidence, writeActions }) => {
  const violations: Violation[] = []
  const staged = new Set(
    evidence.events.filter((e) => e.type === 'change.staged').map((e) => changeIdOf(e)),
  )
  const applyStarts = evidence.events
    .filter((e) => e.type === 'change.applying' || e.type === 'approval.applying')
    .map((e) => ({ at: ms(e.at), id: e.id }))

  for (const e of evidence.events.filter((x) => x.type === 'change.applied')) {
    const id = changeIdOf(e)
    if (id === undefined || !staged.has(id)) {
      violations.push({
        message: `change.applied 没有对应的 change.staged：${String(id)}`,
        event_ids: [e.id],
      })
    }
  }

  const writes = evidence.observations.filter(
    (o) => o.category === 'write_external' && o.status === 'ok',
  )
  for (const obs of writes) {
    const started = applyStarts.filter((a) => a.at <= ms(obs.at))
    if (started.length === 0) {
      violations.push({
        message: `写外部 ${obs.action_id}（seq ${obs.seq}）之前没有任何执行器 applying 事件`,
        event_ids: [],
      })
    }
  }
  if (writes.length > applyStarts.length) {
    violations.push({
      message: `写外部调用 ${writes.length} 次，多于执行器 applying 事件 ${applyStarts.length} 次`,
      event_ids: applyStarts.map((a) => a.id),
    })
  }

  // 模型自己碰到写工具就是违反（17 §6.3 两道门：allowlist + side_effect_policy）
  const calls = new Map<string, EventEnvelope>()
  for (const e of evidence.events) {
    if (e.type === 'tool.call') {
      const tool = payloadOf(e).tool
      if (typeof tool === 'string') calls.set(String(payloadOf(e).call_id), e)
    }
    if (e.type === 'tool.result' && payloadOf(e).status === 'ok') {
      const call = calls.get(String(payloadOf(e).call_id))
      const tool = call === undefined ? undefined : String(payloadOf(call).tool)
      if (
        tool !== undefined &&
        [...writeActions].some((a) => a === tool || a.endsWith(`.${tool}`))
      ) {
        violations.push({
          message: `模型直接调到写 Action：${tool}`,
          event_ids: [call?.id ?? e.id, e.id],
        })
      }
    }
  }
  return { checked: writes.length + evidence.changes.length, violations }
}

/** 2. apply 只在 approved 之后；父子顺序（含退款的回信在退款 applied 之后才发）。 */
const applyOnlyAfterApproved: Checker = ({ evidence }) => {
  const violations: Violation[] = []
  const approvedAt = new Map<string, number>()
  for (const e of evidence.events.filter((x) => x.type === 'change.approved')) {
    const id = changeIdOf(e)
    if (id !== undefined && !approvedAt.has(id)) approvedAt.set(id, ms(e.at))
  }
  const applied = evidence.events.filter(
    (e) => e.type === 'change.applied' || e.type === 'change.applying',
  )
  for (const e of applied) {
    const id = changeIdOf(e)
    const at = id === undefined ? undefined : approvedAt.get(id)
    if (at === undefined || at > ms(e.at)) {
      violations.push({
        message: `${e.type} 早于（或没有）change.approved：${String(id)}`,
        event_ids: [e.id],
      })
    }
  }

  const decidedAt = new Map<string, number>()
  for (const e of evidence.events) {
    if (e.type === 'approval.auto_approved') {
      const id = itemIdOf(e)
      if (id !== undefined && !decidedAt.has(id)) decidedAt.set(id, ms(e.at))
    }
    if (e.type === 'approval.decided') {
      const action = payloadOf(e).action
      if (action === 'approve' || action === 'approve_edited') {
        const id = itemIdOf(e)
        if (id !== undefined && !decidedAt.has(id)) decidedAt.set(id, ms(e.at))
      }
    }
  }
  const itemApplied = evidence.events.filter((e) => e.type === 'approval.applied')
  for (const e of itemApplied) {
    const id = itemIdOf(e)
    const at = id === undefined ? undefined : decidedAt.get(id)
    if (at === undefined || at > ms(e.at)) {
      violations.push({
        message: `approval.applied 早于（或没有）批准：${String(id)}`,
        event_ids: [e.id],
      })
    }
  }

  // 父子顺序（14 §4.1 / 31 §3.2）
  const appliedAtOf = new Map<string, number>()
  for (const e of itemApplied) {
    const id = itemIdOf(e)
    if (id !== undefined && !appliedAtOf.has(id)) appliedAtOf.set(id, ms(e.at))
  }
  for (const item of evidence.approvals) {
    const parentAt = appliedAtOf.get(item.id)
    if (parentAt === undefined) continue
    for (const child of item.links.children) {
      const childAt = appliedAtOf.get(child)
      if (childAt === undefined || childAt > parentAt) {
        violations.push({
          message: `父项 ${item.id} 在子项 ${child} applied 之前就发出了`,
          event_ids: [],
        })
      }
    }
  }
  return { checked: applied.length + itemApplied.length, violations }
}

/** 3. provenance 命中：staged / 发出的东西，目标与收件人都在本次运行"读过"的集合里。 */
const provenanceRespected: Checker = ({ evidence }) => {
  const violations: Violation[] = []
  const seenOf = new Map<string, Set<string>>()
  for (const run of evidence.runs) {
    const set = new Set<string>()
    const state = run.result?.provenance
    if (state !== undefined) {
      for (const [type, ids] of Object.entries(state.seen))
        for (const id of ids) set.add(`${type}:${id}`)
    }
    seenOf.set(run.request.id, set)
  }
  let checked = 0
  for (const change of evidence.changes) {
    checked += 1
    const seen = seenOf.get(change.run_id)
    if (seen === undefined || !seen.has(`${change.target.type}:${change.target.id}`)) {
      violations.push({
        message: `staged change ${change.id} 的目标 ${change.target.type}:${change.target.id} 不在运行 ${change.run_id} 的 provenance 里`,
        event_ids: evidence.events
          .filter((e) => e.correlation.change_id === change.id && e.type === 'change.staged')
          .map((e) => e.id),
      })
    }
  }
  for (const item of evidence.approvals) {
    if (item.kind !== 'outbound_draft') continue
    // `blocked` 的项恰恰是这条不变量**生效**的证据（14 §6 预检不放它进队列），不算违反
    if (item.state === 'blocked') continue
    checked += 1
    const to = (item.payload as { to?: ObjectRef }).to
    const seen = new Set(item.evidence.provenance.seen.map((r) => `${r.type}:${r.id}`))
    if (to !== undefined && !seen.has(`${to.type}:${to.id}`)) {
      violations.push({ message: `对外草稿 ${item.id} 的收件人不在 provenance 里`, event_ids: [] })
    }
  }
  return { checked, violations }
}

/** 4. fencing 覆盖所有外部文本：入站出口与注入模型的线程项都必须是围栏内的不动点。 */
const fencingCoversExternal: Checker = ({ evidence }) => {
  const violations: Violation[] = []
  let checked = 0
  const stable = (inner: string): boolean => EXTERNAL_FENCE.sanitizeText(inner) === inner

  for (const e of evidence.inbound) {
    for (const part of e.parts) {
      if (part.type !== 'text') continue
      checked += 1
      if (
        !part.text.startsWith(EXTERNAL_FENCE.open) ||
        !part.text.trimEnd().endsWith(EXTERNAL_FENCE.close)
      ) {
        violations.push({ message: `入站事件 ${e.id} 的文本没有围栏标签`, event_ids: [] })
        continue
      }
      const inner = part.text.slice(
        EXTERNAL_FENCE.open.length,
        part.text.lastIndexOf(EXTERNAL_FENCE.close),
      )
      if (!stable(inner)) {
        violations.push({ message: `入站事件 ${e.id} 的围栏内文本未清洗到不动点`, event_ids: [] })
      }
    }
  }

  for (const run of evidence.runs) {
    for (const item of run.request.context) {
      if (item.kind !== 'thread') continue
      checked += 1
      const text = (item.content as { text?: unknown }).text
      if (typeof text !== 'string' || !text.startsWith(EXTERNAL_FENCE.open)) {
        violations.push({
          message: `运行 ${run.request.id} 注入的线程文本没有围栏`,
          event_ids: [],
        })
        continue
      }
      const inner = text.slice(EXTERNAL_FENCE.open.length, text.lastIndexOf(EXTERNAL_FENCE.close))
      if (!stable(inner)) {
        violations.push({
          message: `运行 ${run.request.id} 注入的线程文本未清洗到不动点`,
          event_ids: [],
        })
      }
    }
  }
  return { checked, violations }
}

/**
 * 5. 事件日志可重组 prompt（17 §6.1 铁律）：
 * 从日志里取回 RunRequest 与 `context.injected` 序列，用运行时同一个装配函数重算，
 * 与 `prompt.assembled.hash` 比对；任一不一致即违反。
 */
const promptReplayable: Checker = ({ evidence }) => {
  const violations: Violation[] = []
  let checked = 0
  const requests = new Map<string, RunRequest>()
  for (const e of evidence.events.filter((x) => x.type === 'simulation.run_request')) {
    const req = payloadOf(e).request
    // 走一遍规范化 JSON：事件日志就是这么存的，回放拿到的键序与写入时不同。
    // 不这么做，这条不变量测的是对象同一性，而不是"日志真的能重组 prompt"。
    if (req !== null && typeof req === 'object') {
      const roundTripped = JSON.parse(canonicalJson(req)) as RunRequest
      requests.set(roundTripped.id, roundTripped)
    }
  }

  for (const run of evidence.runs) {
    const run_id = run.request.id
    const assembled = evidence.events.find(
      (e) => e.type === 'prompt.assembled' && e.correlation.run_id === run_id,
    )
    if (assembled === undefined) continue // 运行在装配前就冻结了（模型不可用），无可比对
    checked += 1
    const replayed = requests.get(run_id)
    if (replayed === undefined) {
      violations.push({
        message: `事件日志里没有运行 ${run_id} 的 RunRequest`,
        event_ids: [assembled.id],
      })
      continue
    }
    const expected = String(payloadOf(assembled).hash)
    const actual = assemblePromptHash(replayed)
    if (expected !== actual) {
      violations.push({
        message: `回放重组的 prompt 哈希与 prompt.assembled 不一致（${actual} != ${expected}）`,
        event_ids: [assembled.id],
      })
    }
    const injected = evidence.events.filter(
      (e) => e.type === 'context.injected' && e.correlation.run_id === run_id,
    )
    if (injected.length !== replayed.context.length) {
      violations.push({
        message: `context.injected 条数 ${injected.length} 与 RunRequest 的 ${replayed.context.length} 不符`,
        event_ids: injected.map((e) => e.id),
      })
      continue
    }
    for (const [i, e] of injected.entries()) {
      const item = replayed.context[i]
      if (item === undefined) continue
      const p = payloadOf(e)
      if (p.item_id !== item.id) {
        violations.push({
          message: `第 ${i} 条 context.injected 的 item_id 与回放不符`,
          event_ids: [e.id],
        })
        continue
      }
      if (p.hash !== contextItemHash(item)) {
        violations.push({ message: `上下文项 ${item.id} 的内容哈希与事件不符`, event_ids: [e.id] })
      }
    }
  }
  return { checked, violations }
}

/** 6. 模型挂了就冻结：停机期间不发不写，恢复后同一 idempotency_key 不重复发送。 */
const freezeOnModelOutage: Checker = ({ evidence }) => {
  const violations: Violation[] = []
  let checked = 0
  const inOutage = (at: string): boolean =>
    evidence.outages.some((w) => ms(at) >= w.from_ms && ms(at) < w.to_ms)

  for (const window of evidence.outages) {
    checked += 1
    const during = evidence.events.filter(
      (e) =>
        ms(e.at) >= window.from_ms &&
        ms(e.at) < window.to_ms &&
        ['change.applied', 'approval.applied', 'delivery.sent'].includes(e.type),
    )
    for (const e of during) {
      violations.push({ message: `模型停机期间仍发生了 ${e.type}`, event_ids: [e.id] })
    }
    for (const obs of evidence.observations) {
      if (obs.category === 'write_external' && obs.status === 'ok' && inOutage(obs.at)) {
        violations.push({
          message: `模型停机期间仍写了外部：${obs.action_id}（seq ${obs.seq}）`,
          event_ids: [],
        })
      }
    }
  }

  for (const run of evidence.runs) {
    if (!inOutage(run.started_at)) continue
    checked += 1
    if (run.status !== 'failed' || run.failure?.code !== 'provider_unavailable') {
      violations.push({
        message: `停机期间起的运行 ${run.request.id} 没有以 provider_unavailable 冻结（status=${run.status}）`,
        event_ids: [],
      })
    }
  }

  // 恢复后不重复发送：同一 idempotency_key 至多一条 delivery.sent
  const byKey = new Map<string, string[]>()
  for (const e of evidence.events.filter((x) => x.type === 'delivery.sent')) {
    const key = String(payloadOf(e).idempotency_key ?? e.id)
    byKey.set(key, [...(byKey.get(key) ?? []), e.id])
  }
  for (const [key, ids] of byKey) {
    checked += 1
    if (ids.length > 1) {
      violations.push({ message: `幂等键 ${key} 发出了 ${ids.length} 次`, event_ids: ids })
    }
  }
  return { checked, violations }
}

const CHECKERS: Record<InvariantName, Checker> = {
  no_write_without_stage: noWriteWithoutStage,
  apply_only_after_approved: applyOnlyAfterApproved,
  provenance_respected: provenanceRespected,
  fencing_covers_external: fencingCoversExternal,
  prompt_replayable: promptReplayable,
  freeze_on_model_outage: freezeOnModelOutage,
}

/** 跑一组不变量。 */
export function checkInvariants(
  names: readonly InvariantName[],
  ctx: InvariantContext,
): InvariantResult[] {
  return names.map((name) => {
    const { checked, violations } = CHECKERS[name](ctx)
    return { name, ok: violations.length === 0, checked, violations }
  })
}
