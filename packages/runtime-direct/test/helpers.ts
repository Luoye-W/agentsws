import type {
  ContextItem,
  ModelRef,
  RunEvent,
  RunRequest,
  RuntimeAdapter,
} from '@agentsws/contracts'
import { canonicalJson, EXTERNAL_FENCE } from '@agentsws/core'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import { createModelGateway, ProviderError } from '@agentsws/model-gateway'
import type { DraftPayload, StageIntent, ToolExecution } from '@agentsws/stand-ins'
import { SyntheticClock } from '@agentsws/stand-ins'
import type { DirectRuntimeOptions, ScriptedTurn, ScriptFn } from '../src/index.js'
import { createDirectRuntime, scriptedProvider, withToolChoice } from '../src/index.js'

export const START = '2026-09-07T09:00:00.000Z'
export const MODEL: ModelRef = { provider: 'stub', model: 'scripted-v1', region: 'cn' }

export const ORDER = {
  id: 'ord_1001',
  name: '#1001',
  email: 'anna@example.com',
  currency: 'USD',
  total_price: 129,
  refunded_amount: 0,
  financial_status: 'paid',
  fulfillment_status: 'delivered',
  delivered_at: '2026-09-04T01:00:00.000Z',
  shipping_address: { name: 'Anna Meyer' },
  record_version: 'v1',
  line_items: [{ id: 'li_1', title: 'USB-C 65W Charger', price: 129, quantity: 1 }],
}

export function clock(start: string = START): SyntheticClock {
  return new SyntheticClock(start)
}

const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8')

/**
 * 注入模型的内容一律先规范化（键排序），与协同服务的装配（simulation/context.ts）一致：
 * 事件日志按规范化 JSON 存 payload，不钉成规范形，回放就重组不出同一个 prompt。
 */
function canonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T
}

export function contextItem(
  over: Partial<ContextItem> & Pick<ContextItem, 'id' | 'kind'>,
): ContextItem {
  const content = canonical(over.content ?? {})
  return {
    source_ref: `src:${over.id}`,
    sensitivity: 'internal',
    bytes: bytesOf(content),
    ...over,
    content,
  }
}

export const THREAD_TEXT = EXTERNAL_FENCE.fencePayload(
  'Hi, the charger arrived last week but it does not fit. I would like to return it and get a refund. Order #1001.',
)

/** 一份典型的售后 RunRequest（17 §1）：策略层 + 事实卡 + 客户 + 线程。 */
export function makeRequest(over: Partial<RunRequest> = {}): RunRequest {
  const context: ContextItem[] = over.context ?? [
    contextItem({
      id: 'policy_workspace',
      kind: 'policy',
      content: { constraints: ['every change must be staged and approved'] },
    }),
    contextItem({
      id: 'fact_return_window',
      kind: 'fact_card',
      source_ref: { type: 'fact_card', id: 'fact_return_window' },
      content: 'Returns are accepted within 14 days of delivery.',
    }),
    contextItem({
      id: 'customer_cus_anna',
      kind: 'customer',
      source_ref: { type: 'customer', id: 'cus_anna' },
      content: { id: 'cus_anna', email: 'anna@example.com', name: 'Anna Meyer' },
    }),
    contextItem({
      id: 'thr_1',
      kind: 'thread',
      source_ref: { type: 'thread', id: 'thr_1' },
      content: { subject: 'Return request for #1001', text: THREAD_TEXT },
    }),
  ]
  return {
    id: 'run_test_1',
    schema_version: 1,
    workspace_id: 'ws_test',
    kind: 'work_item',
    actor: { person_id: 'p_agent', assignment_id: 'asg_1', role_id: 'dtc.aftersales' },
    work_item: { id: 'wi_1', conversation_id: 'thr_1', role_id: 'dtc.aftersales' },
    trigger: { event_id: 'in_1', source: 'inbound' },
    grounding: [
      {
        name: 'order_status',
        intent_terms: ['order', '订单'],
        cue_terms: ['arrived', 'where'],
        tool: 'get_order',
        prefetch: true,
      },
    ],
    tools: {
      allow: ['get_order', 'list_orders', 'search_policies'],
      connect_token: 'tok_role_read',
      side_effect_policy: 'personal',
    },
    skills: [{ name: 'customer-care', tier: 'open', load: 'always' }],
    persona: {
      sections: [
        { id: 'company', name: 'company', order: 10, text: 'We sell chargers.' },
        { id: 'role', name: 'aftersales', order: 20, text: 'You answer return questions.' },
      ],
    },
    budget: { max_tokens: 60_000, max_tool_calls: 8, max_seconds: 120, max_cost_base: 5 },
    expectations: {
      outputs: ['draft', 'staged_change'],
      must_stage_if_change_requested: true,
    },
    runtime: {
      preset: 'dtc.aftersales',
      profile: 'test',
      plugins: [],
      model: MODEL,
      seed: 42,
    },
    idempotency_key: 'idem_test_1',
    ...over,
    context,
  }
}

