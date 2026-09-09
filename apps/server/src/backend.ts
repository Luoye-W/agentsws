/**
 * 施行侧的内存桩（15 §5 步骤 4 / 6）。
 *
 * 真正的连接器与外部 Backend 在 WP8 stand-ins / OpenConnector 里；这里只提供
 * 「重读记录」与「真正写」的最小可替换实现，让协同服务能端到端跑通一条链路。
 *
 * WP34 起它还兑现两件真后端必须做的事：
 *
 * 1. **围栏号**（31 §3.2 (f) / 39 待办 G）：记下每个目标见过的最大 `fencing_token`，
 *    比它小的一律拒。锁挡的是「同时写」，围栏号挡的是「租约过期后才醒过来、
 *    以为自己还持着锁」的**迟到写**——这两件事不是一回事，少一件就漏一种。
 * 2. **对账查询**（15 §5.8 / 39 待办 B）：`unknown` 之后按 `execution_id` /
 *    平台对象回查「到底写没写进去」。桩只能答它自己见过的那一份。
 */
import type { ApprovalItem, ObjectRef, StagedChange } from '@agentsws/contracts'
import type {
  ApplyCallbackOptions,
  BackendResult,
  ReconcileOutcome,
  RecordRead,
} from '@agentsws/txn'

const key = (t: ObjectRef): string => `${t.type}:${t.id}`

export interface BackendCall {
  id: string
  idempotency_key: string
  attempt: number
  kind: 'apply' | 'deliver'
  fencing_token?: number
}

/**
 * 围栏号被拒时回给执行器的那一条。
 *
 * 用 `failed` 而不是 `unknown`：这次写**确定没有发生**（我们根本没往下走），
 * 把它记成 unknown 会白白造出一条对账项。`retryable: false` 是因为重试也没用
 * ——号只会更小，重试的前提是先重新拿锁拿到新号。
 */
export const LATE_WRITE_ERROR = 'conflict：fencing_token 比这个目标见过的最大号小，拒绝迟到写'

export class MemoryBackend {
  readonly #records = new Map<string, RecordRead>()
  readonly #results = new Map<string, BackendResult>()
  /** `<围栏 key>` → 见过的最大号。**只增不减**（与存储层的锁号同一条纪律）。 */
  readonly #fencing = new Map<string, number>()
  /** 真写成功的那几条：对账时按 change_id 回查。 */
  readonly #applied = new Map<string, { execution_id?: string; outcome_ref?: ObjectRef }>()
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

  /** 观察面：某个围栏 key 现在见过的最大号（诊断与测试用）。 */
  fencingTokenOf(fencingKey: string): number | undefined {
    return this.#fencing.get(fencingKey)
  }

  /**
   * 见过的最大号；比它小就是迟到写。
   *
   * `undefined`（老调用方没传号）一律放行——不能因为围栏号还没接上就让整条链路停摆；
   * 传了号的路径才受这道闸管。
   */
  #fenced(fencingKey: string, token: number | undefined): boolean {
    if (token === undefined) return false
    const seen = this.#fencing.get(fencingKey)
    if (seen !== undefined && token < seen) return true
    if (seen === undefined || token > seen) this.#fencing.set(fencingKey, token)
    return false
  }

  apply(
    change: StagedChange,
    opts: Partial<ApplyCallbackOptions> & { attempt: number },
  ): BackendResult {
    // 围栏 key 与存储层的施行锁同一把：`<target>|<kind>`（同目标同 kind 串行）
    const fencingKey = `${key(change.target)}|${change.kind}`
    this.calls.push({
      id: change.id,
      idempotency_key: opts.idempotencyKey ?? change.id,
      attempt: opts.attempt,
      kind: 'apply',
      ...(opts.fencing_token === undefined ? {} : { fencing_token: opts.fencing_token }),
    })
    if (this.#fenced(fencingKey, opts.fencing_token)) {
      return { status: 'failed', error: { message: LATE_WRITE_ERROR, retryable: false } }
    }
    const forced = this.#results.get(change.id)
    if (forced) {
      if (forced.status === 'ok') this.#remember(change.id, forced)
      return forced
    }
    this.#seq += 1
    const out: BackendResult = {
      status: 'ok',
      execution_id: `exec_${this.#seq}`,
      outcome_ref: change.target,
    }
    this.#remember(change.id, out)
    return out
  }

  deliver(
    item: ApprovalItem,
    opts: Partial<ApplyCallbackOptions> & { attempt: number },
  ): BackendResult {
    const fencingKey = `approval:${item.id}|deliver`
    this.calls.push({
      id: item.id,
      idempotency_key: opts.idempotencyKey ?? item.id,
      attempt: opts.attempt,
      kind: 'deliver',
      ...(opts.fencing_token === undefined ? {} : { fencing_token: opts.fencing_token }),
    })
    if (this.#fenced(fencingKey, opts.fencing_token)) {
      return { status: 'failed', error: { message: LATE_WRITE_ERROR, retryable: false } }
    }
    const forced = this.#results.get(item.id)
    if (forced) return forced
    this.#seq += 1
    return { status: 'ok', execution_id: `dlv_${this.#seq}` }
  }

  /**
   * 15 §5.8 对账：这条变更到底写进去没有？
   *
   * 桩只认它自己这一辈子见过的那几条——**进程重启之后它什么都不知道**，
   * 于是回 `undefined` = 确认不了 = 转人工对账项。这正是规范要的行为：
   * 宁可让人来确认，也不要替真实世界猜一个答案。
   */
  verify(change: StagedChange): ReconcileOutcome | undefined {
    const found = this.#applied.get(change.id)
    if (found === undefined) return undefined
    return {
      status: 'applied',
      ...(found.execution_id === undefined ? {} : { execution_id: found.execution_id }),
      ...(found.outcome_ref === undefined ? {} : { outcome_ref: found.outcome_ref }),
    }
  }

  #remember(change_id: string, result: BackendResult): void {
    this.#applied.set(change_id, {
      ...(result.execution_id === undefined ? {} : { execution_id: result.execution_id }),
      ...(result.outcome_ref === undefined ? {} : { outcome_ref: result.outcome_ref }),
    })
  }
}
