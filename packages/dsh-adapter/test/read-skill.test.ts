/**
 * WP162：dsh 这一侧也能读按需技能。
 *
 * 照 WP148 的工具桥接方式挂：`read_skill` 在 `tools.allow` 里 → `buildToolDefinitions`
 * 注册成只读工具（参数只有 `name`）→ 执行落到注入的 `executeTool`（服务端那一个执行器）。
 * 这里用脚本化的替身模型：第一轮调 `read_skill`，第二轮收尾；断言入参原样传到执行器、
 * 正文回到了模型的对话里、名字不对时执行器的拒绝原样成了一条 blocked。
 */
import type { Completion } from '@agentsws/contracts'
import { READ_SKILL_TOOL } from '@agentsws/stand-ins'
import { describe, expect, it, vi } from 'vitest'
import {
  buildToolDefinitions,
  classifySideEffect,
  createDshRuntime,
  type DshRuntimeOptions,
  type ModelGatewayLike,
} from '../src/index.js'
import { baseOptions, collect, makeRequest } from './helpers.js'

vi.setConfig({ testTimeout: 60_000 })

const BODY = '## 窗口怎么算\n\n默认从送达日起算。'

function scripted(names: string[]): ModelGatewayLike & { seen: string[] } {
  const seen: string[] = []
  let n = 0
  return {
    seen,
    async complete(req): Promise<Completion> {
      seen.push(JSON.stringify(req.messages))
      const name = names[n]
      n += 1
      return {
        text: name === undefined ? '看过了。' : '',
        ...(name === undefined
          ? {}
          : { tool_calls: [{ id: `call_${n}`, name: READ_SKILL_TOOL, input: { name } }] }),
        usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
        model: { provider: 'stub', model: 'stub-v1' },
        static_prefix_hash: 'p',
      }
    },
  }
}

const executeTool: DshRuntimeOptions['executeTool'] = async ({ name, input }) => {
  if (name !== READ_SKILL_TOOL) return { status: 'error', reason: `unknown ${name}` }
  return input.name === 'returns-policy-calc'
    ? { status: 'ok', data: BODY }
    : { status: 'blocked', reason: `这条职责没有这个技能：${String(input.name)}` }
}

describe('dsh：read_skill', () => {
  it('判成只读；注册出来的参数只有 name', () => {
    expect(classifySideEffect(READ_SKILL_TOOL)).toBe('read_external')
    const req = makeRequest({ allow: ['get_order', READ_SKILL_TOOL] })
    const noop = {
      run: async () => ({ status: 'ok' as const }),
      note: () => undefined,
      provenance: () => undefined,
    }
    const defs = buildToolDefinitions(req, noop, {
      stage: async () => undefined,
      draft: async () => undefined,
    })
    const def = defs.find((d) => d.name === READ_SKILL_TOOL)
    expect(def).toBeDefined()
    expect(JSON.stringify(def)).toContain('技能手册')
  })

  it('登记了的名字：入参原样到执行器，正文回到模型；别的名字被拒成 blocked', async () => {
    const gateway = scripted(['returns-policy-calc', 'email-sms'])
    const calls: unknown[] = []
    const runtime = createDshRuntime({
      ...baseOptions({
        gateway,
        executeTool: async (call) => {
          calls.push(call.input)
          return executeTool(call)
        },
      }),
      mode: 'in-process',
    })
    const { sink, events } = collect()
    const req = makeRequest({ allow: ['get_order', READ_SKILL_TOOL] })
    await runtime.run(req, sink, new AbortController().signal)
    expect(calls).toEqual([{ name: 'returns-policy-calc' }, { name: 'email-sms' }])
    const results = events.filter((e) => e.type === 'tool.result')
    expect(results.map((r) => (r as { status: string }).status)).toEqual(['ok', 'blocked'])
    expect(gateway.seen[1]).toContain('默认从送达日起算')
  })
})
