import type {
  ApprovalItem,
  EventEnvelope,
  Mandate,
  ObjectRef,
  ProvenanceState,
} from '@agentsws/contracts'
import type {
  BackendResult,
  CreateApprovalInput,
  Directory,
  RecordRead,
  StageInput,
  TxnOptions,
  TxnPolicy,
  TxnStore,
} from '../src/index.js'
import { createTxn } from '../src/index.js'

export const WS = 'ws_1'
export const ROLE = 'dtc.aftersales'
export const ASG = 'asg_3'
export const RUN = 'run_5'
export const ORDER: ObjectRef = { type: 'order', id: 'ord_1042' }
export const CUSTOMER: ObjectRef = { type: 'customer', id: 'cus_7' }
export const THREAD: ObjectRef = { type: 'thread', id: 'thr_88' }
/** 2026-09-07 是周一 */
export const T0 = '2026-09-07T09:00:00.000Z'

export function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance(ms: number) {
      t += ms
    },
    set(iso: string) {
      t = Date.parse(iso)
    },
  }
}

/** 确定性伪随机（seed 注入，不用 Math.random） */
export function seeded(seed = 42): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const refundMandate: Mandate = {
  caps: { max_auto_refund_amount: 50, within_policy_window_only: true, return_window_days: 14 },
  per_change_limits: { no_repeat_target_field: true },
  window: { max_count: 20, per: 'day' },
}

export const provenanceState = (over: Partial<ProvenanceState> = {}): ProvenanceState => ({
  run_id: RUN,
  seen: { order: [ORDER.id], customer: [CUSTOMER.id], thread: [THREAD.id] },
  read_full: [],
  recorded_at: T0,
  ...over,
})

export interface Harness {
  txn: ReturnType<typeof createTxn>
  clock: ReturnType<typeof makeClock>
  events: EventEnvelope[]
  typesOf(prefix?: string): string[]
  backendCalls: { id: string; key: string; attempt: number; fencing_token: number }[]
  setRecord(target: ObjectRef, read: RecordRead): void
  setBackend(fn: (attempt: number, id: string) => BackendResult | Promise<BackendResult>): void
}

export function harness(
  opts: {
    policy?: Partial<TxnPolicy>
    directory?: Directory
    sampler?: () => number
    records?: Record<string, RecordRead>
    backend?: (attempt: number, id: string) => BackendResult | Promise<BackendResult>
    mandateFor?: TxnOptions['mandateFor']
    readRecordEnabled?: boolean
    /** 换存储（WP18：同一套用例也要能跑在 SQLite 档上） */
    store?: TxnStore
    /** 固定 decision_token 密钥，重启后仍能验签 */
    secret?: string
    start?: string
  } = {},
): Harness {
  const clock = makeClock(opts.start ?? T0)
  const events: EventEnvelope[] = []
  const records: Record<string, RecordRead> = { ...opts.records }
  const backendCalls: { id: string; key: string; attempt: number; fencing_token: number }[] = []
  let backend: (attempt: number, id: string) => BackendResult | Promise<BackendResult> =
    opts.backend ?? (() => ({ status: 'ok', execution_id: 'exec_1' }))
  const txn = createTxn({
    clock: { now: () => clock.now() },
    random: seeded(7),
    ...(opts.sampler ? { sampler: opts.sampler } : {}),
    ...(opts.store ? { store: opts.store } : {}),
    ...(opts.secret ? { secret: opts.secret } : {}),
    eventSink: (e) => {
      events.push(e)
    },
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.directory ? { directory: opts.directory } : {}),
    ...(opts.mandateFor ? { mandateFor: opts.mandateFor } : {}),
    ...(opts.readRecordEnabled === false
      ? {}
      : { readRecord: (t: ObjectRef) => records[`${t.type}:${t.id}`] ?? {} }),
    backendApply: (change, o) => {
      backendCalls.push({
        id: change.id,
        key: o.idempotencyKey,
        attempt: o.attempt,
        fencing_token: o.fencing_token,
      })
      return backend(o.attempt, change.id)
    },
    deliverOutbound: (item, o) => {
      backendCalls.push({
        id: item.id,
        key: o.idempotencyKey,
        attempt: o.attempt,
        fencing_token: o.fencing_token,
      })
      return backend(o.attempt, item.id)
    },
  })
  return {
    txn,
    clock,
    events,
    typesOf: (prefix = '') => events.filter((e) => e.type.startsWith(prefix)).map((e) => e.type),
    backendCalls,
    setRecord: (target, read) => {
      records[`${target.type}:${target.id}`] = read
    },
    setBackend: (fn) => {
      backend = fn
    },
  }
}

