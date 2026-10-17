/**
 * WP370（Luoye 10-17）：输入框 AI 钮的**思考程度**与「AI 钮里还要列的那几个」。
 *
 * | 组 | 用什么 | 钉什么 |
 * |---|---|---|
 * | (a) 三档白话 | `thinkingOptionsOf` | 订阅（off…xhigh）→ 快 low / 标准 medium / 深度 high；DeepSeek（off/low/high/max，默认 high）→ low / high / max；只剩一档不出 |
 * | (b) 运行时 | 真 `createRuntime`（stub / direct / dsh 进程内）+ 记账的替身网关 | 事项带 `model_effort` → direct / dsh 每次补全都交 `reasoning_effort`；这个模型没有这一档 → 不交（按默认）；没选的事项一个字节不变 |
 * | (c) 工作端口 | `createWorkPort` + 真 `Work` | 开事项时记下思考程度；换模型清掉；这个模型没有这一档 → 拒 |
 *
 * 全程替身，不联网。
 */
import type { Clock, Completion, Matter, ModelRef, ReasoningEffort } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import { createWork, type Work } from '@agentsws/work'
import { describe, expect, it, vi } from 'vitest'
import { hasThinkingEffort, thinkingOptionsOf } from '../src/model-thinking.js'
import { chatModelRefOf, pickerModelsFor } from '../src/models.js'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'
import { createWorkPort } from '../src/work.js'

vi.setConfig({ testTimeout: 120_000 })

const clock: Clock = { now: () => '2026-10-17T10:00:00.000Z' }
const DEFAULT: ModelRef = { provider: 'deepseek', model: 'deepseek-flash', region: 'cn' }
const SUB_THINKING = thinkingOptionsOf(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
const CHOICES = [
  { id: 'deepseek/deepseek-flash', label: 'DeepSeek', official: false, vision: 'no' as const },
  {
    id: 'openai-codex/gpt-5.5',
    label: 'ChatGPT 订阅',
    official: false,
    vision: 'ok' as const,
    ...(SUB_THINKING === undefined ? {} : { thinking: SUB_THINKING }),
  },
]
const models = { chatChoices: () => CHOICES }
const effortOk = (id: string, effort: ReasoningEffort): boolean =>
  CHOICES.some(
    (c) => c.id === id && hasThinkingEffort('thinking' in c ? c.thinking : undefined, effort),
  )

describe('WP370 (a) 三档白话', () => {
  it('ChatGPT 订阅：快 = low、标准 = medium（默认）、深度 = high', () => {
    expect(SUB_THINKING).toEqual({
      options: [
        { level: 'fast', effort: 'low' },
        { level: 'standard', effort: 'medium' },
        { level: 'deep', effort: 'high' },
      ],
      default: 'medium',
    })
  })

  it('DeepSeek：照官方四档、默认 high → 快 = low、标准 = high、深度 = max', () => {
    expect(thinkingOptionsOf(['off', 'low', 'high', 'max'], 'high')).toEqual({
      options: [
        { level: 'fast', effort: 'low' },
        { level: 'standard', effort: 'high' },
        { level: 'deep', effort: 'max' },
      ],
      default: 'high',
    })
  })

  it('没得选就不出：只有 off，或只有一档', () => {
    expect(thinkingOptionsOf(['off'])).toBeUndefined()
    expect(thinkingOptionsOf(['medium'])).toBeUndefined()
    expect(thinkingOptionsOf([])).toBeUndefined()
  })

  it('AI 钮里还要列的那几个：去重、去空、去掉主模型；不给就保持原样；清空就不存', () => {
    expect(pickerModelsFor([' gpt-4.1 ', 'gpt-4.1', 'main', ''], undefined, 'main')).toEqual([
      'gpt-4.1',
    ])
    expect(pickerModelsFor(undefined, ['a'], 'main')).toEqual(['a'])
    expect(pickerModelsFor([], ['a'], 'main')).toBeUndefined()
  })
})

const roles = {
  effectiveConfig: () => ({ role_id: 'dtc.support', grounding: [], skills: [], browser_scope: [] }),
  assignments: { get: () => undefined },
} as unknown as RoleStore

const matterOf = (id: string, model?: string, effort?: ReasoningEffort): Matter =>
  ({
    id,
    schema_version: 1,
    workspace_id: 'ws_1',
    kind: 'adhoc',
    title: '回复客户 Anna 的退货',
    status: 'open',
    context: { summary: '', pinned: [], participants: [], last_activity: clock.now() },
    created_at: clock.now(),
    updated_at: clock.now(),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { model_effort: effort }),
  }) as unknown as Matter

type Mode = 'stub' | 'direct' | 'dsh'

