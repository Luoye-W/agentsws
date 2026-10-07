/**
 * WP260：要产出东西的运行（`RunRequest.produce`）在 dsh 这一档——「说了要做却停下」在同一个 Agent 上
 * 追加一句「接着做」再跑一轮（与 direct 同一句、同一个 progress 留痕）；普通运行一个字节不变；
 * 请求带了 `budget.max_turns` 就按它定步数。两档（同进程 / 子进程）各跑一遍。
 */
import type { ChatMessage, Completion, RunProduce, RunRequest } from '@agentsws/contracts'
import { UNFINISHED_NUDGE, UNFINISHED_STEP } from '@agentsws/stand-ins'
import { describe, expect, it, vi } from 'vitest'
import {
  createDshRuntime,
  type DshRuntimeMode,
  type ModelGatewayLike,
  maxStepsFor,
} from '../src/index.js'
import { baseOptions, collect, MODEL, makeRequest } from './helpers.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const PRODUCE: RunProduce = {
  deliver_tools: ['theme_push_unpublished', 'theme_publish'],
  max_nudges: 3,
  compact_at_tokens: 48_000,
  keep_recent_results: 6,
}
const CI16 = '现在读首页模板、FAQ/容器分区、标题块的 schema，并顺手看店里有没有可引用的商品。'

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

const themeRequest = (produce?: RunProduce): RunRequest => {
  const base = makeRequest({ role_id: 'site.shopify-theme' })
  return {
    ...base,
    grounding: [],
    tools: { ...base.tools, allow: ['theme_push_unpublished', 'theme_read_file'] },
    expectations: { outputs: ['answer'], must_stage_if_change_requested: false },
    ...(produce === undefined ? {} : { produce }),
  }
}

const options = (gateway: ModelGatewayLike, calls: string[]) =>
  baseOptions({
    gateway,
    sideEffects: { theme_read_file: 'read_external', theme_push_unpublished: 'local' },
    executeTool: async ({ name, input }) => {
      calls.push(name)
      return name === 'theme_push_unpublished'
        ? { status: 'ok', data: { theme_id: '200001', theme_name: String(input.name) } }
        : { status: 'ok', data: { path: String(input.path), content: 'x' } }
    },
  })

const READ = { id: 'c1', name: 'theme_read_file', input: { path: 'AGENTS.md' } }
const PUSH = { id: 'c2', name: 'theme_push_unpublished', input: { name: 'Rollout 首页 v1' } }
const MODES: Exclude<DshRuntimeMode, 'auto'>[] = ['in-process', 'subprocess']

describe.each(MODES)('WP260 dsh（%s）：说了要做却停下 → 续跑', (mode) => {
  it('ci.16 那句「现在读…」不收工：追加「接着做」，接着推预览、交代结果', async () => {
    const gateway = scripted([
      { text: '', tool_calls: [READ] },
      { text: CI16 },
      { text: '', tool_calls: [PUSH] },
      { text: '预览好了。' },
    ])
    const calls: string[] = []
    const runtime = createDshRuntime({ ...options(gateway, calls), mode })
    const { sink, events } = collect()
    const result = await runtime.run(themeRequest(PRODUCE), sink, new AbortController().signal)
    expect(result.status).toBe('completed')
    expect(calls).toEqual(['theme_read_file', 'theme_push_unpublished'])
    expect(result.outputs).toContainEqual({ kind: 'answer', text: '预览好了。' })
    const nudged = gateway.seen[2] ?? []
    expect(nudged.at(-1)).toMatchObject({ role: 'user', content: UNFINISHED_NUDGE })
    expect(events.filter((e) => e.type === 'progress' && e.step === UNFINISHED_STEP)).toHaveLength(
      1,
    )
  })

  it('普通运行（没有 produce）同一句照旧收工', async () => {
    const gateway = scripted([{ text: '', tool_calls: [READ] }, { text: CI16 }])
    const calls: string[] = []
    const runtime = createDshRuntime({ ...options(gateway, calls), mode })
    const { sink, events } = collect()
    const result = await runtime.run(themeRequest(), sink, new AbortController().signal)
    expect(gateway.seen).toHaveLength(2)
    expect(result.outputs).toContainEqual({ kind: 'answer', text: CI16 })
    expect(events.some((e) => e.type === 'progress' && e.step === UNFINISHED_STEP)).toBe(false)
  })
})

describe('WP260 maxStepsFor：请求带了回合上限就按它', () => {
  it('max_turns 60 → 60 步；比 8 小不往下压；不带照旧', () => {
    expect(maxStepsFor({ budget: { max_tool_calls: 60, max_turns: 60 } })).toBe(60)
    expect(maxStepsFor({ budget: { max_tool_calls: 60, max_turns: 3 } })).toBe(8)
    expect(maxStepsFor({ budget: { max_tool_calls: 60 } })).toBe(8)
  })
})
