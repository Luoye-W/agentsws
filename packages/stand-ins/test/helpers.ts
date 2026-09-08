import type {
  ApprovalBus,
  ApprovalItem,
  ApprovalKind,
  ContextItem,
  DecideInput,
  Decision,
  GroundingRule,
  PersonId,
  RunEvent,
  RunRequest,
  RuntimeAdapter,
} from '@agentsws/contracts'
import type { MockOrder, StandIns } from '../src/index.js'

export const WORKSPACE = 'ws_stand_in'

/** 取合成数据集里的某张订单（`noUncheckedIndexedAccess` 下别在测试里到处写断言）。 */
export function orderOf(s: StandIns, id: string): MockOrder {
  const order = s.connect.state.orders.find((o) => o.id === id)
  if (!order) throw new Error(`合成数据集里没有订单 ${id}`)
  return order
}

/** 签一张 role-read token（默认只允许 get_order）。 */
export async function readToken(
  s: StandIns,
  allowed_actions: string[] = ['shopify_admin.get_order'],
): Promise<string> {
  const t = await s.connect.issueToken({
    assignment_id: 'asg_1',
    kind: 'role-read',
    allowed_actions,
    allowed_connections: ['conn_shopify_admin'],
  })
  return t.token
}

export interface RequestOverrides {
  id?: string
  kind?: RunRequest['kind']
  order?: MockOrder
  threadBody?: string
  threadSubject?: string
  policyText?: string
  allow?: string[]
  connect_token?: string
  maxToolCalls?: number
  maxTokens?: number
  grounding?: GroundingRule[]
  outputs?: RunRequest['expectations']['outputs']
  mustStage?: boolean
  sidePolicy?: 'personal' | 'executor'
  seed?: number
  extraContext?: ContextItem[]
  idempotency_key?: string
}

const GROUNDING: GroundingRule[] = [
  {
    name: 'order_lookup',
    intent_terms: ['refund', 'return', '退款'],
    cue_terms: ['#'],
    tool: 'get_order',
    prefetch: false,
  },
]

/** 17 §1 的一条完整 RunRequest；默认就是 26 §1「退货窗口内」那条场景的形状。 */
export function makeRequest(o: RequestOverrides = {}): RunRequest {
  const context: ContextItem[] = [
    {
      id: 'ctx_policy',
      kind: 'policy',
      source_ref: 'policy://aftersales/returns',
      sensitivity: 'internal',
      content: {
        title: 'Returns',
        body: o.policyText ?? 'Customers may return items within 14 days of delivery.',
      },
      bytes: 120,
    },
    {
      id: 'ctx_thread',
      kind: 'thread',
      source_ref: { type: 'thread', id: 'thr_1' },
      sensitivity: 'confidential',
      content: {
        subject: o.threadSubject ?? 'Return request for #1001',
        body:
          o.threadBody ?? 'Hi, I would like a refund for order #1001, the charger is too bulky.',
        participants: ['anna@example.com', 'support@example.com'],
      },
      bytes: 240,
    },
  ]
  if (o.order) {
    context.push({
      id: 'ctx_order',
      kind: 'order',
      source_ref: { type: 'order', id: o.order.id },
      sensitivity: 'internal',
      content: o.order,
      bytes: 512,
    })
  }
  context.push(...(o.extraContext ?? []))

  return {
    id: o.id ?? 'run_1',
    schema_version: 1,
    workspace_id: WORKSPACE,
    kind: o.kind ?? 'work_item',
    actor: { person_id: 'p_wang', assignment_id: 'asg_1', role_id: 'dtc.aftersales' },
    work_item: { id: 'wi_1', conversation_id: 'conv_1', role_id: 'dtc.aftersales' },
    trigger: { event_id: 'evt_1', source: 'inbound' },
    context,
    grounding: o.grounding ?? GROUNDING,
    tools: {
      allow: o.allow ?? ['get_order'],
      connect_token: o.connect_token ?? 'tok_missing',
      side_effect_policy: o.sidePolicy ?? 'executor',
    },
    skills: [{ name: 'aftersales.reply', tier: 'open', load: 'always' }],
    persona: {
      sections: [
        { id: 'company', name: 'Company', order: 1, text: '3-person DTC accessories brand.' },
        { id: 'role', name: 'Aftersales', order: 2, text: 'Reply in English, cite policy.' },
      ],
    },
    budget: {
      max_tokens: o.maxTokens ?? 20_000,
      max_tool_calls: o.maxToolCalls ?? 8,
      max_seconds: 60,
      max_cost_base: 1,
    },
    expectations: {
      outputs: o.outputs ?? ['draft', 'staged_change'],
      must_stage_if_change_requested: o.mustStage ?? false,
    },
    runtime: {
      preset: 'aftersales',
      profile: 'stand-in',
      plugins: [],
      model: { provider: 'stub', model: 'stub-v1', region: 'cn' },
      ...(o.seed === undefined ? {} : { seed: o.seed }),
    },
    idempotency_key: o.idempotency_key ?? 'idem_run_1',
  }
}