export function gatewayOf(
  script: readonly ScriptedTurn[] | ScriptFn,
  c: SyntheticClock,
): ModelGatewayApi {
  return createModelGateway({
    providers: [scriptedProvider({ script, ref: MODEL, seed: 7 })],
    policy: {
      default: MODEL,
      data_residency: 'cn',
      prices: { 'stub/scripted-v1': { in: 1, out: 2, cached: 0.1 } },
    },
    clock: c,
    env: {},
    eventSink: () => {},
  })
}

/** 一个总是挂掉的网关（22 的 provider_unavailable 那一路）。 */
export function downGateway(c: SyntheticClock): ModelGatewayApi {
  return createModelGateway({
    providers: [
      {
        ref: MODEL,
        async complete() {
          throw new ProviderError('注入的模型故障', { status: 503 })
        },
      },
    ],
    policy: {
      default: MODEL,
      data_residency: 'cn',
      prices: { 'stub/scripted-v1': { in: 1, out: 2, cached: 0.1 } },
    },
    clock: c,
    env: {},
    eventSink: () => {},
  })
}

export interface Harness {
  runtime: RuntimeAdapter
  events: RunEvent[]
  staged: StageIntent[]
  drafts: DraftPayload[]
  toolCalls: { name: string; input: Record<string, unknown> }[]
  clock: SyntheticClock
  run(req?: RunRequest, signal?: AbortSignal): Promise<Awaited<ReturnType<RuntimeAdapter['run']>>>
}

export interface HarnessOptions extends Partial<Omit<DirectRuntimeOptions, 'gateway' | 'clock'>> {
  script: readonly ScriptedTurn[] | ScriptFn
  clock?: SyntheticClock
  /** 网关支持强制工具选择（grounding 的 tool_choice 那一路）；缺省 true。 */
  toolChoice?: boolean
  /** 工具执行器；缺省返回订单 / 政策命中。 */
  tools?: Record<string, (input: Record<string, unknown>) => ToolExecution>
  gateway?: ModelGatewayApi
  stageResult?: (intent: StageIntent) => { change_id: string } | undefined
  draftResult?: (payload: DraftPayload) => { approval_item_id: string } | undefined
}

export const DEFAULT_TOOLS: Record<string, (input: Record<string, unknown>) => ToolExecution> = {
  get_order: () => ({ status: 'ok', data: ORDER }),
  list_orders: () => ({ status: 'ok', data: { orders: [ORDER], count: 1 } }),
  search_policies: () => ({
    status: 'ok',
    data: {
      hits: [
        {
          id: 'fact_return_window',
          statement: 'Returns are accepted within 14 days of delivery.',
          layer: 'company',
        },
      ],
    },
    provenance: [{ type: 'fact_card', id: 'fact_return_window' }],
  }),
}

/** 装一台可观察的 direct-llm 运行时。 */
export function harness(options: HarnessOptions): Harness {
  const c = options.clock ?? clock()
  const events: RunEvent[] = []
  const staged: StageIntent[] = []
  const drafts: DraftPayload[] = []
  const toolCalls: { name: string; input: Record<string, unknown> }[] = []
  const table = options.tools ?? DEFAULT_TOOLS
  const base = options.gateway ?? gatewayOf(options.script, c)
  const {
    script: _script,
    clock: _clock,
    toolChoice,
    tools: _tools,
    gateway: _gateway,
    stageResult,
    draftResult,
    ...rest
  } = options

  const runtime = createDirectRuntime({
    gateway: toolChoice === false ? base : withToolChoice(base),
    clock: c,
    executeTool: async ({ name, input }) => {
      toolCalls.push({ name, input })
      const fn = table[name] ?? table[name.slice(name.indexOf('.') + 1)]
      return fn === undefined ? { status: 'error', reason: `unknown_tool: ${name}` } : fn(input)
    },
    stage: async (intent) => {
      staged.push(intent)
      const res = stageResult?.(intent)
      return stageResult === undefined ? { change_id: `chg_${staged.length}` } : res
    },
    createDraft: async (payload) => {
      drafts.push(payload)
      const res = draftResult?.(payload)
      return draftResult === undefined ? { approval_item_id: `appr_${drafts.length}` } : res
    },
    ...rest,
  })

  return {
    runtime,
    events,
    staged,
    drafts,
    toolCalls,
    clock: c,
    run: (req = makeRequest(), signal = new AbortController().signal) =>
      runtime.run(req, (e) => events.push(e), signal),
  }
}

export const types = (events: readonly RunEvent[]): string[] => events.map((e) => e.type)

export function eventsOf<T extends RunEvent['type']>(
  events: readonly RunEvent[],
  type: T,
): Extract<RunEvent, { type: T }>[] {
  return events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type)
}
