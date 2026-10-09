/**
 * WP207：随便聊里「让 AI 找回」——模型调只读的 `find_archived_work`，候选以卡片推给界面，
 * 存在那条回复上；**模型手上没有恢复**。这个人没有归档的事时，工具不挂（老对话一个字不变）。
 */
import type { FreeChatFrame } from '@agentsws/api'
import type {
  ArchivedWorkCandidate,
  FindArchivedWorkInput,
  ModelProvider,
  ModelRef,
} from '@agentsws/contracts'
import { createModelGateway } from '@agentsws/model-gateway'
import { describe, expect, it } from 'vitest'
import { createFreeChatPort } from '../src/free-chat.js'
import { createFreeChatStore } from '../src/free-chat-store.js'

const clock = { now: () => '2026-09-30T08:00:00.000Z' }
const actor = { workspace_id: 'ws_1', person_id: 'per_me', assignment_id: 'asg_me' }

const candidate = (id: string, score: number): ArchivedWorkCandidate => ({
  matter_id: id,
  title: `美国红人样品 ${id}`,
  summary: '样品下周寄到',
  archived_at: '2026-09-25T00:00:00.000Z',
  last_activity: '2026-09-22T00:00:00.000Z',
  score,
  why: ['title:红人'],
})

function setup(has: boolean) {
  const ref: ModelRef = { provider: 'deepseek', model: 'deepseek-flash' }
  const tools: string[][] = []
  const toolResults: string[] = []
  let step = 0
  const provider: ModelProvider = {
    ref,
    capabilities: { vision: false, image_generation: false },
    async complete(req) {
      tools.push((req.tools ?? []).map((t) => t.name))
      const last = req.messages.at(-1)
      if (last?.role === 'tool') toolResults.push(String(last.content))
      const usage = { input_tokens: 1, output_tokens: 1, cached_tokens: 0 }
      step += 1
      if (step <= 2 && (req.tools ?? []).some((t) => t.name === 'find_archived_work'))
        return {
          text: '',
          tool_calls: [
            {
              id: `call_${step}`,
              name: 'find_archived_work',
              input:
                step === 1
                  ? { query: '红人 样品', since: '2026-09-21T00:00:00Z' }
                  : { query: 'US creator sample' },
            },
          ],
          usage,
        }
      return { text: '找到这几个，点一下就放回左栏。', usage }
    },
  }
  const gateway = createModelGateway({
    providers: [provider],
    policy: {
      default: ref,
      prices: { 'deepseek/deepseek-flash': { in: 0, out: 0, cached: 0 } },
    },
    clock,
    eventSink: () => undefined,
    env: {},
  })
  const recalls: FindArchivedWorkInput[] = []
  let n = 0
  const port = createFreeChatPort({
    clock,
    store: createFreeChatStore(),
    gateway: async () => gateway,
    models: async () => ({
      chatChoices: () => [
        { id: 'deepseek/deepseek-flash', label: 'DeepSeek', official: false, vision: 'no' },
      ],
      defaultRef: () => ref,
      configured: () => true,
    }),
    roleOf: () => 'common.owner',
    humanize: (e) => String(e),
    newId: (p) => {
      n += 1
      return `${p}_${n}`
    },
    archive: {
      has: () => has,
      recall: async (_actor, input) => {
        recalls.push(input)
        return recalls.length === 1
          ? [candidate('mat_a', 0.9), candidate('mat_b', 0.4)]
          : [candidate('mat_b', 0.7), candidate('mat_c', 0.3)]
      },
    },
  })
  return { port, tools, toolResults, recalls }
}

describe('WP207 随便聊里的 AI 找回', () => {
  it('模型调找回 → 候选卡推给界面、存在回复上；换个说法再找会合并去重；模型没有恢复这个动作', async () => {
    const t = setup(true)
    const s = await t.port.create(actor, {})
    const frames: FreeChatFrame[] = []
    await t.port.turn(
      actor,
      { session_id: s.id, text: '把上周跟那个美国红人谈样品的对话找回来' },
      (f) => frames.push(f),
      new AbortController().signal,
    )
    expect(t.tools[0]).toEqual(['find_archived_work'])
    expect(t.recalls[0]).toEqual({ query: '红人 样品', since: '2026-09-21T00:00:00Z' })
    const cards = frames.filter((f) => f.type === 'archived_candidates')
    expect(cards).toHaveLength(2)
    const done = frames.find((f) => f.type === 'done')
    const saved = done?.type === 'done' ? done.message : undefined
    expect(saved?.archived_candidates?.map((c) => [c.matter_id, c.score])).toEqual([
      ['mat_a', 0.9],
      ['mat_b', 0.7],
      ['mat_c', 0.3],
    ])
    expect(t.toolResults[0]).toContain('用户点哪张才恢复哪张')
    // 存下来的那条也带着卡（刷新页面还在）
    const messages = await t.port.messages(actor, s.id)
    expect(messages.at(-1)?.archived_candidates).toHaveLength(3)
  })

  it('没有归档的事：工具不挂，回复上也没有卡', async () => {
    const t = setup(false)
    const s = await t.port.create(actor, {})
    const frames: FreeChatFrame[] = []
    await t.port.turn(
      actor,
      { session_id: s.id, text: '你好' },
      (f) => frames.push(f),
      new AbortController().signal,
    )
    expect(t.tools).toEqual([[]])
    expect(t.recalls).toHaveLength(0)
    const done = frames.find((f) => f.type === 'done')
    expect(done?.type === 'done' ? done.message.archived_candidates : 'x').toBeUndefined()
  })
})
