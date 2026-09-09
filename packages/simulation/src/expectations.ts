/**
 * `expected` 的结构化断言（26 §1）。断言不变量与结构，**不断言措辞**——
 * `reply_omits` / `reply_includes_any` 是"必须没有 / 至少有一个"的白名单，不是逐字比对。
 */
import type { ChangeKind } from '@agentsws/contracts'
import type { Evidence } from './evidence.js'
import { payloadOf } from './evidence.js'
import type { MetricTable } from './metrics.js'
import type { NumericAssertion, ScenarioExpected } from './scenario/types.js'

export interface ExpectationResult {
  key: string
  ok: boolean
  detail: string
}

const CMP = /^(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)$/

/** `>=0.6` / `<=20000` / 裸数字（相等）。 */
export function matchNumeric(actual: number, expected: NumericAssertion): boolean {
  if (typeof expected === 'number') return Math.abs(actual - expected) < 1e-9
  const m = CMP.exec(expected.trim())
  if (m === null || m[1] === undefined || m[2] === undefined) return false
  const v = Number.parseFloat(m[2])
  switch (m[1]) {
    case '>=':
      return actual >= v
    case '<=':
      return actual <= v
    case '>':
      return actual > v
    case '<':
      return actual < v
    default:
      return Math.abs(actual - v) < 1e-9
  }
}

/** 本次模拟里模型实际调过的工具（按事件顺序）。 */
export function toolsCalled(evidence: Evidence): string[] {
  return evidence.events.filter((e) => e.type === 'tool.call').map((e) => String(payloadOf(e).tool))
}

/** 发出去的回信正文（`delivery.sent` 对应的审批项 payload）。 */
export function repliesSent(evidence: Evidence): string[] {
  const sentItems = new Set(
    evidence.events.filter((e) => e.type === 'delivery.sent').map((e) => e.subject?.id),
  )
  return evidence.approvals
    .filter((i) => sentItems.has(i.id))
    .map((i) => {
      const payload = (i.decision?.edited_payload ?? i.payload) as { body?: { text?: unknown } }
      return String(payload.body?.text ?? '')
    })
}

/** 已提出的草稿正文（含还没发出去的），用于"没发出去也不该出现某措辞"。 */
export function draftsProposed(evidence: Evidence): string[] {
  return evidence.approvals
    .filter((i) => i.kind === 'outbound_draft')
    .map((i) => {
      const payload = (i.decision?.edited_payload ?? i.payload) as { body?: { text?: unknown } }
      return String(payload.body?.text ?? '')
    })
}