/** 跑一次运行时并收集事件。 */
export async function runAndCollect(
  adapter: RuntimeAdapter,
  req: RunRequest,
  signal = new AbortController().signal,
): Promise<{ events: RunEvent[]; result: Awaited<ReturnType<RuntimeAdapter['run']>> }> {
  const events: RunEvent[] = []
  const result = await adapter.run(req, (e) => events.push(e), signal)
  return { events, result }
}

// ---------- 最小审批总线（只为驱动合成人；真实实现在 @agentsws/txn） ----------

export interface PushItemInput {
  id: string
  kind?: ApprovalKind
  title?: string
  summary?: string
  payload: unknown
  to: PersonId
}

export class FakeApprovalBus implements ApprovalBus {
  readonly items: ApprovalItem[] = []
  private seq = 0

  constructor(private readonly now: () => string) {}

  push(input: PushItemInput): ApprovalItem {
    this.seq += 1
    const token = `dtok_${this.seq}`
    const item: ApprovalItem = {
      id: input.id,
      schema_version: 1,
      workspace_id: WORKSPACE,
      kind: input.kind ?? 'outbound_draft',
      revision: 1,
      role_id: 'dtc.aftersales',
      subject: { object: { type: 'thread', id: 'thr_1' } },
      dedupe_key: `dk_${input.id}`,
      title: input.title ?? `草稿 ${input.id}`,
      summary: input.summary ?? '回信草稿',
      payload: input.payload,
      evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
      proposer: { kind: 'agent', id: 'stub', assignment_id: 'asg_1' },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: input.to, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: {
          after_hours: 24,
          business_hours: true,
          chain: ['scope_manager'],
          escalated_at: [],
        },
        separation_of_duties: false,
      },
      priority: 'queue',
      state: 'pending',
      deliveries: [
        {
          channel: 'workstation',
          to: input.to,
          sent_at: this.now(),
          view: 'full',
          decision_token: token,
          status: 'sent',
        },
      ],
      links: { children: [] },
      created_at: this.now(),
      updated_at: this.now(),
    }
    this.items.push(item)
    return item
  }

  async create<P>(): Promise<ApprovalItem<P>> {
    throw new Error('FakeApprovalBus.create 未实现（测试用 push）')
  }

  async get(id: string): Promise<ApprovalItem | undefined> {
    return this.items.find((i) => i.id === id)
  }

  async queue(filter: { workspace_id: string; person_id: PersonId }): Promise<ApprovalItem[]> {
    return this.items.filter(
      (i) =>
        i.workspace_id === filter.workspace_id &&
        i.routing.recipients.some((r) => r.person === filter.person_id),
    )
  }

  async decide(id: string, by: PersonId, input: DecideInput): Promise<ApprovalItem> {
    const item = this.items.find((i) => i.id === id)
    if (!item) throw new Error(`no item ${id}`)
    const delivery = item.deliveries.find(
      (d) => d.decision_token === input.decision_token && d.to === by,
    )
    if (!delivery) throw new Error('decision_token 无效')
    if (delivery.status === 'acted') throw new Error('decision_token 已用')
    delivery.status = 'acted'
    const decision: Decision = {
      action: input.action,
      by,
      at: this.now(),
      via: input.via,
      decision_token: input.decision_token,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.edited_payload === undefined ? {} : { edited_payload: input.edited_payload }),
    }
    item.decision = decision
    item.state =
      input.action === 'approve'
        ? 'approved'
        : input.action === 'approve_edited'
          ? 'approved_edited'
          : input.action === 'reject'
            ? 'rejected'
            : 'deferred'
    item.updated_at = this.now()
    return item
  }

  async claim(): Promise<ApprovalItem> {
    throw new Error('未实现')
  }
  async release(): Promise<ApprovalItem> {
    throw new Error('未实现')
  }
  async withdraw(): Promise<ApprovalItem> {
    throw new Error('未实现')
  }
  async retryApply(): Promise<ApprovalItem> {
    throw new Error('未实现')
  }
  async decideBatch(): Promise<{ id: string; item?: ApprovalItem; error?: unknown }[]> {
    throw new Error('未实现')
  }
  async escalate(): Promise<ApprovalItem[]> {
    return []
  }
  async expire(): Promise<ApprovalItem[]> {
    return []
  }
  async history(): Promise<{ revisions: ApprovalItem[]; events: string[] }> {
    return { revisions: [], events: [] }
  }
}
