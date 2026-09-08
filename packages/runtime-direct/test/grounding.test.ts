import type { RunRequest } from '@agentsws/contracts'
import { assemblePromptHash } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { groundingHits, ruleHits, supportsToolChoice, withToolChoice } from '../src/index.js'
import { clock, eventsOf, gatewayOf, harness, makeRequest } from './helpers.js'

const SCRIPT = [
  { tool_calls: [{ name: 'search_policies', input: { query: 'return window' } }] },
  { tool_calls: [{ name: 'search_policies', input: { query: 'return window' } }] },
  { text: 'done' },
]

describe('grounding（17 §5.4、05 §1.8）', () => {
  it('intent 与 cue 同时命中才算命中', () => {
    const rule = {
      name: 'order_status',
      intent_terms: ['order'],
      cue_terms: ['arrived'],
      tool: 'get_order',
      prefetch: true,
    }
    expect(ruleHits('where is my order? it never arrived', rule)).toBe(true)
    expect(ruleHits('my order is fine', rule)).toBe(false) // 只有 intent
    expect(ruleHits('the parcel arrived', rule)).toBe(false) // 只有 cue
    expect(groundingHits(makeRequest())).toHaveLength(1)
    expect(groundingHits(makeRequest({ grounding: [] }))).toHaveLength(0)
  })

  it('网关支持 tool_choice → 第一轮被强制到 grounding 的工具，上下文不变', async () => {
    const h = harness({ script: SCRIPT, toolChoice: true })
    const req = makeRequest()
    await h.run(req)
    // 模型脚本第一轮说的是 search_policies，强制之后先调 get_order
    expect(h.toolCalls.map((c) => c.name)).toEqual(['get_order', 'search_policies'])
    const injected = eventsOf(h.events, 'context.injected')
    expect(injected.map((e) => e.item_id)).toEqual(req.context.map((c) => c.id))
    expect(eventsOf(h.events, 'prompt.assembled')[0]?.hash).toBe(assemblePromptHash(req))
  })

  it('网关不支持 tool_choice → 宿主预取，结果作为第一条 prefetch ContextItem', async () => {
    const h = harness({ script: SCRIPT, toolChoice: false })
    const req = makeRequest()
    await h.run(req)
    const injected = eventsOf(h.events, 'context.injected')
    expect(injected[0]?.kind).toBe('prefetch')
    expect(injected).toHaveLength(req.context.length + 1)

    // prompt.assembled 的哈希是"生效后的请求"的哈希：宿主要把预取项一起落日志才能回放
    const effective: RunRequest = {
      ...req,
      context: [
        {
          id: 'prefetch_order_status',
          kind: 'prefetch',
          source_ref: 'grounding:order_status',
          sensitivity: 'internal',
          content: expect.anything() as unknown,
          bytes: 0,
        },
        ...req.context,
      ],
    }
    expect(eventsOf(h.events, 'prompt.assembled')[0]?.hash).not.toBe(assemblePromptHash(req))
    expect(effective.context[0]?.kind).toBe('prefetch')

    // 预取结果是围栏内的外部数据
    const item = injected[0]
    expect(item?.bytes).toBeGreaterThan(0)
    // 预取也走 provenance：模型没说话，但订单已经"读过"了
    const result = eventsOf(h.events, 'tool.result')[0]
    expect(result?.status).toBe('ok')
    expect(result?.provenance_added).toEqual([{ type: 'order', id: 'ord_1001' }])
  })

  it('prefetch: false 的规则不预取', async () => {
    const h = harness({
      script: SCRIPT,
      toolChoice: false,
    })
    await h.run(
      makeRequest({
        grounding: [
          {
            name: 'order_status',
            intent_terms: ['order'],
            cue_terms: ['arrived'],
            tool: 'get_order',
            prefetch: false,
          },
        ],
      }),
    )
    expect(eventsOf(h.events, 'context.injected')[0]?.kind).toBe('policy')
    expect(h.toolCalls.map((c) => c.name)).toEqual(['search_policies', 'search_policies'])
  })

  it('预取的工具也要过两道门：不在 allowlist 就 blocked，不落 prefetch 项', async () => {
    const h = harness({ script: SCRIPT, toolChoice: false })
    await h.run(
      makeRequest({
        grounding: [
          {
            name: 'order_status',
            intent_terms: ['order'],
            cue_terms: ['arrived'],
            tool: 'create_refund',
            prefetch: true,
          },
        ],
      }),
    )
    const first = eventsOf(h.events, 'tool.result')[0]
    expect(first?.status).toBe('blocked')
    expect(first?.reason).toBe('not_in_allowlist: create_refund')
    expect(eventsOf(h.events, 'context.injected')[0]?.kind).toBe('policy')
  })

  it('supportsToolChoice / withToolChoice：模型给了同名调用就用模型的参数', async () => {
    const c = clock()
    const plain = gatewayOf(
      [{ tool_calls: [{ name: 'get_order', input: { order_id: 'ord_9' } }] }],
      c,
    )
    expect(supportsToolChoice(plain)).toBe(false)
    const forced = withToolChoice(plain, () => ({ order_id: 'fallback' }))
    expect(supportsToolChoice(forced)).toBe(true)
    const meta = {
      workspace_id: 'ws_test',
      assignment_id: 'asg_1',
      role_id: 'dtc.aftersales',
      run_id: 'run_test_1',
      purpose: 'run' as const,
    }
    const hit = await forced.completeWithToolChoice({
      messages: [{ role: 'user', content: 'hi' }],
      meta,
      tool_choice: { type: 'tool', name: 'get_order' },
    })
    expect(hit.tool_calls).toEqual([
      { id: 'call_1_1', name: 'get_order', input: { order_id: 'ord_9' } },
    ])

    const miss = await forced.completeWithToolChoice({
      messages: [{ role: 'user', content: 'hi' }],
      meta,
      tool_choice: { type: 'tool', name: 'search_policies' },
    })
    expect(miss.tool_calls?.[0]?.name).toBe('search_policies')
    expect(miss.tool_calls?.[0]?.input).toEqual({ order_id: 'fallback' })
    expect(miss.text).toBe('')
  })
})
