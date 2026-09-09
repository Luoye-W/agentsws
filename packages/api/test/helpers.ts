/**
 * 网关测试替身：所有端口都是最小内存实现，时间与随机全部注入。
 * 目的是只测网关本身（信封 / 鉴权 / 幂等 / 急停 / 限流 / 事件续传），不测下游模块。
 */
import type {
  ApprovalBus,
  ApprovalItem,
  Assignment,
  DataDomain,
  ErrorCode,
  EventEnvelope,
  FactCard,
  GuardrailResult,
  Halt,
  HaltScope,
  KnowledgeSource,
  LessonRecord,
  ModuleHealth,
  Operation,
  Range,
  Sensitivity,
  StagedChange,
} from '@agentsws/contracts'
import type { OrderRow, QueryContext } from '@agentsws/deck'
import { defaultTilesFor, projectCard } from '@agentsws/deck'
import type {
  ChangesPort,
  EffectiveConfigLike,
  EventLogPort,
  GatewayDeps,
  GuardrailPort,
  KnowledgeGap,
  KnowledgePort,
  ModulesPort,
  PositionSummary,
  RolesPort,
  SkillsPort,
  WorkstationPort,
  WorkstationRange,
  WsOptions,
} from '../src/index.js'
import { createAsyncTraceScope, createGateway, createMemoryIdentity } from '../src/index.js'

export const T0 = '2026-09-07T09:00:00.000Z'

export function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance(ms: number) {
      t += ms
    },
  }
}

/** 确定性伪随机（不用裸 Math.random）。 */
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

