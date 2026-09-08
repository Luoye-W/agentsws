import type { AssignmentId, ErrorCode, Iso8601 } from '@agentsws/contracts'

/**
 * 21 §1 / 18 §1：每次 `execute` 的 `meta.executionId` 都要进事件日志并与 run / change 关联。
 *
 * 契约的 `KnownEventType` 还没有 connect 类事件（报告里已申请补 `connect.*` 五条），
 * 所以这里先自定义一个最小的 sink：装配方把它接到 `EventLog.append` 上，type 原样透传。
 *
 * **payload 里永远没有凭据**——token 只以 `token_fingerprint`（sha256 前 12 位）出现。
 */
export type ConnectEventType =
  | 'connect.token_issued'
  | 'connect.tokens_revoked'
  | 'connect.executed'
  | 'connect.execute_failed'
  | 'connect.proxy_denied'
  | 'connect.connection_started'
  | 'connect.connection_established'
  | 'connect.connection_transferred'

export interface ConnectEvent {
  type: ConnectEventType
  at: Iso8601
  assignment_id?: AssignmentId
  /** 与 run / change 关联的执行 id（上游 `meta.executionId`）。 */
  execution_id?: string
  payload: Record<string, unknown>
}

export interface ConnectEventSink {
  emit(event: ConnectEvent): void | Promise<void>
}

/** 测试与本地调试用：把事件攒在内存里。 */
export class MemoryEventSink implements ConnectEventSink {
  readonly events: ConnectEvent[] = []

  emit(event: ConnectEvent): void {
    this.events.push(event)
  }

  ofType(type: ConnectEventType): ConnectEvent[] {
    return this.events.filter((e) => e.type === type)
  }

  clear(): void {
    this.events.length = 0
  }
}

export interface ExecutedPayload extends Record<string, unknown> {
  action_id: string
  service: string
  side_effect: 'read' | 'write'
  connection_id?: string
  token_kind: 'role-read' | 'role-apply'
  token_fingerprint: string
  idempotency_key?: string
  idempotent_replay?: boolean
  duration_ms: number
}

export interface ExecuteFailedPayload extends Record<string, unknown> {
  action_id: string
  code: ErrorCode
  runtime_error_code?: string
  token_fingerprint?: string
}