type StageOverrides = Omit<{ [K in keyof StageInput]?: StageInput[K] | undefined }, 'approval'> & {
  approval?: Partial<StageInput['approval']>
}

const stripUndefined = <T extends object>(o: T): T => {
  for (const k of Object.keys(o))
    if ((o as Record<string, unknown>)[k] === undefined) delete (o as Record<string, unknown>)[k]
  return o
}

/** 一条合法的退款 stage 输入（订单在退货窗口内、请求者就是订单客户） */
export function refundStage(over: StageOverrides = {}): StageInput {
  const base: StageInput = {
    workspace_id: WS,
    role_id: ROLE,
    assignment_id: ASG,
    run_id: RUN,
    change_set_id: 'cs_5',
    kind: 'refund',
    target: ORDER,
    before: {
      total: 89,
      refunded: 0,
      financial_status: 'paid',
      delivered_at: '2026-09-01T09:00:00.000Z',
    },
    after: { refund_amount: 42 },
    record_version: 'v1',
    money: {
      amount: 42,
      currency: 'USD',
      amount_base: 42,
      base_currency: 'USD',
      fx_rate: 1,
      fx_at: T0,
    },
    created_by: { kind: 'agent', id: 'agent_aftersales' },
    mandate: refundMandate,
    level: 'L1',
    provenance: provenanceState(),
    requester: { channel: 'email', external_id: 'anna@example.com', resolved: CUSTOMER },
    target_owner: CUSTOMER,
    connection_id: 'conn_shopify',
    approval: {
      title: '退款 $42.00 给 Anna（订单 #1042）',
      summary: '订单已签收 6 天，在退货窗口内；条款允许原路退款。',
      recipients: [{ person: 'p_wang', via: 'role_holder' }],
      proposer: { kind: 'agent', id: 'agent_aftersales', assignment_id: ASG },
      separation_of_duties: true,
    },
  }
  return stripUndefined({
    ...base,
    ...over,
    approval: stripUndefined({ ...base.approval, ...over.approval }),
  }) as StageInput
}

/** 一条合法的对外草稿审批项输入 */
type OutboundOverrides = {
  [K in keyof CreateApprovalInput<Record<string, unknown>>]?:
    | CreateApprovalInput<Record<string, unknown>>[K]
    | undefined
}

export function outboundInput(
  over: OutboundOverrides = {},
): CreateApprovalInput<Record<string, unknown>> {
  const base: CreateApprovalInput<Record<string, unknown>> = {
    workspace_id: WS,
    schema_version: 1,
    kind: 'outbound_draft',
    role_id: ROLE,
    subject: { object: THREAD, conversation_id: 'conv_31' },
    dedupe_key: `dk_${WS}|outbound_draft|${THREAD.id}`,
    title: '回复 Anna：确认 14 天内退货，退款 $42.00',
    summary: '订单 #1042 已签收 6 天，在退货窗口内。',
    payload: {
      channel: 'email',
      to: CUSTOMER,
      thread_ref: THREAD.id,
      body: { subject: 'Re: Return request #1042', text: 'Hi Anna, we will refund you.' },
      language: 'en',
    },
    evidence: {
      run_id: RUN,
      source_events: ['evt_in_9'],
      provenance: { seen: [ORDER, CUSTOMER, THREAD] },
      precheck: {},
    },
    proposer: { kind: 'agent', id: 'agent_aftersales', assignment_id: ASG },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: 'p_wang', via: 'role_holder' }],
      rule: 'role_holder',
      escalation: {
        after_hours: 24,
        business_hours: true,
        chain: ['scope_manager', 'owner'],
        escalated_at: [],
      },
      separation_of_duties: true,
    },
    priority: 'queue',
    context: { thread_participants: [CUSTOMER.id], connection_id: 'conn_mail' },
  }
  return stripUndefined({ ...base, ...over }) as CreateApprovalInput<Record<string, unknown>>
}

export const tokenOf = (item: ApprovalItem, person = 'p_wang'): string => {
  const d = item.deliveries.find((x) => x.to === person)
  if (!d) throw new Error(`no delivery for ${person}`)
  return d.decision_token
}
