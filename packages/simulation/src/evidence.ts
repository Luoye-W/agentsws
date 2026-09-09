/**
 * 一次场景运行留下的全部证据。不变量、断言、指标都只读这里——
 * 且**只读事件日志与出站观察**，不读内核的内部状态（26 §6.4：每个指标都能追溯到事件查询）。
 */
import type {
  ApprovalItem,
  EventEnvelope,
  InboundEvent,
  Iso8601,
  PersonId,
  RunEvent,
  RunRequest,
  RunResult,
  StagedChange,
} from '@agentsws/contracts'
import type { DeliveryRecord, OutboundObservation } from '@agentsws/stand-ins'

export interface RunRecord {
  request: RunRequest
  started_at: Iso8601
  finished_at: Iso8601
  status: RunResult['status'] | 'failed'
  events: RunEvent[]
  result?: RunResult
  failure?: { code: string; message: string; retryable: boolean }
}

/** 模型不可用的一段虚拟时间（26 §3 故障注入 / 09 §5.7 降级）。 */
export interface OutageWindow {
  from_ms: number
  to_ms: number
}

export interface NotificationRecord {
  to: PersonId
  channel: string
  title: string
  at: Iso8601
  reason: string
}

/** 被门禁挡下的一次提议（authorization_check / guardrail / 预检）。 */
export interface BlockedRecord {
  rule: string
  at: Iso8601
  run_id?: string
  message: string
}

export interface Evidence {
  workspace_id: string
  start: Iso8601
  end: Iso8601
  events: EventEnvelope[]
  runs: RunRecord[]
  inbound: InboundEvent[]
  observations: OutboundObservation[]
  /** 审批卡投递（工作台） */
  cards: DeliveryRecord[]
  /** 真正发出去的对外邮件 */
  emails: DeliveryRecord[]
  approvals: ApprovalItem[]
  changes: StagedChange[]
  outages: OutageWindow[]
  notifications: NotificationRecord[]
  blocked: BlockedRecord[]
  /** WP29 学习回路的状态（没装学习回路的场景没有这一项）。 */
  learning?: LearningEvidence
}

/** 池里攒了几条、夜间整理拦下了什么（24 §3）。 */
export interface LearningEvidence {
  pooled: number
  proposals: number
  /** 最近一次夜间整理被拦下的原因（`rejected_before` / `policy_layer` …） */
  filtered: string[]
  /** 采纳后叠加解析出来的技能正文（下一次运行进 prompt 的就是它） */
  resolved_skills: string[]
}

export const payloadOf = (e: EventEnvelope): Record<string, unknown> =>
  e.payload !== null && typeof e.payload === 'object' && !Array.isArray(e.payload)
    ? (e.payload as Record<string, unknown>)
    : {}
