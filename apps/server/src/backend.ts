/**
 * 施行侧的内存桩（15 §5 步骤 4 / 6）。
 *
 * 真正的连接器与外部 Backend 在 WP8 stand-ins / OpenConnector 里；这里只提供
 * 「重读记录」与「真正写」的最小可替换实现，让协同服务能端到端跑通一条链路。
 */
import type { ApprovalItem, ObjectRef, StagedChange } from '@agentsws/contracts'
import type { BackendResult, RecordRead } from '@agentsws/txn'

const key = (t: ObjectRef): string => `${t.type}:${t.id}`

export interface BackendCall {
  id: string
  idempotency_key: string
  attempt: number
  kind: 'apply' | 'deliver'
}

export class MemoryBackend {
  readonly #records = new Map<string, RecordRead>()
  readonly #results = new Map<string, BackendResult>()
  readonly calls: BackendCall[] = []
  #seq = 0

  setRecord(target: ObjectRef, read: RecordRead): void {
    this.#records.set(key(target), read)
  }

  /** 指定某条变更 / 审批项的 backend 结果（测试用；缺省成功）。 */
  setResult(id: string, result: BackendResult): void {
    this.#results.set(id, result)
  }

  read(target: ObjectRef): RecordRead {
    return this.#records.get(key(target)) ?? {}
  }

  apply(change: StagedChange, opts: { idempotencyKey: string; attempt: number }): BackendResult {
    this.calls.push({
      id: change.id,
      idempotency_key: opts.idempotencyKey,
      attempt: opts.attempt,
      kind: 'apply',
    })
    const forced = this.#results.get(change.id)
    if (forced) return forced
    this.#seq += 1
    return { status: 'ok', execution_id: `exec_${this.#seq}`, outcome_ref: change.target }
  }

  deliver(item: ApprovalItem, opts: { idempotencyKey: string; attempt: number }): BackendResult {
    this.calls.push({
      id: item.id,
      idempotency_key: opts.idempotencyKey,
      attempt: opts.attempt,
      kind: 'deliver',
    })
    const forced = this.#results.get(item.id)
    if (forced) return forced
    this.#seq += 1
    return { status: 'ok', execution_id: `dlv_${this.#seq}` }
  }
}
