/**
 * 世界装配：把**同一份生产代码**的外部边界指向替身（09 §3.1「真实内核」）。
 *
 * 内核（事件日志）+ 数据层 + 制度（职责 / 分配 / 策略层）+ 知识 + 模型网关 + 交易控制模块
 * 全部是真实实现；只有 provider（mock OpenConnector）、模型（stub）、人（合成人）、
 * 时钟（合成时钟）、投递（收件箱）、入站（内存管线）是替身。
 */
import type {
  Assignment,
  ChangeKind,
  ChatMessage,
  DataRecord,
  EventEnvelope,
  InboundEvent,
  Iso8601,
  Mandate,
  ModelRef,
  ObjectRef,
  PersonId,
  ProvenanceState,
  RoleId,
  RunEvent,
  RunRequest,
  ToolDef,
} from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'
import type { DataActor, SqliteDataStore } from '@agentsws/data'
import { createDataStore, defineCollection } from '@agentsws/data'
import { createDshRuntime } from '@agentsws/dsh-adapter'
import type { Kernel, Random } from '@agentsws/kernel'
import { createKernel, seededRandom } from '@agentsws/kernel'
import type { Knowledge } from '@agentsws/knowledge'
import { createKnowledge } from '@agentsws/knowledge'
import type { ModelGatewayApi, ModelGatewayPolicy } from '@agentsws/model-gateway'
import { createModelGateway, ProviderError, stubProvider } from '@agentsws/model-gateway'
import type { EffectiveConfig, RoleStore } from '@agentsws/roles'
import { createRoleStore, loadBundledRole } from '@agentsws/roles'
import type {
  DraftPayload,
  MockOpenConnector,
  StageIntent,
  StandIns,
  ToolExecution,
} from '@agentsws/stand-ins'
import {
  connectToolExecutor,
  createStandIns,
  MemoryInboundPipeline,
  SyntheticClock,
} from '@agentsws/stand-ins'
import type { Txn } from '@agentsws/txn'
import { createTxn, dedupeKey } from '@agentsws/txn'
import { SimulationError } from './errors.js'
import type { BlockedRecord, NotificationRecord, OutageWindow } from './evidence.js'
import type { Pack, PackAssignment, PackCustomer } from './pack.js'

const CUSTOMERS = defineCollection({
  name: 'customers',
  domain: 'customer',
  fields: {
    name: { sensitivity: 'internal' },
    email: { sensitivity: 'internal' },
    market: { sensitivity: 'internal' },
  },
})

/** 05 §1 动作 id ↔ 15 §2 变更种类。 */
const ACTION_BY_KIND: Partial<Record<ChangeKind, string>> = {
  refund: 'stage_refund',
  reship: 'stage_reship',
  address_change: 'stage_address_change',
}

const READ_ACTIONS = [
  'shopify_admin.get_order',
  'shopify_admin.list_orders',
  'shopify_admin.get_product',
  'gmail.list_threads',
]
const APPLY_ACTIONS = ['shopify_admin.create_refund', 'gmail.send_message']
const CONNECTIONS = ['conn_shopify_admin', 'conn_gmail']
const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }

export interface RunContext {
  run_id: string
  inbound: InboundEvent
  thread: { id: string; ref: ObjectRef; subject: string; participants: string[] }
  /** 来信人解析出的客户（关系授权门禁的 requester） */
  requester?: { customer: PackCustomer; ref: ObjectRef }
  order?: { id: string; ref: ObjectRef; owner?: ObjectRef }
  change_set_id: string
  /** 本次运行产出的子审批项（staged_change），回信作为父项引用它们 */
  child_approval_ids: string[]
  /** 事件流（stage 时从这里推 provenance） */
  events: RunEvent[]
  request?: RunRequest
}

export interface WorldOptions {
  pack: Pack
  seed: number
  start: Iso8601
  /** 事件日志路径；缺省 `:memory:`（fast 档，26 §4）。 */
  dbPath?: string
  /**
   * 用哪个运行时适配器（17 §4）。缺省 `stub`（fast 档）；
   * `dsh` 走 `@agentsws/dsh-adapter`（真 DeepSeek Harness 的 seam），证明运行时可替换。
   */
  runtime?: 'stub' | 'dsh'
}

