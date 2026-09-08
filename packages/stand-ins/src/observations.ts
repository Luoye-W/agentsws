import type { AssignmentId, ConnectToken, Iso8601 } from '@agentsws/contracts'
import type { StandInErrorCode } from './errors.js'

/**
 * 16 §3「在沙盒里跑一遍工具并观察出网」：合成 provider 记录**每一次** execute，
 * 供副作用审计（哪个工具真的写了外部、用的什么 token、写了什么）。
 * 载荷只留摘要（键 + 短标量），不整份复制业务数据。
 */
export interface OutboundObservation {
  seq: number
  at: Iso8601
  service: string
  action_id: string
  side_effect: 'read' | 'write'
  /** 16 §3 的副作用类别：读外部 vs 写外部。 */
  category: 'read_external' | 'write_external'
  connection_id?: string
  token_kind?: ConnectToken['kind']
  assignment_id?: AssignmentId
  idempotency_key?: string
  input_summary: Record<string, string>
  status: 'ok' | 'error' | 'blocked'
  error_code?: StandInErrorCode
  execution_id?: string
  /** 命中 24h 幂等窗口，返回的是原结果而不是又跑了一次。 */
  replayed?: boolean
  /** 被注入的故障（26 §3）。 */
  injected?: string
}

const MAX_SUMMARY_CHARS = 120
const MAX_SUMMARY_KEYS = 12

function scalar(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'string')
    return v.length > MAX_SUMMARY_CHARS ? `${v.slice(0, MAX_SUMMARY_CHARS)}…` : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[array:${v.length}]`
  return `{object:${Object.keys(v as Record<string, unknown>).length}}`
}

/** 出站调用的输入摘要：只留顶层键与短标量，长文本截断，嵌套只留形状。 */
export function summarizeInput(input: unknown): Record<string, string> {
  if (input === null || input === undefined) return {}
  if (typeof input !== 'object') return { value: scalar(input) }
  if (Array.isArray(input)) return { value: `[array:${input.length}]` }
  const out: Record<string, string> = {}
  for (const k of Object.keys(input as Record<string, unknown>)
    .sort()
    .slice(0, MAX_SUMMARY_KEYS)) {
    out[k] = scalar((input as Record<string, unknown>)[k])
  }
  return out
}

/** 出站观察日志。合成 provider 往里写，场景断言从里面读。 */
export class ObservationLog {
  private readonly items: OutboundObservation[] = []

  record(o: Omit<OutboundObservation, 'seq'>): OutboundObservation {
    const entry: OutboundObservation = { ...o, seq: this.items.length + 1 }
    this.items.push(entry)
    return entry
  }

  all(): OutboundObservation[] {
    return [...this.items]
  }

  get length(): number {
    return this.items.length
  }

  byAction(action_id: string): OutboundObservation[] {
    return this.items.filter((o) => o.action_id === action_id)
  }

  /** 写外部的调用（16 §3 公司端默认 block 的那一类）。 */
  writes(): OutboundObservation[] {
    return this.items.filter((o) => o.category === 'write_external')
  }

  /** 副作用审计表：每个 action 的调用次数与结果分布。 */
  audit(): {
    action_id: string
    category: OutboundObservation['category']
    ok: number
    error: number
  }[] {
    const byAction = new Map<
      string,
      { category: OutboundObservation['category']; ok: number; error: number }
    >()
    for (const o of this.items) {
      const row = byAction.get(o.action_id) ?? { category: o.category, ok: 0, error: 0 }
      if (o.status === 'ok') row.ok += 1
      else row.error += 1
      byAction.set(o.action_id, row)
    }
    return [...byAction.entries()]
      .map(([action_id, row]) => ({ action_id, ...row }))
      .sort((a, b) => a.action_id.localeCompare(b.action_id))
  }

  clear(): void {
    this.items.length = 0
  }
}
