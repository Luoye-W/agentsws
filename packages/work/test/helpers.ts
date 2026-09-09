import type {
  ApprovalItem,
  Clock,
  DailyPlan,
  Goal,
  Matter,
  MatterEvent,
  Review,
  Todo,
} from '@agentsws/contracts'

export const T0 = '2026-09-09T01:00:00.000Z'

/** 合成时钟：时间只经它前进，测试里没有一处 `Date.now()`。 */
export class FakeClock implements Clock {
  private at: number
  constructor(start: string = T0) {
    this.at = Date.parse(start)
  }
  now(): string {
    return new Date(this.at).toISOString()
  }
  advance(ms: number): void {
    this.at += ms
  }
  set(iso: string): void {
    this.at = Date.parse(iso)
  }
}

/** 固定序列的随机（id 生成用）。 */
export function seeded(seed = 42): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

export function matter(over: Partial<Matter> = {}): Matter {
  return {
    id: 'mat_1',
    schema_version: 1,
    workspace_id: 'ws_1',
    kind: 'conversation',
    title: 'Anna 的退货请求',
    status: 'open',
    context: {
      summary: '客户要退 #1001，还在窗口内',
      pinned: [{ type: 'order', id: 'ord_1001' }],
      participants: ['per_1'],
      last_activity: T0,
    },
    created_at: T0,
    updated_at: T0,
    ...over,
  }
}

export function matterEvent(over: Partial<MatterEvent> = {}): MatterEvent {
  return {
    id: 'mev_1',
    matter_id: 'mat_1',
    at: T0,
    kind: 'human_message',
    text: '先看一下这单',
    actor: { kind: 'person', id: 'per_1' },
    ...over,
  }
}

export function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: 'goal_1',
    schema_version: 1,
    workspace_id: 'ws_1',
    level: 'company',
    owner: 'per_1',
    title: '本月销售额 10 万',
    metric: { query: 'sales.total', format: 'money' },
    target: 100000,
    period: { kind: 'month', start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
    status: 'active',
    created_at: T0,
    updated_at: T0,
    ...over,
  }
}

export function todo(over: Partial<Todo> = {}): Todo {
  return {
    id: 'td_1',
    schema_version: 1,
    workspace_id: 'ws_1',
    title: '把新品页上线',
    owner: 'per_1',
    horizon: 'backlog',
    source: 'manual',
    status: 'open',
    cards: [],
    runs: [],
    created_at: T0,
    updated_at: T0,
    ...over,
  }
}

export function plan(over: Partial<DailyPlan> = {}): DailyPlan {
  return {
    id: 'plan_1',
    schema_version: 1,
    workspace_id: 'ws_1',
    person_id: 'per_1',
    date: '2026-09-09',
    basis: { goals: [], meetings: 0, due_todos: 0, cards_waiting: 0 },
    suggestions: [],
    options: [
      { id: 'adopt', label: '就按这个来' },
      { id: 'adjust', label: '我改几条' },
      { id: 'later', label: '稍后再说' },
    ],
    state: 'drafted',
    created_todo_ids: [],
    created_at: T0,
    updated_at: T0,
    ...over,
  }
}

export function review(over: Partial<Review> = {}): Review {
  return {
    id: 'rev_1',
    schema_version: 1,
    workspace_id: 'ws_1',
    person_id: 'per_1',
    period: { kind: 'day', start: T0, end: T0 },
    goals: [],
    cards: { ai_handled: 0, you_handled: 0, auto_sent: 0, blocked: 0 },
    todos: { done: 0, total: 0, completion_pct: 100 },
    meetings: { count: 0, outputs: 0 },
    lessons: [],
    highlights: [],
    next_plan_draft: {
      date: '2026-09-10',
      person_id: 'per_1',
      basis: { goals: [], meetings: 0, due_todos: 0, cards_waiting: 0 },
      suggestions: [],
      options: [{ id: 'adopt', label: '就按这个来' }],
    },
    created_at: T0,
    ...over,
  }
}

export function approval(over: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    id: 'apr_1',
    schema_version: 1,
    workspace_id: 'ws_1',
    kind: 'outbound_draft',
    revision: 1,
    role_id: 'dtc.aftersales',
    subject: { object: { type: 'thread', id: 'thr_1' } },
    dedupe_key: 'dk_1',
    title: '给 Anna 的回复草稿',
    summary: '窗口内，按流程给退货标签',
    payload: {},
    evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
    proposer: { kind: 'agent', id: 'agent_1' },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: 'per_1', via: 'role_holder' }],
      rule: 'role_holder',
      escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
      separation_of_duties: true,
    },
    priority: 'queue',
    state: 'pending',
    deliveries: [],
    links: { children: [] },
    created_at: T0,
    updated_at: T0,
    ...over,
  }
}