export function checkExpectations(
  expected: ScenarioExpected,
  evidence: Evidence,
  metrics: MetricTable,
): ExpectationResult[] {
  const out: ExpectationResult[] = []
  const add = (key: string, ok: boolean, detail: string): void => {
    out.push({ key, ok, detail })
  }
  const called = toolsCalled(evidence)
  const bare = (t: string): string => (t.includes('.') ? t.slice(t.indexOf('.') + 1) : t)
  const calledBare = called.map(bare)

  if (expected.calls_tool !== undefined) {
    const missing = expected.calls_tool.filter((t) => !calledBare.includes(bare(t)))
    add(
      'calls_tool',
      missing.length === 0,
      missing.length === 0 ? `全部命中：${called.join(', ')}` : `缺：${missing.join(', ')}`,
    )
  }
  if (expected.first_tool !== undefined) {
    const first = calledBare[0]
    add('first_tool', first === bare(expected.first_tool), `第一次工具调用 = ${String(first)}`)
  }
  if (expected.never_calls !== undefined) {
    const hit = expected.never_calls.filter((t) => calledBare.includes(bare(t)))
    add(
      'never_calls',
      hit.length === 0,
      hit.length === 0 ? '一次没调' : `调到了：${hit.join(', ')}`,
    )
  }
  if (expected.staged_change_kinds !== undefined) {
    const actual = [...new Set(evidence.changes.map((c) => c.kind))].sort()
    const want = [...new Set(expected.staged_change_kinds as ChangeKind[])].sort()
    add(
      'staged_change_kinds',
      actual.length === want.length && actual.every((k, i) => k === want[i]),
      `实际 [${actual.join(', ')}]，期望 [${want.join(', ')}]`,
    )
  }
  if (expected.no_applied_changes_before !== undefined) {
    const marker = expected.no_applied_changes_before
    const firstApprove = evidence.events.find(
      (e) =>
        e.type === 'approval.decided' &&
        ['approve', 'approve_edited'].includes(String(payloadOf(e).action)),
    )
    const firstApplied = evidence.events.find((e) => e.type === 'change.applied')
    const ok =
      firstApplied === undefined ||
      (firstApprove !== undefined && Date.parse(firstApprove.at) <= Date.parse(firstApplied.at))
    add(
      'no_applied_changes_before',
      ok,
      ok
        ? `${marker} 之前没有 change.applied`
        : `change.applied 早于第一条批准（${firstApplied?.at ?? '-'}）`,
    )
  }
  if (expected.approval_items !== undefined) {
    const spec = expected.approval_items
    const items = evidence.approvals.filter((i) => i.kind === spec.kind)
    let ok = true
    const detail: string[] = [`${spec.kind} × ${items.length}`]
    if (spec.count !== undefined) {
      const hit = matchNumeric(items.length, spec.count)
      ok = ok && hit
      detail.push(`count ${hit ? '✓' : '✗'} (${String(spec.count)})`)
    }
    if (spec.children !== undefined) {
      const kindsOfChildren = new Set<string>()
      for (const item of items) {
        for (const childId of item.links.children) {
          const child = evidence.approvals.find((c) => c.id === childId)
          if (child !== undefined) kindsOfChildren.add(child.kind)
        }
      }
      const missing = spec.children.filter((k) => !kindsOfChildren.has(k))
      ok = ok && missing.length === 0
      detail.push(missing.length === 0 ? 'children ✓' : `children 缺 ${missing.join(', ')}`)
    }
    add('approval_items', ok, detail.join('；'))
  }
  if (expected.reply_omits !== undefined) {
    const bodies = [...repliesSent(evidence), ...draftsProposed(evidence)]
    const hit = expected.reply_omits.filter((w) => bodies.some((b) => b.includes(w)))
    add(
      'reply_omits',
      hit.length === 0,
      hit.length === 0 ? '措辞未出现' : `出现了：${hit.join(', ')}`,
    )
  }
  if (expected.reply_includes_any !== undefined) {
    const bodies = draftsProposed(evidence)
    const ok =
      bodies.length > 0 &&
      bodies.some((b) => expected.reply_includes_any?.some((w) => b.includes(w)))
    add(
      'reply_includes_any',
      ok,
      ok ? '至少一条命中' : `没有草稿命中 [${expected.reply_includes_any.join(', ')}]`,
    )
  }
  if (expected.memory_contains !== undefined) {
    const keys = evidence.runs.flatMap((r) => (r.result?.memory_candidates ?? []).map((m) => m.key))
    const missing = expected.memory_contains.filter((k) => !keys.includes(k))
    add(
      'memory_contains',
      missing.length === 0,
      missing.length === 0 ? '命中' : `缺：${missing.join(', ')}`,
    )
  }
  if (expected.max_tool_calls !== undefined) {
    add(
      'max_tool_calls',
      called.length <= expected.max_tool_calls,
      `${called.length} 次 ≤ ${expected.max_tool_calls}`,
    )
  }
  if (expected.metrics !== undefined) {
    for (const [name, assertion] of Object.entries(expected.metrics)) {
      const metric = metrics[name]
      if (metric === undefined) {
        add(`metrics.${name}`, false, '报告里没有这个指标')
        continue
      }
      add(
        `metrics.${name}`,
        matchNumeric(metric.value, assertion),
        `${metric.value}（期望 ${String(assertion)}；来源 ${metric.event_types.join('+')} × ${metric.event_count}）`,
      )
    }
  }
  if (expected.run_failed_codes !== undefined) {
    const codes = new Set(
      evidence.events
        .filter((e) => e.type === 'run.failed')
        .map((e) => String((payloadOf(e).error as { code?: unknown })?.code ?? '')),
    )
    const missing = expected.run_failed_codes.filter((c) => !codes.has(c))
    add(
      'run_failed_codes',
      missing.length === 0,
      missing.length === 0 ? `[${[...codes].join(', ')}]` : `缺：${missing.join(', ')}`,
    )
  }
  if (expected.notifications_to !== undefined) {
    const to = new Set(evidence.notifications.map((n) => n.to))
    const missing = expected.notifications_to.filter((p) => !to.has(p))
    add(
      'notifications_to',
      missing.length === 0,
      missing.length === 0 ? `通知到 [${[...to].join(', ')}]` : `没通知到：${missing.join(', ')}`,
    )
  }
  if (expected.event_types !== undefined) {
    const seen = new Set(evidence.events.map((e) => e.type))
    const missing = expected.event_types.filter((t) => !seen.has(t))
    add(
      'event_types',
      missing.length === 0,
      missing.length === 0 ? '都出现过' : `事件日志里没有：${missing.join(', ')}`,
    )
  }
  if (expected.approval_kinds !== undefined) {
    for (const [kind, assertion] of Object.entries(expected.approval_kinds)) {
      const n = evidence.approvals.filter((i) => i.kind === kind).length
      add(
        `approval_kinds.${kind}`,
        matchNumeric(n, assertion),
        `${kind} × ${n}（期望 ${String(assertion)}）`,
      )
    }
  }
  if (expected.scheduled_handlers !== undefined) {
    // 定时任务不在 evidence 里（它属于调度器），从 `schedule.created` 事件看
    const registered = new Set(
      evidence.events
        .filter((e) => e.type === 'schedule.created')
        .map((e) => String(payloadOf(e).handler)),
    )
    const missing = expected.scheduled_handlers.filter((h) => !registered.has(h))
    add(
      'scheduled_handlers',
      missing.length === 0,
      missing.length === 0
        ? `已注册 [${[...registered].join(', ')}]`
        : `没注册：${missing.join(', ')}`,
    )
  }
  if (expected.blocked_rules !== undefined) {
    const rules = new Set(evidence.blocked.map((b) => b.rule))
    const missing = expected.blocked_rules.filter((r) => !rules.has(r))
    add(
      'blocked_rules',
      missing.length === 0,
      missing.length === 0 ? `挡下 [${[...rules].join(', ')}]` : `没挡下：${missing.join(', ')}`,
    )
  }
  return out
}