export interface World {
  clock: SyntheticClock
  random: Random
  kernel: Kernel
  data: SqliteDataStore
  roles: RoleStore
  knowledge: Knowledge
  txn: Txn
  standIns: StandIns
  connect: MockOpenConnector
  inbound: MemoryInboundPipeline
  pack: Pack
  workspace_id: string
  assignment: Assignment
  effective: EffectiveConfig
  agentActor: DataActor
  role_id: RoleId
  owner: PersonId
  roleHolder: PersonId
  events: EventEnvelope[]
  notifications: NotificationRecord[]
  blocked: BlockedRecord[]
  outages: OutageWindow[]
  runContexts: Map<string, RunContext>
  gateway(): ModelGatewayApi
  /** 场景 `inject.budget`：换一套预算重建网关（BudgetLedger 的 caps 在构造时固定）。 */
  setBudget(budget: ModelGatewayPolicy['budget']): void
  /** 场景 `model.outage`：从现在起 `ms` 毫秒内所有 provider 调用失败。 */
  startOutage(ms: number): void
  modelDown(): boolean
  /** 17 §2 事件 → 事件日志（含 correlation.run_id）。 */
  appendRunEvent(req: RunRequest, e: RunEvent): void
  appendEvent(type: string, payload: unknown, opts?: AppendOpts): void
  notify(n: NotificationRecord): void
  /** 从事件日志推出该次运行的 provenance（15 §6：只证明"读过"）。 */
  provenanceOf(ctx: RunContext): ProvenanceState
  customerRefOf(email: string): ObjectRef | undefined
  emailOfCustomer(ref: ObjectRef): string | undefined
  readCustomer(id: string): Promise<DataRecord<Record<string, unknown>> | undefined>
  searchPolicies(
    text: string,
  ): Promise<{ hits: { id: string; statement: string; layer: string }[] }>
  mandateFor(action: string): Mandate
  levelFor(action: string): 'L1' | 'L2' | 'L3'
  issueReadToken(): Promise<string>
  issueApplyToken(): Promise<string>
  close(): Promise<void>
}

export interface AppendOpts {
  run_id?: string
  change_id?: string
  work_item_id?: string
  subject?: ObjectRef
  actor?: EventEnvelope['actor']
}

const now = (c: SyntheticClock): Iso8601 => c.now()