export class FakeHalt implements Halt {
  #on = new Map<HaltScope, { on: boolean; reason?: string }>()
  constructor() {
    for (const s of ['all', 'model', 'outbound', 'learning'] as HaltScope[])
      this.#on.set(s, { on: false })
  }
  isHalted(scope: HaltScope): boolean {
    if (this.#on.get(scope)?.on === true) return true
    return scope !== 'all' && this.#on.get('all')?.on === true
  }
  set(scope: HaltScope, on: boolean, reason?: string): void {
    this.#on.set(scope, { on, ...(reason === undefined ? {} : { reason }) })
  }
  state(): Record<HaltScope, { on: boolean; reason?: string }> {
    return Object.fromEntries(this.#on) as Record<HaltScope, { on: boolean; reason?: string }>
  }
}

/** 单调递增、字典序可比的假 ulid。 */
export class FakeEventLog implements EventLogPort {
  readonly events: EventEnvelope[] = []
  #seq = 0

  append(e: Omit<EventEnvelope, 'id'>): EventEnvelope {
    this.#seq += 1
    const env: EventEnvelope = { ...e, id: `evt_${String(this.#seq).padStart(6, '0')}` }
    this.events.push(env)
    return env
  }

  read(filter: {
    workspace_id: string
    since?: string
    types?: string[]
    run_id?: string
    limit?: number
  }): AsyncIterable<EventEnvelope> {
    const rows = this.events
      .filter(
        (e) =>
          e.workspace_id === filter.workspace_id &&
          (filter.since === undefined || e.id > filter.since) &&
          (filter.types === undefined || filter.types.includes(e.type)) &&
          (filter.run_id === undefined || e.correlation.run_id === filter.run_id),
      )
      .slice(0, filter.limit ?? undefined)
    return {
      async *[Symbol.asyncIterator]() {
        for (const r of rows) yield r
      },
    }
  }
}

/** 28 §4 用例 2：未签名 → failed，requires 不满足 → pending，都在 /v1/health 可见。 */
export const MODULES: ModuleHealth[] = [
  { id: 'txn', state: 'active' },
  { id: 'evil-module', state: 'failed', detail: 'signature missing or publisher not allowed' },
  { id: 'ads', state: 'pending', missing: ['connector.ads@^1'] },
]

export class ThrowingPort {
  code: ErrorCode | undefined
  maybeThrow(): void {
    if (this.code !== undefined) {
      const err = Object.assign(new Error(`boom: ${this.code}`), { code: this.code })
      throw err
    }
  }
}

export interface Harness {
  gateway: ReturnType<typeof createGateway>
  deps: GatewayDeps
  clock: ReturnType<typeof makeClock>
  halt: FakeHalt
  eventLog: FakeEventLog
  identity: ReturnType<typeof createMemoryIdentity>
  approvals: MemoryApprovals
  thrower: ThrowingPort
  workstation: MemoryWorkstation
  knowledgeState: {
    sources: KnowledgeSource[]
    gaps: KnowledgeGap[]
    cites: { id: string; run_id: string }[]
  }
  workspace_id: string
  person_id: string
  other_id: string
  token: string
  otherToken: string
  assignment: Assignment
  weakAssignment: Assignment
  memberAssignment: Assignment
  item: ApprovalItem
  get(path: string, init?: RequestInit & { assignment?: string | null }): Promise<Response>
  post(
    path: string,
    body?: unknown,
    init?: RequestInit & { assignment?: string | null },
  ): Promise<Response>
  put(
    path: string,
    body?: unknown,
    init?: RequestInit & { assignment?: string | null },
  ): Promise<Response>
}

const ISO = (s: string): string => s

/** 只保留网关用得到的行为：队列、详情、决定、认领等都写进内存。 */
export class MemoryApprovals implements ApprovalBus {
  readonly items = new Map<string, ApprovalItem>()
  readonly log: string[] = []
  onDecide?: () => void

  seed(item: ApprovalItem): ApprovalItem {
    this.items.set(item.id, item)
    return item
  }
  #seq = 0
  /** 36 §2.1 指导落地要真建卡（skill_lesson / policy_change），所以这里给一个最小实现。 */
  async create<P>(input: Parameters<ApprovalBus['create']>[0]): Promise<ApprovalItem<P>> {
    const existing = [...this.items.values()].find((i) => i.dedupe_key === input.dedupe_key)
    if (existing !== undefined) return existing as ApprovalItem<P>
    this.#seq += 1
    const item = {
      ...input,
      id: `ap_new_${this.#seq}`,
      revision: 1,
      state: 'pending',
      deliveries: [],
      links: { children: [], ...(input.links ?? {}) },
      created_at: T0,
      updated_at: T0,
    } as unknown as ApprovalItem<P>
    this.items.set(item.id, item as ApprovalItem)
    this.log.push(`create:${item.id}:${item.kind}`)
    return item
  }
  async get(id: string): Promise<ApprovalItem | undefined> {
    return this.items.get(id)
  }
  async queue(filter: {
    workspace_id: string
    person_id: string
    lane: 'mine' | 'scope' | 'unclaimed'
  }): Promise<ApprovalItem[]> {
    return [...this.items.values()].filter(
      (i) =>
        i.workspace_id === filter.workspace_id &&
        i.routing.recipients.some((r) => r.person === filter.person_id),
    )
  }
  async decide(id: string, by: string, input: { decision_token: string }): Promise<ApprovalItem> {
    const item = this.items.get(id)
    if (!item) throw Object.assign(new Error('not found'), { code: 'not_found' })
    if (!item.deliveries.some((d) => d.decision_token === input.decision_token))
      throw Object.assign(new Error('bad token'), { code: 'forbidden' })
    this.log.push(`decide:${id}:${by}`)
    this.onDecide?.()
    item.state = 'approved'
    return item
  }
  async decideBatch(
    entries: { id: string; decision_token: string }[],
    by: string,
  ): Promise<{ id: string; item?: ApprovalItem; error?: unknown }[]> {
    const out: { id: string; item?: ApprovalItem; error?: unknown }[] = []
    for (const e of entries) {
      try {
        out.push({ id: e.id, item: await this.decide(e.id, by, e) })
      } catch (error) {
        out.push({ id: e.id, error })
      }
    }
    return out
  }
  async claim(id: string, by: string): Promise<ApprovalItem> {
    const item = this.items.get(id)
    if (!item) throw Object.assign(new Error('not found'), { code: 'not_found' })
    item.routing.assignee = by
    item.state = 'in_review'
    return item
  }
  async release(id: string): Promise<ApprovalItem> {
    const item = this.items.get(id)
    if (!item) throw Object.assign(new Error('not found'), { code: 'not_found' })
    delete item.routing.assignee
    item.state = 'pending'
    return item
  }
  async withdraw(id: string): Promise<ApprovalItem> {
    const item = this.items.get(id)
    if (!item) throw Object.assign(new Error('not found'), { code: 'not_found' })
    item.state = 'withdrawn'
    return item
  }
  async retryApply(id: string): Promise<ApprovalItem> {
    const item = this.items.get(id)
    if (!item) throw Object.assign(new Error('not found'), { code: 'not_found' })
    this.log.push(`retry:${id}`)
    return item
  }
  async escalate(): Promise<ApprovalItem[]> {
    return []
  }
  async expire(): Promise<ApprovalItem[]> {
    return []
  }
  async history(id: string): Promise<{ revisions: ApprovalItem[]; events: string[] }> {
    const item = this.items.get(id)
    return { revisions: item ? [item] : [], events: ['evt_000001'] }
  }
}

/** 36 工作台端口的内存实现：岗位 = Assignment，数从固定的几行订单与审批项里算。 */
export const WS_ORDERS: OrderRow[] = [
  {
    id: 'ord_a',
    name: '#1001',
    email: 'a@example.com',
    currency: 'USD',
    created_at: '2026-09-06T02:00:00.000Z',
    total_price: 129,
    refunded_amount: 0,
    financial_status: 'paid',
    fulfillment_status: 'delivered',
  },
  {
    id: 'ord_b',
    name: '#1002',
    email: 'b@example.com',
    currency: 'USD',
    created_at: '2026-09-05T02:00:00.000Z',
    total_price: 89,
    refunded_amount: 0,
    financial_status: 'paid',
    fulfillment_status: 'unfulfilled',
  },
]

export class MemoryWorkstation implements WorkstationPort {
  readonly tiles = new Map<string, string[]>()
  readonly ranges = new Map<string, WorkstationRange>()
  alertsOn = false

  constructor(
    private readonly deps: {
      workspace_id: string
      person_id: string
      assignment_id: string
      approvals: MemoryApprovals
      now: () => string
    },
  ) {}

  positions(): PositionSummary[] {
    const id = this.deps.assignment_id
    return [
      {
        position_id: id,
        role_id: 'dtc.aftersales',
        role_name: '独立站售后客服',
        ranges: [{ kind: 'store', id: 'store_1' }],
        ready: true,
        missing_connectors: [],
        tile_ids: this.tiles.get(id) ?? defaultTilesFor('dtc.aftersales'),
        range: this.ranges.get(id) ?? 'yesterday',
        show_tiles: true,
      },
    ]
  }

  items(): ApprovalItem[] {
    return [...this.deps.approvals.items.values()].filter(
      (i) => i.workspace_id === this.deps.workspace_id,
    )
  }

  queryContext(
    _actor: { workspace_id: string; person_id: string },
    position: PositionSummary,
    _range: WorkstationRange,
  ): QueryContext {
    return {
      now: this.deps.now(),
      tz_offset_minutes: 480,
      base_currency: 'USD',
      role_id: position.role_id,
      position_id: position.position_id,
      orders: WS_ORDERS,
      approvals: this.items(),
      sources: [
        { id: 'shop', label: '店铺后台', connected: true },
        { id: 'approvals', label: '工作队列', connected: true },
        { id: 'ga4', label: 'GA4', connected: false },
        { id: 'gsc', label: 'Search Console', connected: false },
        { id: 'ads', label: '广告后台', connected: false },
        { id: 'csat', label: '满意度调查', connected: false },
      ],
    }
  }

  systemCards(): {
    alerts: ReturnType<typeof projectCard>[]
    digest?: ReturnType<typeof projectCard>
  } {
    if (!this.alertsOn) return { alerts: [] }
    const base = approvalItem({ id: 'sys_1', workspace_id: this.deps.workspace_id })
    const card = projectCard(base, { now: this.deps.now(), position_id: this.deps.assignment_id })
    return {
      alerts: [{ ...card, kind: 'system_alert', title: '连接需要重新授权' }],
      digest: { ...card, id: 'digest_1', kind: 'digest', title: '昨天的摘要' },
    }
  }

  label(ref: { type: string; id: string }): string | undefined {
    return ref.id === 'cus_anna' ? 'Anna Meyer' : undefined
  }

  setHomeTiles(
    _actor: { workspace_id: string; person_id: string },
    input: { position_id: string; tile_ids: string[]; range?: WorkstationRange },
  ): PositionSummary {
    this.tiles.set(input.position_id, input.tile_ids)
    if (input.range !== undefined) this.ranges.set(input.position_id, input.range)
    const found = this.positions()[0]
    if (found === undefined) throw new Error('no position')
    return found
  }
}

export function approvalItem(over: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    id: 'ap_1',
    schema_version: 1,
    workspace_id: 'ws_test',
    kind: 'outbound_draft',
    revision: 1,
    role_id: 'dtc.aftersales',
    subject: { object: { type: 'thread', id: 'thr_1' } },
    dedupe_key: 'dk_1',
    title: '回复 Anna',
    summary: '退货窗口内',
    payload: { body: 'hi' },
    evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
    proposer: { kind: 'agent', id: 'agent_1' },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [
        { person: 'per_me', via: 'role_holder' },
        { person: 'per_other', via: 'scope_manager' },
      ],
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
    state: 'pending',
    deliveries: [
      {
        channel: 'workstation',
        to: 'per_me',
        sent_at: ISO(T0),
        view: 'full',
        decision_token: 'tok_me',
        status: 'sent',
      },
      {
        channel: 'feishu_card',
        to: 'per_other',
        sent_at: ISO(T0),
        view: 'redacted',
        decision_token: 'tok_other',
        status: 'sent',
      },
    ],
    links: { children: [] },
    created_at: ISO(T0),
    updated_at: ISO(T0),
    ...over,
  }
}

export function stagedChange(over: Partial<StagedChange> = {}): StagedChange {
  return {
    id: 'chg_1',
    schema_version: 1,
    workspace_id: 'ws_test',
    role_id: 'dtc.aftersales',
    assignment_id: 'asg_ok',
    run_id: 'run_1',
    change_set_id: 'cs_1',
    kind: 'refund',
    risk_class: 'medium',
    target: { type: 'order', id: 'ord_1' },
    before: { total: 89 },
    after: { refund_amount: 42 },
    guardrail: {
      verdict: 'allow',
      hits: [],
      effective_mandate_hash: 'h',
      evaluated_at: ISO(T0),
    },
    notes: [],
    created_by: { kind: 'agent', id: 'agent_1' },
    status: 'staged',
    expires_at: '2026-09-14T09:00:00.000Z',
    created_at: ISO(T0),
    updated_at: ISO(T0),
    ...over,
  }
}

const SCOPES = [
  {
    domain: 'approval' as DataDomain,
    ops: ['read', 'approve'] as Operation[],
    range: 'own' as Range,
    max_sensitivity: 'internal' as Sensitivity,
  },
  {
    domain: 'knowledge' as DataDomain,
    ops: ['read'] as Operation[],
    range: 'workspace' as Range,
    max_sensitivity: 'internal' as Sensitivity,
  },
  {
    domain: 'skill' as DataDomain,
    ops: ['read', 'stage'] as Operation[],
    range: 'workspace' as Range,
    max_sensitivity: 'internal' as Sensitivity,
  },
  {
    domain: 'event_log' as DataDomain,
    ops: ['read'] as Operation[],
    range: 'workspace' as Range,
    max_sensitivity: 'restricted' as Sensitivity,
  },
  {
    domain: 'policy' as DataDomain,
    ops: ['read', 'stage'] as Operation[],
    range: 'workspace' as Range,
    max_sensitivity: 'restricted' as Sensitivity,
  },
  // WP20 连接面：读连接清单走 store_config（05 common.owner 的那一条）
  {
    domain: 'store_config' as DataDomain,
    ops: ['read'] as Operation[],
    range: 'workspace' as Range,
    max_sensitivity: 'confidential' as Sensitivity,
  },
  // 工作台面板要读店铺侧的行；GA4 / Search Console 走 analytics 域
  {
    domain: 'order' as DataDomain,
    ops: ['read'] as Operation[],
    range: 'assigned' as Range,
    max_sensitivity: 'internal' as Sensitivity,
  },
  {
    domain: 'analytics' as DataDomain,
    ops: ['read'] as Operation[],
    range: 'assigned' as Range,
    max_sensitivity: 'internal' as Sensitivity,
  },
]

/** `packages/roles/roles/common/member.yml` 的那几条：事件日志只有 `own`。 */
const MEMBER_SCOPES = [
  {
    domain: 'approval' as DataDomain,
    ops: ['read', 'approve'] as Operation[],
    range: 'own' as Range,
    max_sensitivity: 'internal' as Sensitivity,
  },
  {
    domain: 'event_log' as DataDomain,
    ops: ['read'] as Operation[],
    range: 'own' as Range,
    max_sensitivity: 'internal' as Sensitivity,
  },
]

const RANK: Sensitivity[] = ['public', 'internal', 'confidential', 'restricted']
const COVERS: Record<Range, Range[]> = {
  workspace: ['workspace', 'assigned', 'own'],
  assigned: ['assigned', 'own'],
  own: ['own'],
}

export async function harness(
  options: {
    rateLimit?: { burst: number; per_second: number }
    exposeMagicLinkToken?: boolean
    /** 不装 19 §6 的那几个可选面，用来测「没装配 → 501」。 */
    bareKnowledge?: boolean
    ws?: WsOptions
  } = {},
): Promise<Harness> {
  const clock = makeClock()
  const random = seeded(7)
  const halt = new FakeHalt()
  const eventLog = new FakeEventLog()
  const identity = createMemoryIdentity({ clock: { now: () => clock.now() }, random })
  const approvals = new MemoryApprovals()
  const thrower = new ThrowingPort()

  const me = await identity.createPerson({ email: 'me@example.com', name: 'me' })
  const other = await identity.createPerson({ email: 'other@example.com', name: 'other' })
  const workspace = await identity.createWorkspace({ name: 'w', owner_id: me.id, kind: 'shared' })
  await identity.addMember({
    workspace_id: workspace.id,
    person_id: other.id,
    role: 'member',
    ranges: [],
  })
  const token = identity.issue('session', me.id, workspace.id).token
  const otherToken = identity.issue('api_key', other.id, workspace.id).token

  const assignment: Assignment = {
    id: 'asg_ok',
    person_id: me.id,
    workspace_id: workspace.id,
    role_id: 'dtc.aftersales',
    role_version: '1.0.0',
    ranges: [{ kind: 'store', id: 'store_1' }],
    automation_state: {},
    granted_by: me.id,
    granted_at: T0,
  }
  // 只有 approval.read 的弱 Assignment，用来测 403
  const weakAssignment: Assignment = { ...assignment, id: 'asg_weak' }
  /**
   * 照 `common.member` 那一档：approval.read/own + event_log.read/**own**（不是 workspace）。
   * WP33 的「事件日志按岗位可读」就靠它——它不再 403，但只看得到与本岗位相关的。
   */
  const memberAssignment: Assignment = { ...assignment, id: 'asg_member' }
  const revoked: Assignment = { ...assignment, id: 'asg_revoked', revoked_at: T0 }
  const foreign: Assignment = { ...assignment, id: 'asg_foreign', person_id: other.id }

  const assignments = new Map<string, Assignment>([
    [assignment.id, assignment],
    [weakAssignment.id, weakAssignment],
    [memberAssignment.id, memberAssignment],
    [revoked.id, revoked],
    [foreign.id, foreign],
  ])

  const roles: RolesPort = {
    can: (id, domain, op, request) => {
      const scopes =
        id === 'asg_weak' ? SCOPES.slice(0, 1) : id === 'asg_member' ? MEMBER_SCOPES : SCOPES
      return scopes.some(
        (s) =>
          s.domain === domain &&
          s.ops.includes(op) &&
          COVERS[s.range].includes(request.range) &&
          RANK.indexOf(request.sensitivity) <= RANK.indexOf(s.max_sensitivity),
      )
    },
    effectiveConfig: (id): EffectiveConfigLike => ({
      assignment_id: id,
      person_id: me.id,
      workspace_id: workspace.id,
      role_id: 'dtc.aftersales',
      scopes: SCOPES,
      ranges: assignments.get(id)?.ranges ?? [],
      ready: true,
      unassigned_range: false,
    }),
    getAssignment: (id) => assignments.get(id),
    listAssignments: (person_id) =>
      [...assignments.values()].filter((a) => a.person_id === person_id),
  }

  const ws = { workspace_id: workspace.id }
  const changes: ChangesPort = {
    get: async (id) => {
      thrower.maybeThrow()
      if (id === 'chg_1') return stagedChange(ws)
      // WP33：一条挂在 `asg_member` 名下的变更，用来测事件流的按岗位可见
      if (id === 'chg_member') return stagedChange({ ...ws, id, assignment_id: 'asg_member' })
      return undefined
    },
    list: async () => {
      thrower.maybeThrow()
      return [stagedChange(ws)]
    },
    withdraw: async () => stagedChange({ ...ws, status: 'withdrawn' }),
    reverse: async () => stagedChange({ ...ws, id: 'chg_2', reversal_of: 'chg_1' }),
  }

  const guardrailResult: GuardrailResult = {
    verdict: 'require_review',
    hits: [{ rule: 'max_auto_refund_amount', cap: 50, actual: 89, severity: 'review' }],
    effective_mandate_hash: 'h',
    evaluated_at: T0,
  }
  const guardrails: GuardrailPort = { evaluate: async () => guardrailResult }

  const card: FactCard = {
    id: 'fc_1',
    schema_version: 1,
    workspace_id: workspace.id,
    layer: 'fact',
    domain: 'knowledge',
    scope: [],
    sensitivity: 'internal',
    subject: { type: 'policy', key: 'return_window' },
    statement: '退货窗口 14 天',
    provenance: [],
    confidence: { value: 0.9, state: 'probable' },
    valid: {},
    usage: { recalled: 0, cited: 0, drafts_edited_after_cite: 0 },
    status: 'active',
    owner: me.id,
    created_by: { kind: 'person', id: me.id },
    created_at: T0,
    updated_at: T0,
  }
  const knowledge: KnowledgePort = {
    search: async (q) => ({
      hits: [
        {
          fact_card_id: card.id,
          score: 1,
          layer: 'fact',
          statement_redacted: card.statement,
          provenance_summary: '—',
          sensitivity: 'internal',
        },
      ],
      relevant: true,
      matched: [q.text],
      missing: [],
    }),
    cards: async () => [card],
    card: async (id) => (id === card.id ? card : undefined),
    health: async () => ({ total: 1, silent: 0, stale: 0, conflicts: 0 }),
  }
  // WP33：19 §6 剩下那几件事是 `KnowledgePort` 上的可选面。默认装上（用来测路由），
  // `harness({ bareKnowledge: true })` 则不装，用来测「没装配 → 501」。
  const knowledgeState = {
    sources: [] as KnowledgeSource[],
    gaps: [] as KnowledgeGap[],
    cites: [] as { id: string; run_id: string }[],
  }
  let knowledgeSeq = 0
  const knowledgeExtras: Partial<KnowledgePort> = {
    sources: () => [...knowledgeState.sources],
    addSource: (_actor, input) => {
      knowledgeSeq += 1
      const source: KnowledgeSource = {
        id: `src_${knowledgeSeq}`,
        workspace_id: workspace.id,
        kind: input.kind,
        ref: input.ref,
        parser: input.parser,
        acl_inherit: input.acl_inherit ?? true,
        chunks: 0,
      }
      knowledgeState.sources.push(source)
      return source
    },
    cite: (_actor, fact_card_id, run_id) => {
      knowledgeState.cites.push({ id: fact_card_id, run_id })
    },
    gaps: (_actor, filter) =>
      knowledgeState.gaps.filter((g) => filter.status === undefined || g.status === filter.status),
    openGap: (_actor, input) => {
      knowledgeSeq += 1
      const gap: KnowledgeGap = {
        id: `gap_${knowledgeSeq}`,
        workspace_id: workspace.id,
        question: input.question,
        subject: input.subject,
        domain: input.domain ?? 'company',
        status: 'open',
        asked_by: { kind: 'person', id: me.id },
        ...(input.run_id === undefined ? {} : { run_id: input.run_id }),
        created_at: clock.now(),
      }
      knowledgeState.gaps.push(gap)
      return gap
    },
    answerGap: (_actor, id, input) => {
      const gap = knowledgeState.gaps.find((g) => g.id === id)
      if (!gap) throw Object.assign(new Error('no gap'), { code: 'not_found' })
      gap.status = 'answered'
      gap.answer = input.answer
      gap.answered_by = me.id
      gap.answered_at = clock.now()
      gap.approval_item_id = 'ap_from_gap'
      return { gap, approval_item_id: gap.approval_item_id }
    },
  }
  if (options.bareKnowledge !== true) Object.assign(knowledge, knowledgeExtras)

  const lesson: LessonRecord = {
    id: 'les_1',
    run_id: 'run_1',
    assignment_id: assignment.id,
    workspace_id: workspace.id,
    skill: 'aftersales-reply',
    signal: 'edit_diff',
    strength: 'medium',
    text: '别用感叹号',
    confidence: 0.5,
    confirmations: 1,
    status: 'pooled',
    created_at: T0,
  }
  const skills: SkillsPort = {
    resolve: async (name) =>
      name === 'aftersales-reply' ? { name, markdown: '# 售后回复\n正文' } : undefined,
    setOverlay: async (o) => ({ skill: o.skill, version: o.version }),
    lessons: (filter) =>
      filter.status === undefined || filter.status === 'pooled' ? [lesson] : [],
  }

  const item = approvals.seed(
    approvalItem({
      workspace_id: workspace.id,
      routing: {
        recipients: [
          { person: me.id, via: 'role_holder' },
          { person: other.id, via: 'scope_manager' },
        ],
        rule: 'role_holder',
        escalation: {
          after_hours: 24,
          business_hours: true,
          chain: ['scope_manager', 'owner'],
          escalated_at: [],
        },
        separation_of_duties: true,
      },
      deliveries: [
        {
          channel: 'workstation',
          to: me.id,
          sent_at: T0,
          view: 'full',
          decision_token: 'tok_me',
          status: 'sent',
        },
        {
          channel: 'feishu_card',
          to: other.id,
          sent_at: T0,
          view: 'redacted',
          decision_token: 'tok_other',
          status: 'sent',
        },
      ],
    }),
  )

  const modules: ModulesPort = { health: () => MODULES }
  const traceScope = createAsyncTraceScope()
  const workstation = new MemoryWorkstation({
    workspace_id: workspace.id,
    person_id: me.id,
    assignment_id: assignment.id,
    approvals,
    now: () => clock.now(),
  })

  const deps: GatewayDeps = {
    identity,
    halt,
    trace: {
      newTraceId: () => `tr_${Math.floor(random() * 1e9).toString(36)}`,
      child: (p) => `${p}.1`,
    },
    clock: { now: () => clock.now() },
    eventLog,
    modules,
    approvals,
    changes,
    guardrails,
    knowledge,
    skills,
    roles,
    workstation,
    traceScope,
    sleep: async () => {
      clock.advance(10)
    },
    options: {
      version: '9.9.9',
      events: { pollIntervalMs: 5 },
      ...(options.ws === undefined ? {} : { ws: options.ws }),
      ...(options.rateLimit ? { rateLimit: { default: options.rateLimit } } : {}),
      ...(options.exposeMagicLinkToken === undefined
        ? {}
        : { exposeMagicLinkToken: options.exposeMagicLinkToken }),
    },
  }

  // 决定时写一条事件，用来验证 trace_id 从请求贯到事件日志（28 §4 用例 6）
  approvals.onDecide = () => {
    eventLog.append({
      schema_version: 1,
      workspace_id: workspace.id,
      type: 'approval.decided',
      at: clock.now(),
      actor: { kind: 'person', id: me.id },
      correlation: { trace_id: traceScope.current() ?? 'no-trace' },
      payload: {},
    })
  }

  const gateway = createGateway(deps)
  const base = 'http://127.0.0.1'

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    init: RequestInit & { assignment?: string | null } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers)
    if (!headers.has('Authorization') && init.assignment !== null)
      headers.set('Authorization', `Bearer ${token}`)
    if (init.assignment !== null && !headers.has('X-Assignment'))
      headers.set('X-Assignment', init.assignment ?? assignment.id)
    if (body !== undefined) headers.set('content-type', 'application/json')
    return gateway.fetch(
      new Request(`${base}${path}`, {
        ...init,
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }

  return {
    gateway,
    deps,
    clock,
    halt,
    eventLog,
    identity,
    approvals,
    thrower,
    workstation,
    knowledgeState,
    workspace_id: workspace.id,
    person_id: me.id,
    other_id: other.id,
    token,
    otherToken,
    assignment,
    weakAssignment,
    memberAssignment,
    item,
    get: (path, init) => call('GET', path, undefined, init),
    post: (path, body, init) => call('POST', path, body, init),
    put: (path, body, init) => call('PUT', path, body, init),
  }
}
