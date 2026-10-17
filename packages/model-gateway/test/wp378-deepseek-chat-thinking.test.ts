/**
 * WP378（决策 1055）：DeepSeek 官方 API key 走 Chat 口那一条的思考档。
 *
 * 上游是**本机假服务**（`node:http` 监听 127.0.0.1 的随机端口，回 OpenAI 兼容形状），不联网、不花钱；
 * 只核请求体：v4 Pro 快 = 关掉思考 / 标准 = high / 深度 = max，Flash 快 = low / 标准 = high / 深度 = max（与工坊积分一致）。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ReasoningEffort } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createModelGateway,
  DEEPSEEK_THINKING_LEVELS,
  deepseekChatEffortFields,
  deepseekThinkingLevelsOf,
  openaiCompatibleProvider,
} from '../src/index.js'
import { fixedClock, meta, policy, recorder } from './helpers.js'

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
})

/** 本机假 DeepSeek Chat 口：记下每次请求体，回一段最小的 OpenAI 兼容回包（流式与非流式都认）。 */
async function fakeDeepSeek(): Promise<{ base: string; bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8')
    })
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      bodies.push(body)
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(
          [
            `data: ${JSON.stringify({ choices: [{ delta: { content: '好' } }] })}`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 8 } } })}`,
            'data: [DONE]',
            '',
          ].join('\n\n'),
        )
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 9,
            completion_tokens_details: { reasoning_tokens: 8 },
          },
        }),
      )
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, bodies }
}

function gatewayFor(base: string, model: string, deepseekThinking: boolean) {
  const provider = openaiCompatibleProvider({
    baseUrl: base,
    apiKey: () => 'sk-wp378-fake-not-a-real-key',
    model,
    provider: 'deepseek',
    region: 'cn',
    ...(deepseekThinking ? { deepseekThinking: true } : {}),
  })
  return createModelGateway({
    providers: [provider],
    policy: policy({
      default: provider.ref,
      prices: { [`deepseek/${model}`]: { in: 0, out: 0, cached: 0 } },
    }),
    clock: fixedClock(),
    eventSink: recorder().sink,
    env: {},
  })
}

const ask = (
  gateway: ReturnType<typeof gatewayFor>,
  extra: { reasoning_effort?: ReasoningEffort; thinking?: 'off' } = {},
) => gateway.complete({ messages: [{ role: 'user', content: '在吗' }], meta: meta(), ...extra })

describe('三档表（与工坊积分一致）', () => {
  it('v4 Pro：快 = off / 标准 = high / 深度 = max；Flash 与两个老名字：low / high / max；别的不认', () => {
    expect(deepseekThinkingLevelsOf('deepseek-v4-pro')).toEqual({
      fast: 'off',
      standard: 'high',
      deep: 'max',
    })
    for (const m of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      expect(deepseekThinkingLevelsOf(m)).toEqual({ fast: 'low', standard: 'high', deep: 'max' })
    }
    for (const m of ['deepseek-chat', 'deepseek-reasoner', 'DEEPSEEK-V4-PRO', 'toString']) {
      expect(deepseekThinkingLevelsOf(m)).toBeUndefined()
    }
    expect(Object.keys(DEEPSEEK_THINKING_LEVELS)).toHaveLength(4)
  })

  it('请求体那两格：off 只关思考；不在三档里的值、不认得的模型、没选、硬要别想——一格不写', () => {
    expect(deepseekChatEffortFields('deepseek-v4-pro', 'off', undefined)).toEqual({
      thinking: { type: 'disabled' },
    })
    expect(deepseekChatEffortFields('deepseek-flash', 'low', undefined)).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    })
    expect(deepseekChatEffortFields('deepseek-v4-pro', 'low', undefined)).toEqual({})
    expect(deepseekChatEffortFields('deepseek-flash', 'off', undefined)).toEqual({})
    expect(deepseekChatEffortFields('deepseek-flash', 'medium', undefined)).toEqual({})
    expect(deepseekChatEffortFields('deepseek-chat', 'max', undefined)).toEqual({})
    expect(deepseekChatEffortFields('deepseek-flash', undefined, undefined)).toEqual({})
    expect(deepseekChatEffortFields('deepseek-flash', 'max', 'off')).toEqual({})
  })
})

describe('经网关打到本机假 DeepSeek Chat 口', () => {
  it('v4 Pro：快 / 标准 / 深度 → thinking disabled / enabled + high / enabled + max', async () => {
    const { base, bodies } = await fakeDeepSeek()
    const gateway = gatewayFor(base, 'deepseek-v4-pro', true)
    await ask(gateway, { reasoning_effort: 'off' })
    await ask(gateway, { reasoning_effort: 'high' })
    const deep = await ask(gateway, { reasoning_effort: 'max' })
    expect(bodies[0]?.thinking).toEqual({ type: 'disabled' })
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
    expect(bodies[1]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })
    expect(bodies[2]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'max' })
    // 思考 token 含在 completion_tokens 里：照实记 9，不另加 8
    expect(deep.usage.output_tokens).toBe(9)
  })

  it('Flash：快 / 标准 / 深度 → low / high / max（都开思考）', async () => {
    const { base, bodies } = await fakeDeepSeek()
    const gateway = gatewayFor(base, 'deepseek-flash', true)
    for (const effort of ['low', 'high', 'max'] as const) {
      await ask(gateway, { reasoning_effort: effort })
    }
    expect(bodies.map((b) => [b.thinking, b.reasoning_effort])).toEqual([
      [{ type: 'enabled' }, 'low'],
      [{ type: 'enabled' }, 'high'],
      [{ type: 'enabled' }, 'max'],
    ])
  })

  it('没选：一格不多；调用方硬要「别想」：只有关思考那一格', async () => {
    const { base, bodies } = await fakeDeepSeek()
    const gateway = gatewayFor(base, 'deepseek-flash', true)
    await ask(gateway)
    await ask(gateway, { reasoning_effort: 'max', thinking: 'off' })
    expect(bodies[0]).not.toHaveProperty('thinking')
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
    expect(bodies[1]?.thinking).toEqual({ type: 'disabled' })
    expect(bodies[1]).not.toHaveProperty('reasoning_effort')
  })

  it('没开这一格的（别家 / 代理地址）：选了档也一格不发（老行为不变）', async () => {
    const { base, bodies } = await fakeDeepSeek()
    const gateway = gatewayFor(base, 'deepseek-flash', false)
    await ask(gateway, { reasoning_effort: 'max' })
    expect(bodies[0]).not.toHaveProperty('thinking')
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
  })

  it('流式那条（随便聊）同样带', async () => {
    const { base, bodies } = await fakeDeepSeek()
    const gateway = gatewayFor(base, 'deepseek-v4-pro', true)
    const deltas: string[] = []
    await gateway.complete({
      messages: [{ role: 'user', content: '在吗' }],
      meta: meta(),
      reasoning_effort: 'max',
      on_delta: (d: string) => {
        deltas.push(d)
      },
    })
    expect(deltas.join('')).toBe('好')
    expect(bodies[0]).toMatchObject({
      stream: true,
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    })
  })
})