/** 26 §4 fast 档：内存事件日志 + stub 模型 + 合成时钟。 */
export async function createWorld(opts: WorldOptions): Promise<World> {
  const { pack, seed } = opts
  const clock = new SyntheticClock(opts.start)
  const random = seededRandom(seed)
  const workspace_id = pack.workspace.id

  const kernel = await createKernel({
    dbPath: opts.dbPath ?? ':memory:',
    clock,
    random: seededRandom(seed + 11),
  })
  const events: EventEnvelope[] = []
  const notifications: NotificationRecord[] = []
  const blocked: BlockedRecord[] = []
  const outages: OutageWindow[] = []
  const runContexts = new Map<string, RunContext>()

  const appendEnvelope = (e: Omit<EventEnvelope, 'id' | 'at'>): void => {
    const stored = kernel.eventLog.appendSync(e)
    events.push(stored)
  }
  let traceSeq = 0
  const traceId = (): string => {
    traceSeq += 1
    return `tr_sim_${traceSeq.toString().padStart(6, '0')}`
  }

  // ── 制度：职责定义 + 分配 + 策略层 ─────────────────────────────────────
  const roles = createRoleStore({
    clock,
    roles: [
      loadBundledRole('dtc.aftersales'),
      loadBundledRole('common.owner'),
      loadBundledRole('common.member'),
    ],
    newId: (s) => `asg_${sha256(s).slice(0, 20)}`,
  })
  roles.policies.set({
    workspace_id,
    mandates: pack.policy.mandates as Record<string, Partial<Mandate>>,
    global_caps: pack.policy.global_caps,
    ...(pack.policy.separation_of_duties === undefined
      ? {}
      : { separation_of_duties: pack.policy.separation_of_duties }),
  })

  const created = new Map<string, Assignment>()
  for (const a of pack.assignments) {
    const assignment = roles.assignments.create({
      person_id: a.person_id,
      workspace_id,
      role_id: a.role_id,
      ranges: a.ranges,
      granted_by: a.granted_by,
    })
    created.set(`${a.person_id}|${a.role_id}`, assignment)
  }
  const primary: PackAssignment | undefined = pack.assignments.find((a) => a.primary === true)
  if (primary === undefined) {
    throw new SimulationError('invalid_input', 'pack 的 assignments.yml 缺一条 primary: true')
  }
  const assignment = created.get(`${primary.person_id}|${primary.role_id}`)
  if (assignment === undefined) throw new SimulationError('not_found', 'primary assignment 未建立')
  const effective = roles.effectiveConfig(assignment.id, {
    connected: pack.workspace.markets.length >= 0 ? ['email', 'shopify'] : [],
  })
  const owner = pack.people.find((p) => p.owner === true)?.id ?? primary.person_id
  const roleHolder = primary.person_id

  const agentActor: DataActor = {
    person_id: assignment.person_id,
    assignment_id: assignment.id,
    workspace_id,
    grants: effective.scopes,
    ranges: effective.ranges,
  }
  const seedActor: DataActor = {
    person_id: owner,
    assignment_id: 'asg_seed',
    workspace_id,
    grants: [
      {
        domain: 'customer',
        ops: ['read', 'stage'],
        range: 'workspace',
        max_sensitivity: 'restricted',
      },
    ],
    ranges: [],
  }

  // ── 数据层：客户记录（上下文里的客户经数据层按 actor 过滤）────────────
  const data = createDataStore({ dbPath: ':memory:', clock, collections: [CUSTOMERS] })
  for (const c of pack.customers) {
    await data.put<{ name: string; email: string; market: string }>(
      'customers',
      {
        id: c.id,
        schema_version: 1,
        workspace_id,
        owners: [roleHolder],
        scope: effective.ranges.length > 0 ? [...effective.ranges] : [],
        sensitivity: 'internal',
        name: c.name,
        email: c.email,
        market: c.market,
      },
      seedActor,
    )
  }

  // ── 知识：pack 的三层 markdown ───────────────────────────────────────
  // 19 §6 的知识事件也进同一条事件日志（契约的 KnownEventType 还没有 knowledge.*，见报告）
  const knowledge = createKnowledge({
    clock,
    workspace_id,
    emit: (e) => {
      appendEnvelope({
        schema_version: 1,
        workspace_id: e.workspace_id,
        type: e.type,
        actor: { kind: 'system', id: 'knowledge' },
        correlation: {
          trace_id: traceId(),
          ...(typeof e.payload.run_id === 'string' ? { run_id: e.payload.run_id } : {}),
        },
        payload: e.payload,
      })
    },
  })
  for (const doc of pack.knowledge) {
    const card = await knowledge.store.propose({
      schema_version: 1,
      workspace_id,
      layer: doc.layer,
      domain: doc.domain as 'company',
      scope: [],
      sensitivity: doc.sensitivity,
      subject: { type: doc.domain, key: doc.subject_key },
      statement: doc.body.trim(),
      provenance: [{ source: 'document', ref: doc.path, at: opts.start }],
      confidence: { value: 0.9, state: 'probable' },
      valid: {},
      owner,
      created_by: { kind: 'person', id: owner },
    })
    await knowledge.store.activate(card.id, owner)
    // ingestMarkdown 只为把长文切段（19 §2），fast 档不检索分段
    knowledge.ingestMarkdown(doc.body, { id: `src_${doc.subject_key}`, ref: doc.path })
  }

  // ── 替身：mock OpenConnector / stub 运行时 / 合成人 / 收件箱 ──────────
  // stage / createDraft 要接到交易控制模块，而交易控制模块又要 connect 做后端——
  // 用可变闭包打断这个环，装配完成后两侧都指向真实实现。
  const holder: {
    stage?: (i: StageIntent) => Promise<{ change_id: string } | undefined>
    createDraft?: (p: DraftPayload) => Promise<{ approval_item_id: string } | undefined>
    executeTool?: (call: {
      name: string
      input: Record<string, unknown>
      request: RunRequest
    }) => Promise<ToolExecution>
  } = {}

  const standIns = createStandIns({
    seed,
    clock,
    workspace_id,
    state: pack.mockState(),
    stage: (i) => (holder.stage ?? (async () => undefined))(i),
    createDraft: (p) => (holder.createDraft ?? (async () => undefined))(p),
    executeTool: (c) => (holder.executeTool ?? (async () => ({ status: 'error' as const })))(c),
  })
  const connect = standIns.connect

  const tokenFor = async (kind: 'role-read' | 'role-apply'): Promise<string> => {
    const t = await connect.issueToken({
      assignment_id: assignment.id,
      kind,
      allowed_actions: kind === 'role-read' ? READ_ACTIONS : [...READ_ACTIONS, ...APPLY_ACTIONS],
      allowed_connections: CONNECTIONS,
      expires_in_seconds: 3600,
    })
    return t.token
  }

  // ── 模型网关：stub provider + 可注入的"模型挂了" ──────────────────────
  let outageUntilMs = 0
  const base = stubProvider({ seed, ref: MODEL })
  const gatedProvider = {
    ref: MODEL,
    async complete(req: { messages: ChatMessage[]; tools?: ToolDef[]; seed?: number }) {
      if (clock.nowMs() < outageUntilMs) {
        throw new ProviderError('注入的模型故障：provider 不可用', { status: 503 })
      }
      return base.complete(req)
    },
    async embed(texts: string[]) {
      if (clock.nowMs() < outageUntilMs) {
        throw new ProviderError('注入的模型故障：provider 不可用', { status: 503 })
      }
      if (base.embed === undefined) throw new ProviderError('stub 不支持 embed')
      return base.embed(texts)
    },
  }

  const gatewayPolicy = (budget: ModelGatewayPolicy['budget']): ModelGatewayPolicy => ({
    default: MODEL,
    data_residency: 'cn',
    prices: { 'stub/stub-v1': { in: 1, out: 2, cached: 0.1 } },
    ...(budget === undefined ? {} : { budget }),
  })
  const buildGateway = (budget: ModelGatewayPolicy['budget']): ModelGatewayApi =>
    createModelGateway({
      providers: [gatedProvider],
      policy: gatewayPolicy(budget),
      clock,
      env: {},
      eventSink: (e) => {
        appendEnvelope({ ...e, correlation: { ...e.correlation } })
      },
    })
  let gateway = buildGateway({ workspace_daily_base: 1000, workspace_monthly_base: 20000 })

  // ── 17 §4：换运行时只换这一处；替身的其余部分（连接器、人、时钟）原样不动 ──
  if (opts.runtime === 'dsh') {
    standIns.stubRuntime = createDshRuntime({
      clock,
      seed,
      gateway: { complete: (req) => gateway.complete(req) },
      stage: (i) => (holder.stage ?? (async () => undefined))(i),
      createDraft: (p) => (holder.createDraft ?? (async () => undefined))(p),
      executeTool: (c) => (holder.executeTool ?? (async () => ({ status: 'error' as const })))(c),
    })
  }

  // ── 交易控制模块（真实实现）──────────────────────────────────────────
  const orderOf = (id: string) => connect.state.orders.find((o) => o.id === id)
  const recordFacts = (target: ObjectRef): { record_version?: string; record?: unknown } => {
    if (target.type !== 'order') return {}
    const o = orderOf(target.id)
    if (o === undefined) return {}
    return {
      record_version: o.record_version,
      record: {
        total: o.total_price,
        refunded: o.refunded_amount,
        delivered_at: o.delivered_at,
        financial_status: o.financial_status,
        fulfillment: o.fulfillment_status,
      },
    }
  }

  const emailOfCustomer = (ref: ObjectRef): string | undefined =>
    pack.customers.find((c) => c.id === ref.id)?.email

  const txn = createTxn({
    clock,
    random: seededRandom(seed + 21),
    sampler: seededRandom(seed + 31),
    eventSink: (e) => {
      const { id: _id, at: _at, ...rest } = e
      appendEnvelope(rest)
      if (e.type === 'change.blocked' || e.type === 'approval.blocked') {
        const p = e.payload as Record<string, unknown>
        const rules = Array.isArray(p.reasons)
          ? (p.reasons as string[])
          : typeof p.rule === 'string'
            ? [p.rule]
            : Array.isArray(p.hits)
              ? (p.hits as { rule: string }[]).map((h) => h.rule)
              : []
        for (const rule of rules) {
          blocked.push({
            rule,
            at: e.at,
            message: `${e.type}: ${rule}`,
            ...(e.correlation.run_id === undefined ? {} : { run_id: e.correlation.run_id }),
          })
        }
      }
    },
    policy: {
      business_tz_offset_minutes: 480,
      executor_id: 'sim.executor',
      executor_version: 'sim/1',
    },
    readRecord: (target) => recordFacts(target),
    backendApply: async (change, _opts) => {
      if (change.kind !== 'refund') {
        return { status: 'failed', error: { message: `模拟执行器未实现 kind：${change.kind}` } }
      }
      const money = change.money
      if (money === undefined) {
        return { status: 'failed', error: { message: 'refund 缺 money' } }
      }
      try {
        const res = await connect.execute<{ refund_id: string }>(
          'shopify_admin.create_refund',
          { order_id: change.target.id, amount: money.amount, reason: 'return within window' },
          {
            token: await tokenFor('role-apply'),
            connection: 'conn_shopify_admin',
            // 15 §5 步骤 6：Idempotency-Key = change_id，重试用同一把
            idempotencyKey: change.id,
          },
        )
        return {
          status: 'ok',
          execution_id: res.execution_id,
          outcome_ref: { type: 'order', id: change.target.id },
        }
      } catch (err) {
        const e = err as { code?: string; message?: string }
        if (e.code === 'timeout') {
          return { status: 'unknown', error: { message: e.message ?? '超时，结果未知' } }
        }
        return {
          status: 'failed',
          error: {
            message: e.message ?? String(err),
            retryable: e.code === 'rate_limited' || e.code === 'provider_error',
          },
        }
      }
    },
    deliverOutbound: async (item, _o) => {
      const payload = (item.decision?.edited_payload ?? item.payload) as Record<string, unknown>
      const to = payload.to as ObjectRef | undefined
      const body = (payload.body ?? {}) as Record<string, unknown>
      const email = to === undefined ? undefined : emailOfCustomer(to)
      if (to === undefined || email === undefined) {
        return { status: 'failed', error: { message: '收件人无法解析成邮箱' } }
      }
      try {
        const res = await connect.execute<{ message_id: string; thread_id: string }>(
          'gmail.send_message',
          {
            thread_id: payload.thread_ref,
            to: [email],
            subject: String(body.subject ?? ''),
            body: String(body.text ?? ''),
          },
          {
            token: await tokenFor('role-apply'),
            connection: 'conn_gmail',
            idempotencyKey: item.id,
          },
        )
        await standIns.deliveries.email.deliver(
          {
            id: item.id,
            title: String(body.subject ?? ''),
            summary: String(body.text ?? '').slice(0, 200),
            view: 'full',
            decision_token: '',
            actions: [],
          },
          to.id,
        )
        appendEnvelope({
          schema_version: 1,
          workspace_id,
          type: 'delivery.sent',
          actor: { kind: 'system', id: 'sim.executor' },
          subject: { type: 'approval_item', id: item.id },
          correlation: {
            trace_id: traceId(),
            ...(item.evidence.run_id === undefined ? {} : { run_id: item.evidence.run_id }),
          },
          payload: {
            channel: 'email',
            to: to.id,
            external_id: res.data.message_id,
            idempotency_key: item.id,
          },
        })
        return { status: 'ok', execution_id: res.execution_id }
      } catch (err) {
        const e = err as { code?: string; message?: string }
        return {
          status: e.code === 'timeout' ? 'unknown' : 'failed',
          error: { message: e.message ?? String(err) },
        }
      }
    },
    directory: {
      canApprove: (person, item) =>
        pack.assignments.some((a) => a.person_id === person && a.role_id === item.role_id) ||
        person === owner,
      memberCount: () => pack.people.length,
      scopeManager: () => owner,
      owner: () => owner,
    },
  })
  // 合成人在同一条审批总线上决定（26 §3）
  standIns.actors.attach(txn.approvals)

  // ── 审批卡投递：工作台收件箱（14 §7 每个 recipient 一张卡片）──────────
  const deliveredCards = new Set<string>()
  const flushCards = async (): Promise<void> => {
    for (const item of txn.runtime.store.listApprovals({ workspace_id })) {
      for (const d of item.deliveries) {
        const key = `${item.id}#${d.decision_token}`
        if (deliveredCards.has(key) || d.status !== 'sent') continue
        deliveredCards.add(key)
        await standIns.deliveries.workstation.deliver(
          {
            id: item.id,
            title: item.title,
            summary: item.summary,
            view: d.view,
            decision_token: d.decision_token,
            actions: ['approve', 'approve_edited', 'reject'],
          },
          d.to,
        )
      }
    }
  }

  // ── 入站替身 ─────────────────────────────────────────────────────────
  const customerRefOf = (email: string): ObjectRef | undefined => {
    const c = pack.customerByEmail(email)
    return c === undefined ? undefined : { type: 'customer', id: c.id }
  }
  const inbound = new MemoryInboundPipeline({
    clock,
    workspace_id,
    resolver: {
      customer: (email) => customerRefOf(email),
      thread: (id) => ({ type: 'thread', id }),
      order: (text) => {
        const m = text.match(/#(\d{3,})/)
        return m?.[1] === undefined ? undefined : { type: 'order', id: `ord_${m[1]}` }
      },
      route: () => ({ role_id: primary.role_id, confidence: 0.9 }),
    },
  })

  // ── 工具执行器：读走 mock connect，`search_policies` 走知识检索 ────────
  const connectExec = connectToolExecutor(connect)
  const searchPolicies = async (
    text: string,
  ): Promise<{ hits: { id: string; statement: string; layer: string }[] }> => {
    const res = await knowledge.retrieval.search({
      text,
      // 19 §3 过滤下推：把本次 Assignment 的 scopes 原样传下去（不并集），
      // 无权数据域根本不进候选集
      actor: {
        person_id: assignment.person_id,
        assignment_id: assignment.id,
        role_id: assignment.role_id,
        workspace_id,
        grants: [...effective.scopes],
        ranges: [...effective.ranges],
      },
      k: 3,
    })
    return {
      hits: res.hits.map((h) => ({
        id: h.fact_card_id,
        statement: h.statement_redacted,
        layer: h.layer,
      })),
    }
  }
  holder.executeTool = async (call) => {
    if (call.name === 'search_policies' || call.name.endsWith('.search_policies')) {
      if (!call.request.tools.allow.includes('search_policies')) {
        return { status: 'blocked', reason: 'not_in_allowlist: search_policies' }
      }
      const query = typeof call.input.query === 'string' ? call.input.query : 'return window'
      const res = await searchPolicies(query)
      return {
        status: 'ok',
        data: res,
        provenance: res.hits.map((h) => ({ type: 'fact_card', id: h.id })),
      }
    }
    return connectExec(call)
  }

  const world: World = {
    clock,
    random,
    kernel,
    data,
    roles,
    knowledge,
    txn,
    standIns,
    connect,
    inbound,
    pack,
    workspace_id,
    assignment,
    effective,
    agentActor,
    role_id: primary.role_id,
    owner,
    roleHolder,
    events,
    notifications,
    blocked,
    outages,
    runContexts,
    gateway: () => gateway,
    setBudget(budget) {
      gateway = buildGateway(budget)
    },
    startOutage(ms) {
      const from = clock.nowMs()
      outageUntilMs = Math.max(outageUntilMs, from + ms)
      outages.push({ from_ms: from, to_ms: outageUntilMs })
    },
    modelDown: () => clock.nowMs() < outageUntilMs,
    appendRunEvent(req, e) {
      const { type, ...payload } = e
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type,
        actor: { kind: 'agent', id: req.actor.person_id, run_id: req.id },
        correlation: {
          trace_id: traceId(),
          run_id: req.id,
          ...(req.work_item === undefined ? {} : { work_item_id: req.work_item.id }),
        },
        payload,
      })
    },
    appendEvent(type, payload, o) {
      appendEnvelope({
        schema_version: 1,
        workspace_id,
        type,
        actor: o?.actor ?? { kind: 'system', id: 'simulation' },
        ...(o?.subject === undefined ? {} : { subject: o.subject }),
        correlation: {
          trace_id: traceId(),
          ...(o?.run_id === undefined ? {} : { run_id: o.run_id }),
          ...(o?.change_id === undefined ? {} : { change_id: o.change_id }),
          ...(o?.work_item_id === undefined ? {} : { work_item_id: o.work_item_id }),
        },
        payload,
      })
    },
    notify(n) {
      notifications.push(n)
      void standIns.deliveries.workstation.deliver(
        {
          id: `ntf_${notifications.length}`,
          title: n.title,
          summary: n.reason,
          view: 'full',
          decision_token: '',
          actions: [],
        },
        n.to,
      )
      world.appendEvent('notification.sent', {
        to: n.to,
        channel: n.channel,
        title: n.title,
        reason: n.reason,
      })
    },
    provenanceOf(ctx) {
      return provenanceFromEvents(ctx, now(clock))
    },
    customerRefOf,
    emailOfCustomer,
    async readCustomer(id) {
      return data.get<Record<string, unknown>>('customers', id, agentActor)
    },
    searchPolicies,
    mandateFor(action) {
      const found = effective.actions.find((a) => a.id === action)
      if (found === undefined) throw new SimulationError('not_found', `职责没有动作 ${action}`)
      return found.mandate
    },
    levelFor(action) {
      return effective.automation[action]?.level ?? 'L1'
    },
    issueReadToken: () => tokenFor('role-read'),
    issueApplyToken: () => tokenFor('role-apply'),
    async close() {
      knowledge.close()
      data.close()
      roles.close()
      await kernel.dispose()
    },
  }

  // ── stage / createDraft：stub 运行时的两个出口接到真实交易控制模块 ────
  holder.stage = async (intent: StageIntent) => {
    const ctx = runContexts.get(intent.request.id)
    if (ctx === undefined) return undefined
    const action = ACTION_BY_KIND[intent.kind]
    if (action === undefined) return undefined
    const order = orderOf(intent.target.id)
    if (order === undefined) return undefined
    const facts = recordFacts(intent.target)
    const money = intent.money
    const outcome = await txn.ledger.stage({
      workspace_id,
      role_id: primary.role_id,
      assignment_id: assignment.id,
      run_id: intent.request.id,
      change_set_id: ctx.change_set_id,
      kind: intent.kind,
      target: intent.target,
      before: facts.record,
      after: { refund_amount: money?.amount ?? 0, currency: money?.currency ?? 'USD' },
      ...(facts.record_version === undefined ? {} : { record_version: facts.record_version }),
      ...(money === undefined
        ? {}
        : {
            money: {
              amount: money.amount,
              currency: money.currency,
              amount_base: money.amount,
              base_currency: pack.workspace.base_currency,
              fx_rate: 1,
              fx_at: now(clock),
            },
          }),
      notes: intent.notes,
      created_by: { kind: 'agent', id: 'agent_aftersales' },
      mandate: world.mandateFor(action),
      level: world.levelFor(action),
      provenance: world.provenanceOf(ctx),
      // 15 §6.1：requester 是**来信人**，不是订单上记的邮箱——毒样本靠这一条被挡下
      requester: {
        channel: 'email',
        external_id: ctx.inbound.actor?.external_id ?? '',
        ...(ctx.requester === undefined ? {} : { resolved: ctx.requester.ref }),
      },
      ...(ctx.order?.owner === undefined ? {} : { target_owner: ctx.order.owner }),
      connection_id: 'conn_shopify_admin',
      approval: {
        title: `退款 ${money?.amount ?? 0} ${money?.currency ?? 'USD'}（订单 ${order.name}）`,
        summary: intent.notes.join('；'),
        recipients: [{ person: owner, via: 'scope_manager' }],
        proposer: { kind: 'agent', id: 'agent_aftersales', assignment_id: assignment.id },
        rule: 'scope_manager',
        separation_of_duties: true,
        source_events: [ctx.inbound.id],
      },
    })
    if (!outcome.ok) {
      blocked.push({
        rule: outcome.reason === 'authorization_check_failed' ? 'authorization_check' : 'guardrail',
        at: now(clock),
        run_id: intent.request.id,
        message: outcome.message,
      })
      return undefined
    }
    ctx.child_approval_ids.push(outcome.approval.id)
    await flushCards()
    return { change_id: outcome.change.id }
  }

  holder.createDraft = async (payload: DraftPayload) => {
    const ctx = runContexts.get(payload.request.id)
    if (ctx === undefined) return undefined
    const toEmail = payload.to[0]
    const to = toEmail === undefined ? undefined : customerRefOf(toEmail)
    if (to === undefined) return undefined
    const prov = world.provenanceOf(ctx)
    const seen: ObjectRef[] = []
    for (const [type, ids] of Object.entries(prov.seen))
      for (const id of ids) seen.push({ type, id })
    const item = await txn.approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'outbound_draft',
      role_id: primary.role_id,
      subject: {
        object: ctx.thread.ref,
        work_item_id: `wi_${ctx.run_id}`,
        conversation_id: ctx.thread.id,
      },
      dedupe_key: dedupeKey(workspace_id, 'outbound_draft', ctx.thread.ref, ctx.thread.id),
      title: `回复 ${toEmail}：${payload.subject}`,
      summary: payload.body.split('\n').filter((l) => l.trim().length > 0)[1] ?? payload.subject,
      payload: {
        channel: 'email',
        to,
        thread_ref: ctx.thread.id,
        body: { subject: payload.subject, text: payload.body },
        language: pack.workspace.locales.customers,
      },
      evidence: {
        run_id: ctx.run_id,
        source_events: [ctx.inbound.id],
        provenance: { seen },
        precheck: {},
        citations: payload.citations,
      },
      proposer: { kind: 'agent', id: 'agent_aftersales', assignment_id: assignment.id },
      automation: {
        level_at_creation: world.levelFor('reply_customer'),
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: roleHolder, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: {
          after_hours: 8,
          business_hours: true,
          chain: ['scope_manager', 'owner'],
          escalated_at: [],
        },
        separation_of_duties: true,
      },
      priority: 'queue',
      links: { children: [...ctx.child_approval_ids] },
      context: {
        thread_participants: [to.id],
        verified_contacts: [to.id],
        connection_id: 'conn_gmail',
      },
    })
    if (item.state === 'blocked') {
      for (const note of item.evidence.precheck.notes ?? ['precheck']) {
        blocked.push({ rule: 'precheck', at: now(clock), run_id: ctx.run_id, message: note })
      }
      return undefined
    }
    // 19 §3：草稿真的引用了哪几张卡，记进 usage（"高召回低认可"要靠它）
    for (const citation of payload.citations) {
      await knowledge.retrieval.cite(citation.fact_card_id, ctx.run_id)
    }
    // 子项回指父项（14 §12）；账本 stage 时父项还不存在，只能在这里补
    for (const child_id of ctx.child_approval_ids) {
      const child = txn.runtime.store.getApproval(child_id)
      if (child !== undefined) {
        txn.runtime.store.putApproval({ ...child, links: { ...child.links, parent: item.id } })
      }
    }
    await flushCards()
    return { approval_item_id: item.id }
  }

  return world
}

/** 15 §6：只证明"读过"——从 `context.injected`（配 RunRequest 的 source_ref）与 `tool.result` 推。 */
export function provenanceFromEvents(ctx: RunContext, at: Iso8601): ProvenanceState {
  const seen: Record<string, string[]> = {}
  const read_full: string[] = []
  const push = (ref: ObjectRef, full: boolean): void => {
    const list = seen[ref.type] ?? []
    if (!list.includes(ref.id)) list.push(ref.id)
    seen[ref.type] = list
    if (full && !read_full.includes(`${ref.type}:${ref.id}`))
      read_full.push(`${ref.type}:${ref.id}`)
  }
  const byId = new Map((ctx.request?.context ?? []).map((c) => [c.id, c]))
  for (const e of ctx.events) {
    if (e.type === 'context.injected') {
      const item = byId.get(e.item_id)
      const ref = item?.source_ref
      if (ref !== undefined && typeof ref !== 'string') push(ref, false)
    }
    if (e.type === 'tool.result' && e.status === 'ok') {
      for (const ref of e.provenance_added ?? []) push(ref, true)
    }
  }
  return { run_id: ctx.run_id, seen, read_full, recorded_at: at }
}
