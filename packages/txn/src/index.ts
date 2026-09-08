import { ApprovalBusImpl } from './approvals.js'
import { Executor } from './executor.js'
import { ChangeLedgerImpl } from './ledger.js'
import { TxnRuntime } from './runtime.js'
import type { TxnOptions } from './types.js'

export { ApprovalBusImpl, type BatchEntry, finalPayload } from './approvals.js'
export { Executor, type ReconcileOutcome } from './executor.js'
export { ChangeLedgerImpl } from './ledger.js'
export { isKnownKind, type PrecheckOutcome, runPrecheck } from './precheck.js'
export { TxnRuntime } from './runtime.js'
export { MemoryTxnStore } from './store.js'
export * from './types.js'
export {
  businessHoursBetween,
  counterKey,
  DEFAULT_POLICY,
  dedupeKey,
  expiryFor,
  localDay,
  scanSecrets,
} from './util.js'

export interface Txn {
  approvals: ApprovalBusImpl
  ledger: ChangeLedgerImpl
  executor: Executor
  runtime: TxnRuntime
}

/**
 * 交易控制模块（31 §1 I8）：审批总线 #3 + 变更账本 #4 + 执行器 #5，一个事务边界。
 * 时间经 clock，随机经 random，事件经 eventSink，存储可换（默认内存）。
 */
export function createTxn(opts: TxnOptions): Txn {
  const runtime = new TxnRuntime(opts)
  const approvals = new ApprovalBusImpl(runtime)
  const ledger = new ChangeLedgerImpl(runtime, approvals)
  const executor = new Executor(runtime, approvals)
  approvals.applier = (item) => executor.applyApproval(item.id)
  return { approvals, ledger, executor, runtime }
}
