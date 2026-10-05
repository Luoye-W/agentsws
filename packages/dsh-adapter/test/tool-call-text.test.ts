/**
 * WP230（10-05 真模型 deepseek-chat 实测）：模型把「[calling …]」当文字吐出来。dsh 这一档：
 *
 * 1. `toChatMessages` 回放 assistant 时 content 只留模型的话，工具调用只走 `tool_calls`；
 * 2. `TurnSummary` 认得出「没有真调用、文字像在调工具」的最后一条，`text` 不取它；
 * 3. 运行时：重试一次（追加同一句提示）→ 正常就收尾，仍异常就报格式异常——与 direct 同一份判定。
 */
import type { ChatMessage, Completion, RunRequest } from '@agentsws/contracts'
import { TOOL_CALL_TEXT_FAILURE, TOOL_CALL_TEXT_NUDGE } from '@agentsws/stand-ins'
import type { GenerateOptions, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { TurnSummary } from '../src/harness.js'
import { createDshRuntime, type DshRuntimeMode, type ModelGatewayLike } from '../src/index.js'
import { toChatMessages } from '../src/llm.js'
import { baseOptions, collect, MODEL, makeRequest, recorder } from './helpers.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const FAKE = '[calling search_policies {"query":"return window"}]'

describe('WP230 toChatMessages：回放不写 [calling …]', () => {
  const call = (id: string, name: string) => ({
    type: 'tool-call',
    id: id as ToolCallId,
    name,
    arguments: '{"order_id":"o1"}',
  })
  const options = {
    messages: [
      { role: 'assistant', content: [call('c1', 'get_order')] },
      {
        role: 'tool',
        toolCallId: 'c1' as ToolCallId,
        source: { kind: 'tool', callId: 'c1' },
        content: [{ type: 'text', text: '{"id":"o1"}' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '再看政策。' }, call('c2', 'search_policies')],
      },
    ],
  } as unknown as GenerateOptions

  it('只调工具的那一轮 content 是空串；有话的那一轮只留话；调用都在 tool_calls 里', () => {
    const messages = toChatMessages(options)
    const assistants = messages.filter((m) => m.role === 'assistant')
    expect(assistants.map((m) => m.content)).toEqual(['', '再看政策。'])
    expect(assistants.map((m) => m.tool_calls?.[0]?.name)).toEqual(['get_order', 'search_policies'])
    expect(JSON.stringify(messages)).not.toContain('[calling')
  })
})

const ev = (type: string, data: unknown) => ({ type, data }) as unknown as SessionEvent
const said = (...blocks: { type: string; text?: string }[]) =>
  ev('assistant/message', { message: { content: blocks } })

describe('WP230 TurnSummary：最后一条是伪调用文字', () => {
  it('认出来，text 不取那段假文字（前面真说过的话留着）', () => {
    const t = new TurnSummary()
    t.observe(said({ type: 'text', text: '先查一下。' }, { type: 'tool-call' }))
    t.observe(said({ type: 'text', text: FAKE }))
    expect(t.result()).toEqual({ text: '先查一下。', reason: 'unknown', tool_call_text: true })
  })

  it('带真调用的那条不算；之后正常说话就清掉', () => {
    const t = new TurnSummary()
    t.observe(said({ type: 'text', text: FAKE }, { type: 'tool-call' }))
    expect(t.result().tool_call_text).toBeUndefined()
    t.observe(said({ type: 'text', text: FAKE }))
    t.observe(said({ type: 'text', text: '可以退。' }))
    expect(t.result()).toEqual({ text: '可以退。', reason: 'unknown' })
  })
})

/** 按次序回放的假网关；记下每一轮送进来的消息。 */
function scripted(
  turns: readonly Pick<Completion, 'text' | 'tool_calls'>[],
): ModelGatewayLike & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = []
  return {
    seen,
    async complete(req): Promise<Completion> {
      seen.push(req.messages)
      const turn = turns[seen.length - 1] ?? { text: 'fallback' }
      return {
        text: turn.text,
        ...(turn.tool_calls === undefined ? {} : { tool_calls: turn.tool_calls }),
        usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
        model: MODEL,
        static_prefix_hash: 'prefix',
      }
    },
  }
}

