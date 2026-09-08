import type {
  Clock,
  Completion,
  ContextItem,
  Iso8601,
  ObjectRef,
  RunEvent,
  RunRequest,
} from '@agentsws/contracts'
import { EXTERNAL_FENCE } from '@agentsws/core'
import type { CreateDraftFn, DraftPayload, StageFn, StageIntent } from '@agentsws/stand-ins'
import type { DshRuntimeOptions, ModelGatewayLike } from '../src/index.js'

export const NOW: Iso8601 = '2026-09-07T09:00:00.000Z'
export const DELIVERED: Iso8601 = '2026-09-01T09:00:00.000Z'

export class FixedClock implements Clock {
  constructor(private at: Iso8601 = NOW) {}
  now(): Iso8601 {
    return this.at
  }
  set(at: Iso8601): void {
    this.at = at
  }
}

const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8')

function item(
  id: string,
  kind: ContextItem['kind'],
  content: unknown,
  source_ref: ObjectRef | string,
): ContextItem {
  return { id, kind, source_ref, sensitivity: 'internal', content, bytes: bytesOf(content) }
}

export const ORDER = {
  id: 'ord_1001',
  name: '#1001',
  email: 'anna@example.com',
  currency: 'USD',
  total_price: 120,
  refunded_amount: 0,
  financial_status: 'paid',
  fulfillment_status: 'fulfilled',
  delivered_at: DELIVERED,
  shipping_address: { name: 'Anna' },
}

export interface RequestOverrides {
  allow?: string[]
  side_effect_policy?: 'personal' | 'executor'
  max_tool_calls?: number
  max_tokens?: number
  id?: string
  withOrderContext?: boolean
  threadText?: string
}

/** 一条最小但完整的"退货窗口内"RunRequest。 */
export function makeRequest(o: RequestOverrides = {}): RunRequest {
  const threadText = EXTERNAL_FENCE.fencePayload(
    o.threadText ?? 'Hi, I want to return order #1001 and get a refund please.',
  )
  const context: ContextItem[] = [
    item(
      'policy_workspace',
      'policy',
      { constraints: ['every change must be staged'], return_window_days: 14 },
      'workspace_policy:ws_test',
    ),
    item('fc_return', 'fact_card', 'Returns are accepted within 14 days of delivery.', {
      type: 'fact_card',
      id: 'fc_return',
    }),
  ]
  if (o.withOrderContext !== false) {
    context.push(item('order_1001', 'order', ORDER, { type: 'order', id: 'ord_1001' }))
  }
  context.push(
    item(
      'thr_1',
      'thread',
      { subject: 'Return request for #1001', participants: ['anna@example.com'], text: threadText },
      { type: 'thread', id: 'thr_1' },
    ),
  )
  return {
    id: o.id ?? 'run_0001',
    schema_version: 1,
    workspace_id: 'ws_test',
    kind: 'work_item',
    actor: { person_id: 'p_agent', assignment_id: 'asg_1', role_id: 'dtc.aftersales' },
    work_item: { id: 'wi_1', conversation_id: 'thr_1', role_id: 'dtc.aftersales' },
    trigger: { event_id: 'evt_1', source: 'inbound' },
    context,
    grounding: [
      {
        name: 'order_status',
        intent_terms: ['order'],
        cue_terms: ['return'],
        tool: 'get_order',
        prefetch: true,
      },
      {
        name: 'policy',
        intent_terms: ['return', 'refund'],
        cue_terms: ['can'],
        tool: 'search_policies',
        prefetch: true,
      },
    ],
    tools: {
      allow: o.allow ?? ['get_order', 'list_orders', 'search_policies'],
      connect_token: 'tok_test',
      side_effect_policy: o.side_effect_policy ?? 'executor',
    },
    skills: [{ name: 'customer-care', tier: 'open', load: 'always' }],
    persona: {
      sections: [
        { id: 'company', name: 'company', order: 10, text: 'Test shop.' },
        { id: 'role', name: '售后', order: 20, text: '你是售后。' },
      ],
    },
    budget: {
      max_tokens: o.max_tokens ?? 60_000,
      max_tool_calls: o.max_tool_calls ?? 8,
      max_seconds: 120,
      max_cost_base: 5,
    },
    expectations: { outputs: ['draft', 'staged_change'], must_stage_if_change_requested: true },
    runtime: {
      preset: 'dtc.aftersales',
      profile: 'agentsws-executor',
      plugins: [],
      model: { provider: 'stub', model: 'stub-v1', region: 'cn' },
      seed: 42,
    },
    idempotency_key: 'idem_test',
  }
}

/** 固定补全的假网关（真实模拟里是 model-gateway 的 stub provider）。 */
export function fakeGateway(text = 'stub reply'): ModelGatewayLike & { calls: number } {
  const g = {
    calls: 0,
    async complete(): Promise<Completion> {
      g.calls += 1
      return {
        text,
        usage: { input_tokens: 100, output_tokens: 20, cached_tokens: 0, cost_base: 0.1 },
        model: { provider: 'stub', model: 'stub-v1' },
        static_prefix_hash: 'prefix',
      }
    },
  }
  return g
}

export interface Recorder {
  staged: StageIntent[]
  drafts: DraftPayload[]
  stage: StageFn
  createDraft: CreateDraftFn
}

export function recorder(options?: { rejectStage?: boolean; rejectDraft?: boolean }): Recorder {
  const staged: StageIntent[] = []
  const drafts: DraftPayload[] = []
  return {
    staged,
    drafts,
    stage: async (intent) => {
      staged.push(intent)
      if (options?.rejectStage === true) return undefined
      return { change_id: `chg_${staged.length}` }
    },
    createDraft: async (payload) => {
      drafts.push(payload)
      if (options?.rejectDraft === true) return undefined
      return { approval_item_id: `appr_${drafts.length}` }
    },
  }
}

/** 默认的只读工具出口：返回订单 / 政策命中。 */
export function toolExecutor(): DshRuntimeOptions['executeTool'] {
  return async ({ name, request }) => {
    if (!request.tools.allow.includes(name)) {
      return { status: 'blocked', reason: `not_in_allowlist: ${name}` }
    }
    if (name === 'get_order') {
      return { status: 'ok', data: ORDER }
    }
    if (name === 'search_policies') {
      return {
        status: 'ok',
        data: {
          hits: [{ id: 'fc_return', statement: 'returns within 14 days', layer: 'company' }],
        },
        provenance: [{ type: 'fact_card', id: 'fc_return' }],
      }
    }
    return { status: 'error', reason: `unknown tool ${name}` }
  }
}

export function baseOptions(over: Partial<DshRuntimeOptions> = {}): DshRuntimeOptions {
  const rec = recorder()
  return {
    clock: new FixedClock(),
    gateway: fakeGateway(),
    seed: 42,
    executeTool: toolExecutor(),
    stage: rec.stage,
    createDraft: rec.createDraft,
    ...over,
  }
}

export function collect(): { sink: (e: RunEvent) => void; events: RunEvent[] } {
  const events: RunEvent[] = []
  return { events, sink: (e) => events.push(e) }
}

export const typesOf = (events: RunEvent[]): string[] => events.map((e) => e.type)
