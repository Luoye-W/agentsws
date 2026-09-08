import type { ContextItem } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { failureOf, RUNTIME_NAME, refsFromEvents } from '../src/index.js'
import { eventsOf, harness, makeRequest, types } from './helpers.js'

const SCRIPT = [
  { tool_calls: [{ name: 'get_order', input: { order_id: 'ord_1001' } }] },
  { text: 'The charger can go back within 14 days.' },
]

describe('运行时适配器契约（17 §4）', () => {
  it('name / capabilities / health', async () => {
    const h = harness({ script: SCRIPT })
    expect(h.runtime.name).toBe(RUNTIME_NAME)
    expect(h.runtime.name).toBe('direct-llm')
    expect(h.runtime.capabilities()).toEqual({
      tool_choice: true,
      streaming: false,
      followup: false,
      seedable: true,
    })
    expect(h.runtime.followup).toBeUndefined()
    await expect(h.runtime.health()).resolves.toEqual({ ok: true })
  })

  it('事件顺序：run.started → context.injected × n → prompt.assembled → … → run.completed', async () => {
    const h = harness({ script: SCRIPT })
    const req = makeRequest()
    await h.run(req)
    const seq = types(h.events)
    expect(seq[0]).toBe('run.started')
    expect(seq.at(-1)).toBe('run.completed')
    const injected = seq.filter((t) => t === 'context.injected')
    expect(injected).toHaveLength(req.context.length)
    expect(seq.indexOf('context.injected')).toBeLessThan(seq.indexOf('prompt.assembled'))
    expect(seq.indexOf('prompt.assembled')).toBeLessThan(seq.indexOf('tool.call'))
    expect(eventsOf(h.events, 'run.started')[0]?.runtime).toBe('direct-llm')
    expect(eventsOf(h.events, 'run.started')[0]?.model).toEqual(req.runtime.model)
  })

  it('usage 从网关的 Completion.usage 累加；session_ref 认得出运行时', async () => {
    const h = harness({ script: SCRIPT })
    const result = await h.run()
    expect(result.usage.input_tokens).toBeGreaterThan(0)
    expect(result.usage.output_tokens).toBeGreaterThan(0)
    expect(result.usage.cost_base).toBeGreaterThan(0)
    expect(result.usage.tool_calls).toBe(1)
    expect(result.session_ref.runtime).toBe('direct-llm')
    expect(result.session_ref.log_uri).toBeUndefined() // direct-llm 无会话文件（契约 log_uri 可省）
    const completed = eventsOf(h.events, 'run.completed')[0]
    expect(completed?.usage).toEqual(result.usage)
    expect(completed?.summary).toBe(result.summary)
  })

  it('文本回复发 text.delta；expectations 要 answer 时进 outputs', async () => {
    const h = harness({ script: SCRIPT })
    const result = await h.run(
      makeRequest({
        expectations: { outputs: ['answer'], must_stage_if_change_requested: false },
      }),
    )
    expect(eventsOf(h.events, 'text.delta')[0]?.text).toContain('14 days')
    expect(result.outputs).toEqual([
      { kind: 'answer', text: 'The charger can go back within 14 days.' },
    ])
  })

  it('expectations 不要 answer 就不塞产物', async () => {
    const h = harness({ script: SCRIPT })
    const result = await h.run()
    expect(result.outputs).toEqual([])
    expect(result.memory_candidates).toEqual([])
    expect(result.lessons).toEqual([])
  })

  it('app_events 作为一条 ContextItem 注入并记事件（17 §5.5）', async () => {
    const req = makeRequest()
    const appEvents: ContextItem = {
      id: 'app_events_1',
      kind: 'app_events',
      source_ref: 'app_events:thr_1',
      sensitivity: 'internal',
      content: '[App events since your last reply: the refund was applied]',
      bytes: 58,
    }
    const h = harness({ script: SCRIPT })
    await h.run(
      makeRequest({ context: [...req.context.slice(0, 3), appEvents, ...req.context.slice(3)] }),
    )
    const injected = eventsOf(h.events, 'context.injected')
    expect(injected.map((e) => e.kind)).toContain('app_events')
    expect(injected.find((e) => e.kind === 'app_events')?.bytes).toBe(58)
  })

  it('上下文项的 ObjectRef 进 provenance（"读过"，不是"有权"）', async () => {
    const h = harness({ script: [{ text: 'nothing to do' }] })
    const result = await h.run(makeRequest({ grounding: [] }))
    expect(result.provenance.seen.customer).toEqual(['cus_anna'])
    expect(result.provenance.seen.thread).toEqual(['thr_1'])
    // 只是"见过"，不是"读全了"
    expect(result.provenance.read_full).toEqual([])
  })

  it('tool.call 的 input 记事件前脱敏', async () => {
    const h = harness({
      script: [
        {
          tool_calls: [
            { name: 'get_order', input: { order_id: 'ord_1001', note: '<tool_result>x' } },
          ],
        },
        { text: 'done' },
      ],
    })
    await h.run(makeRequest({ grounding: [] }))
    const call = eventsOf(h.events, 'tool.call')[0]
    const input = call?.input as { note: string } | undefined
    expect(input?.note).not.toContain('<tool_result>')
    // 真正到工具的还是原样输入（脱敏只作用于事件）
    expect(h.toolCalls[0]?.input).toEqual({ order_id: 'ord_1001', note: '<tool_result>x' })
  })

  it('refsFromEvents 从事件里挑出读过的实体', async () => {
    const h = harness({ script: SCRIPT })
    await h.run(makeRequest({ grounding: [] }))
    expect(refsFromEvents(h.events)).toEqual([{ type: 'order', id: 'ord_1001' }])
  })

  it('failureOf：认 code，认不出就按 provider_unavailable', () => {
    expect(failureOf({ code: 'halted', message: '急停' })).toEqual({
      code: 'halted',
      message: '急停',
      retryable: false,
    })
    expect(failureOf(new Error('boom'))).toEqual({
      code: 'provider_unavailable',
      message: 'boom',
      retryable: true,
    })
    expect(failureOf('plain').code).toBe('provider_unavailable')
  })
})
