import type { EventEnvelope, ExecutionSnapshot, Iso8601, ObjectRef } from '@agentsws/contracts'
import { executionSnapshot } from '@agentsws/core'
import { MemoryTxnStore } from './store.js'
import type { SnapshotComponents, TxnOptions, TxnPolicy, TxnStore } from './types.js'
import { makeIdFactory, nonceFrom, resolvePolicy } from './util.js'

export interface EmitInput {
  workspace_id: string
  actor: EventEnvelope['actor']
  subject?: ObjectRef
  correlation?: Partial<EventEnvelope['correlation']>
  payload: unknown
  item_id?: string
}

/** 三个子模块（审批 / 账本 / 执行器）共享的一个事务边界上下文（31 §1 I8）。 */
export class TxnRuntime {
  readonly store: TxnStore
  readonly policy: TxnPolicy
  readonly newId: (prefix: string) => string
  readonly secret: string

  constructor(readonly opts: TxnOptions) {
    this.store = opts.store ?? new MemoryTxnStore()
    this.policy = resolvePolicy(opts.policy)
    this.newId = makeIdFactory(opts.random, () => opts.clock.now())
    this.secret = opts.secret ?? `s_${nonceFrom(opts.random)}${nonceFrom(opts.random)}`
  }

  now(): Iso8601 {
    return this.opts.clock.now()
  }
  random(): number {
    return this.opts.random()
  }
  sample(): number {
    return (this.opts.sampler ?? this.opts.random)()
  }

  async emit(type: string, e: EmitInput): Promise<EventEnvelope> {
    const env: EventEnvelope = {
      id: this.newId('evt'),
      schema_version: 1,
      workspace_id: e.workspace_id,
      type,
      at: this.now(),
      actor: e.actor,
      ...(e.subject ? { subject: e.subject } : {}),
      correlation: { trace_id: this.newId('tr'), ...e.correlation },
      payload: e.payload,
    }
    if (e.item_id) this.store.pushEventId(e.item_id, env.id)
    await this.opts.eventSink(env)
    return env
  }

  /** 14 §4 / 31 §3.2：执行快照的八个分量，创建与 apply 用同一个函数算。 */
  snapshot(c: SnapshotComponents): ExecutionSnapshot {
    return executionSnapshot({ ...c })
  }
}
