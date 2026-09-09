/**
 * 15 §5.8 最后半句、31 §3.2 明写的一条：**备份恢复后先跑对账，再放开出站**（39 待办 B）。
 *
 * 为什么非要有这一步。想象这台机器昨天崩了，今天从备份恢复：
 *
 * - 备份里可能有一条 `applying` 的变更——进程正在调 Shopify 退款时断的电。
 *   那笔钱到底退没退？**不知道**。
 * - 也可能有一条 `unknown`——上一次已经判定「响应丢了」，还没查证。
 *
 * 这两种都意味着「我们对真实世界的认识不完整」。这种时候**最危险的动作是发出站**：
 * 给客户回一封「您的退款已处理」，而那笔退款可能压根没发生（或者已经发生两次）。
 * 所以规范的顺序是：先挂急停的 `outbound` 档 → 跑对账 → 收口了再放开。
 *
 * 三条纪律：
 * - **不抢用户的档**：如果 `outbound` 本来就是人自己停的（或环境变量停的），
 *   对账完不去替他放开。只放我们自己挂上的那一次。
 * - **查不出来不硬猜**：后端答不上「写没写进去」的，那条留在 `unknown` 里当人工对账项
 *   （15 §5.8 的原话）。这时出站**保持停着**——机器不该在自己都不确定的时候对外说话。
 * - 时间只经 Clock；对账本身是幂等的（`Executor.reconcile` 只吃 `unknown`）。
 */
import type {
  Clock,
  EventEnvelope,
  Halt,
  Iso8601,
  StagedChange,
  WorkspaceId,
} from '@agentsws/contracts'
import type { ReconcileOutcome, Txn } from '@agentsws/txn'

/** `GET /v1/health` 里那一格。 */
export type ReconcileState = 'pending' | 'done'

/** 这台机器为什么挂着 outbound 档（错误信息与事件的 reason）。 */
export const RECONCILE_HALT_REASON = '对账未完成：备份恢复 / 上次施行中断，先对完账再放开出站'

export interface ReconcileReport {
  state: ReconcileState
  /** 这一轮查了几条。 */
  checked: number
  /** 查证「确实写进去了」的。 */
  applied: string[]
  /** 查证「确实没写进去」的。 */
  failed: string[]
  /** 查不出来、留给人的对账项。 */
  unresolved: string[]
  /** 出站档现在停着吗（我们挂的或人挂的都算）。 */
  outbound_halted: boolean
}

export interface ReconcileGuardOptions {
  clock: Clock
  halt: Halt
  txn: Txn
  workspace_id: WorkspaceId
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /**
   * 「这条到底写进去没有」的回查。
   *
   * 生产路径是后端各自的查询（按 `execution_id` / 平台对象）；
   * 答不上来就回 `undefined`——**不许猜**，猜错一次就是一笔重复退款或一笔没退的钱。
   */
  verify?(
    change: StagedChange,
  ): Promise<ReconcileOutcome | undefined> | ReconcileOutcome | undefined
}

export interface ReconcileGuard {
  /** `GET /v1/health` 读它。 */
  state(): ReconcileState
  /** 还有几条没对上账。 */
  pending(): number
  /**
   * 启动时同步跑的那一步：**只判断要不要挂档**，不做 IO。
   *
   * 之所以和 `run()` 分开：挂档要在进程开始接活之前就生效，而对账要查外部系统、
   * 可能很慢。先把闸拉下来，再慢慢查。
   */
  engage(): ReconcileState
  /** 真正跑一轮对账；收口了就把我们挂的那道档放开。 */
  run(): Promise<ReconcileReport>
}

const idsOf = (list: readonly StagedChange[]): string[] => list.map((c) => c.id)

export function createReconcileGuard(options: ReconcileGuardOptions): ReconcileGuard {
  const { clock, halt, txn, workspace_id } = options
  /** 这道 outbound 档是我们挂的吗？只有我们挂的才由我们放开。 */
  let engagedByUs = false
  let state: ReconcileState = 'done'

  /** 认识不完整的那几条：`unknown`（等查）+ `applying`（半路断的）。 */
  const outstanding = (): StagedChange[] =>
    txn.runtime.store.listChanges({ workspace_id, status: ['unknown', 'applying'] })

  const emit = (type: 'halt.changed', payload: Record<string, unknown>, at: Iso8601): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      at,
      actor: { kind: 'system', id: 'reconcile' },
      correlation: { trace_id: `tr_reconcile_${at}` },
      payload,
    })
  }

  const engage = (): ReconcileState => {
    const stuck = outstanding()
    if (stuck.length === 0) {
      state = 'done'
      return state
    }
    state = 'pending'
    if (!halt.isHalted('outbound')) {
      halt.set('outbound', true, RECONCILE_HALT_REASON)
      engagedByUs = true
      emit(
        'halt.changed',
        { scope: 'outbound', on: true, reason: RECONCILE_HALT_REASON, pending: stuck.length },
        clock.now(),
      )
    }
    return state
  }

  const release = (report: Omit<ReconcileReport, 'outbound_halted'>): void => {
    if (!engagedByUs) return
    halt.set('outbound', false)
    engagedByUs = false
    emit(
      'halt.changed',
      {
        scope: 'outbound',
        on: false,
        reason: '对账收口，出站放开',
        reconciled: report.applied.length,
      },
      clock.now(),
    )
  }

  return {
    state: () => state,
    pending: () => outstanding().length,
    engage,

    async run(): Promise<ReconcileReport> {
      // 每次跑之前重算一遍：别的路径（正常 apply）也会新造 unknown
      engage()
      // ① 半路断掉的先收拢进对账队列——不然它们停在 `applying`，没有人管
      await txn.executor.recoverInterrupted(workspace_id)

      const queue = txn.executor.pendingReconcile(workspace_id)
      const applied: string[] = []
      const failed: string[] = []
      const unresolved: string[] = []
      for (const change of queue) {
        const outcome = await options.verify?.(change)
        if (outcome === undefined) {
          // 15 §5.8：确认不了 → 人工对账项。留在 unknown 里，出站保持停着。
          unresolved.push(change.id)
          continue
        }
        const done = await txn.executor.reconcile(change.id, outcome)
        ;(done.status === 'applied' ? applied : failed).push(change.id)
      }

      const remaining = idsOf(outstanding())
      state = remaining.length === 0 ? 'done' : 'pending'
      const report: Omit<ReconcileReport, 'outbound_halted'> = {
        state,
        checked: queue.length,
        applied,
        failed,
        unresolved,
      }
      if (state === 'done') release(report)
      return { ...report, outbound_halted: halt.isHalted('outbound') }
    },
  }
}