/** 跑一次：回网关收到的每一次 `reasoning_effort`（没给就是 `null`）。 */
async function runOnce(mode: Mode, matter: Matter): Promise<(ReasoningEffort | null)[]> {
  const asked: (ReasoningEffort | null)[] = []
  const gateway = {
    async complete(req: { model?: ModelRef; reasoning_effort?: ReasoningEffort }) {
      asked.push(req.reasoning_effort ?? null)
      return {
        text: '好的，我先看看这单的物流。',
        usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
        model: req.model ?? DEFAULT,
        static_prefix_hash: 'p',
      } satisfies Completion
    },
    async embed() {
      return { vectors: [], usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0 } }
    },
    usage: () => ({}),
    budget: () => ({}),
  } as unknown as ModelGatewayApi
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models: gateway,
    approvals: {
      create: async () => ({ id: 'apr_1', state: 'pending' }),
    } as unknown as RuntimeOptions['approvals'],
    roles,
    appendEvent: () => undefined,
    prefer: mode === 'stub' ? 'stub' : 'direct',
    modelRef: () => DEFAULT,
    hasModel: () => mode !== 'stub',
    modelOverride: (id: string) => chatModelRefOf(models, id),
    modelEffort: effortOk,
    ...(mode === 'dsh' ? { dshAllRuns: true, dshMode: 'in-process' as const } : {}),
  } as RuntimeOptions)
  runtime.bind({
    appendEvent: () => undefined,
    onRunCompleted: () => undefined,
    onCard: () => undefined,
  } as unknown as Work)
  await runtime.startRun({
    matter,
    brief: '客户问退货进度',
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  return asked
}

describe('WP370 (b) 事项选的思考程度：direct / dsh 每次补全都交给网关', () => {
  for (const mode of ['direct', 'dsh'] as const) {
    it(`${mode}：选了「深度」就每次带 high；这个模型没有那一档就不带；没选的不带`, async () => {
      const deep = await runOnce(mode, matterOf('mat_a', 'openai-codex/gpt-5.5', 'high'))
      expect(deep.length).toBeGreaterThan(0)
      for (const e of deep) expect(e).toBe('high')

      // DeepSeek 那条在这份替身清单里没有思考档：存着的 max 不交出去，按模型默认
      const stale = await runOnce(mode, matterOf('mat_b', 'deepseek/deepseek-flash', 'max'))
      for (const e of stale) expect(e).toBeNull()

      const plain = await runOnce(mode, matterOf('mat_c', 'openai-codex/gpt-5.5'))
      for (const e of plain) expect(e).toBeNull()
    })
  }

  it('stub：不看思考程度，照样跑完', async () => {
    const asked = await runOnce('stub', matterOf('mat_d', 'openai-codex/gpt-5.5', 'high'))
    expect(asked).toEqual([])
  })
})

describe('WP370 (c) 工作端口：记下、换模型清掉、没有那一档就拒', () => {
  const portOf = () => {
    const work = createWork({
      workspace_id: 'ws_1' as never,
      clock,
      random: () => 0.5,
      tz_offset_minutes: 480,
    })
    const port = createWorkPort({
      clock,
      work,
      approvals: () => [],
      orders: () => [],
      label: () => undefined,
      knownModel: (id) => CHOICES.some((c) => c.id === id),
      knownEffort: effortOk,
    })
    return { work, port }
  }
  const actor = { workspace_id: 'ws_1', person_id: 'per_1', assignment_id: 'asg_1' } as never

  it('开事项带着思考程度就记下；模型没有那一档就不记', async () => {
    const { port } = portOf()
    const a = await port.createMatter(actor, {
      kind: 'adhoc',
      title: '查一下竞品',
      model: 'openai-codex/gpt-5.5',
      model_effort: 'low',
    })
    expect(a.model_effort).toBe('low')
    const b = await port.createMatter(actor, {
      kind: 'adhoc',
      title: '回个邮件',
      model: 'deepseek/deepseek-flash',
      model_effort: 'max',
    })
    expect(b.model).toBe('deepseek/deepseek-flash')
    expect(b.model_effort).toBeUndefined()
  })

  it('换思考程度只改这一件；换了模型就回到那个模型的默认档；没有那一档就拒', async () => {
    const { port } = portOf()
    const m = await port.createMatter(actor, { kind: 'adhoc', title: '写周报' })
    const deep = await port.setMatterModel?.(actor, m.id, 'openai-codex/gpt-5.5', 'high')
    expect(deep).toMatchObject({ model: 'openai-codex/gpt-5.5', model_effort: 'high' })
    const switched = await port.setMatterModel?.(actor, m.id, 'deepseek/deepseek-flash')
    expect(switched?.model).toBe('deepseek/deepseek-flash')
    expect(switched?.model_effort).toBeUndefined()
    await expect(
      Promise.resolve(port.setMatterModel?.(actor, m.id, 'deepseek/deepseek-flash', 'max')),
    ).rejects.toThrow(/思考程度/)
  })
})