const answerRequest = (): RunRequest => ({
  ...makeRequest(),
  expectations: { outputs: ['answer'], must_stage_if_change_requested: false },
})

const GET_ORDER = { id: 'call_1', name: 'get_order', input: { order_id: 'ord_1001' } }
const MODES: Exclude<DshRuntimeMode, 'auto'>[] = ['in-process', 'subprocess']

describe.each(MODES)('WP230 dsh 运行时（%s）：伪调用文字兜底', (mode) => {
  it('第一次吐假调用 → 追加提示重试 → 第二次正常：正常收尾，假文字不进答案', async () => {
    const gateway = scripted([
      { text: '', tool_calls: [GET_ORDER] },
      { text: FAKE },
      { text: 'Hi Anna, you can return it within 14 days.' },
    ])
    const runtime = createDshRuntime({ ...baseOptions({ gateway }), mode })
    const { sink, events } = collect()
    const result = await runtime.run(answerRequest(), sink, new AbortController().signal)
    expect(result.status).toBe('completed')
    expect(result.outputs).toContainEqual({
      kind: 'answer',
      text: 'Hi Anna, you can return it within 14 days.',
    })
    expect(gateway.seen).toHaveLength(3)
    // 重试那一轮：模型看得见自己写了什么，紧跟同一句提示（与 direct 一字不差）
    const retry = gateway.seen[2] ?? []
    expect(retry.at(-2)).toMatchObject({ role: 'assistant', content: FAKE })
    expect(retry.at(-1)).toMatchObject({ role: 'user', content: TOOL_CALL_TEXT_NUDGE })
    // 历史里只调工具的那一轮 content 是空串，不是 [calling …]
    const first = retry.find((m) => m.role === 'assistant')
    expect(first?.content).toBe('')
    expect(first?.tool_calls?.[0]?.name).toBe('get_order')
    const progress = events.filter((e) => e.type === 'progress' && e.step === 'tool_call_text')
    expect(progress).toHaveLength(1)
    const deltas = events.flatMap((e) => (e.type === 'text.delta' ? [e.text] : []))
    expect(deltas).not.toContain(FAKE)
    expect(result.summary).not.toContain('calling')
  })

  it('重试一次还是假调用：报「模型输出格式异常」，不把假文字当答案、不出卡', async () => {
    const gateway = scripted([
      { text: '', tool_calls: [GET_ORDER] },
      { text: FAKE },
      { text: '<tool_call>{"name":"search_policies"}</tool_call>' },
      { text: 'should never be asked' },
    ])
    const rec = recorder()
    const runtime = createDshRuntime({
      ...baseOptions({ gateway, stage: rec.stage, createDraft: rec.createDraft }),
      mode,
    })
    const { sink, events } = collect()
    const result = await runtime.run(answerRequest(), sink, new AbortController().signal)
    expect(gateway.seen).toHaveLength(3)
    expect(result.status).toBe('failed')
    expect(result.summary).toBe(`这次没跑完：${TOOL_CALL_TEXT_FAILURE}。`)
    expect(result.outputs.some((o) => o.kind === 'answer')).toBe(false)
    expect(rec.drafts).toHaveLength(0)
    expect(rec.staged).toHaveLength(0)
    const failed = events.filter((e) => e.type === 'run.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.type === 'run.failed' && failed[0].error.message).toBe(TOOL_CALL_TEXT_FAILURE)
    expect(events.some((e) => e.type === 'run.completed')).toBe(false)
    expect(JSON.stringify(events.filter((e) => e.type === 'text.delta'))).not.toContain('calling')
  })
})
