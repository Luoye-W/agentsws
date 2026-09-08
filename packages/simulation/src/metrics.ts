/**
 * 指标表（26 §4）。**每个指标都带它的事件查询**（类型 + 命中条数），
 * 因为 26 §6.4 要求"报告里的每个指标都能追溯到事件查询"——不能只给一个数。
 */
import type { Evidence } from './evidence.js'
import { payloadOf } from './evidence.js'

export interface Metric {
  value: number
  /** 这个数是从哪些事件类型算出来的 */
  event_types: string[]
  /** 参与计算的事件条数 */
  event_count: number
  /** 越大越好 / 越小越好；门禁判劣化用 */
  direction: 'higher_better' | 'lower_better'
  note?: string
}

export type MetricTable = Record<string, Metric>

const count = (evidence: Evidence, ...types: string[]): number =>
  evidence.events.filter((e) => types.includes(e.type)).length

const decisions = (evidence: Evidence) =>
  evidence.events.filter((e) => e.type === 'approval.decided')

/**
 * 同一条变更会在日志里出现两次 `change.staged`：运行时发一条（17 §2 事件流），
 * 账本发一条（15 §7）。按 change_id 去重才是"提出了几条变更"。
 */
const distinctChanges = (evidence: Evidence, type: string): Set<string> => {
  const ids = new Set<string>()
  for (const e of evidence.events.filter((x) => x.type === type)) {
    const id =
      e.correlation.change_id ??
      (typeof payloadOf(e).change_id === 'string' ? String(payloadOf(e).change_id) : undefined) ??
      e.subject?.id
    if (id !== undefined) ids.add(id)
  }
  return ids
}

const ms = (iso: string): number => Date.parse(iso)

/** 从事件日志算出全部指标。 */
export function computeMetrics(evidence: Evidence): MetricTable {
  const decided = decisions(evidence)
  const accepted = decided.filter((e) => payloadOf(e).accepted === true).length
  const edited = decided.filter((e) => payloadOf(e).edited === true).length
  const rejected = decided.filter((e) => payloadOf(e).rejected === true).length
  const total = decided.length

  const usage = evidence.events.filter((e) => e.type === 'model.usage')
  const tokens = usage.reduce((n, e) => {
    const p = payloadOf(e)
    return n + Number(p.input_tokens ?? 0) + Number(p.output_tokens ?? 0)
  }, 0)
  const workItems = new Set(
    evidence.events.filter((e) => e.type === 'run.started').map((e) => e.correlation.run_id),
  ).size

  const created = new Map<string, number>()
  for (const e of evidence.events.filter((x) => x.type === 'approval.created')) {
    const id = e.subject?.id
    if (id !== undefined && !created.has(id)) created.set(id, ms(e.at))
  }
  const latencies: number[] = []
  for (const e of decided) {
    const id = e.subject?.id
    const at = id === undefined ? undefined : created.get(id)
    if (at !== undefined) latencies.push(ms(e.at) - at)
  }

  const table: MetricTable = {
    adoption_rate: {
      value: total === 0 ? 1 : accepted / total,
      event_types: ['approval.decided'],
      event_count: total,
      direction: 'higher_better',
      note: `accepted=${accepted} edited=${edited} rejected=${rejected}`,
    },
    intervention_rate: {
      value: total === 0 ? 0 : (edited + rejected) / total,
      event_types: ['approval.decided'],
      event_count: total,
      direction: 'lower_better',
    },
    guardrail_hits: {
      value: count(evidence, 'guardrail.hit'),
      event_types: ['guardrail.hit'],
      event_count: count(evidence, 'guardrail.hit'),
      direction: 'lower_better',
    },
    queue_latency_ms: {
      value:
        latencies.length === 0
          ? 0
          : Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
      event_types: ['approval.created', 'approval.decided'],
      event_count: latencies.length,
      direction: 'lower_better',
    },
    tokens_per_item: {
      value: workItems === 0 ? 0 : Math.round(tokens / workItems),
      event_types: ['model.usage', 'run.started'],
      event_count: usage.length,
      direction: 'lower_better',
      note: `tokens=${tokens} work_items=${workItems}`,
    },
    staged_changes: {
      value: distinctChanges(evidence, 'change.staged').size,
      event_types: ['change.staged'],
      event_count: count(evidence, 'change.staged'),
      direction: 'higher_better',
      note: '按 change_id 去重（运行时与账本各发一条）',
    },
    applied_changes: {
      value: distinctChanges(evidence, 'change.applied').size,
      event_types: ['change.applied'],
      event_count: count(evidence, 'change.applied'),
      direction: 'higher_better',
    },
    outbound_sent: {
      value: count(evidence, 'delivery.sent'),
      event_types: ['delivery.sent'],
      event_count: count(evidence, 'delivery.sent'),
      direction: 'higher_better',
    },
    blocked_proposals: {
      value: count(evidence, 'change.blocked', 'approval.blocked'),
      event_types: ['change.blocked', 'approval.blocked'],
      event_count: count(evidence, 'change.blocked', 'approval.blocked'),
      direction: 'lower_better',
    },
    runs_failed: {
      value: count(evidence, 'run.failed'),
      event_types: ['run.failed'],
      event_count: count(evidence, 'run.failed'),
      direction: 'lower_better',
    },
    tool_calls: {
      value: count(evidence, 'tool.call'),
      event_types: ['tool.call'],
      event_count: count(evidence, 'tool.call'),
      direction: 'lower_better',
    },
    knowledge_gaps: {
      value: count(evidence, 'knowledge.gap.opened'),
      event_types: ['knowledge.gap.opened'],
      event_count: count(evidence, 'knowledge.gap.opened'),
      direction: 'lower_better',
    },
  }
  return table
}
