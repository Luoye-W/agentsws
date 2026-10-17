/**
 * WP370：思考程度（`CompletionHints.reasoning_effort`）经网关交到 provider；DeepSeek Messages 那两格照官方
 * `dsh-llm-deepseek@0.2.1-alpha.5` 的 `serialize.ts` 写。不联网（Messages 口是替身）。
 */
import type { ModelProvider } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  type AccountFetch,
  createModelGateway,
  DEEPSEEK_DEFAULT_REASONING_EFFORT,
  DEEPSEEK_REASONING_EFFORTS,
  deepseekAccountProvider,
  messagesEffortFields,
} from '../src/index.js'
import { fixedClock, meta, policy, recorder } from './helpers.js'

function fakeMessages(): { fetch: AccountFetch; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  const fetch: AccountFetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: '好' }],
        usage: { input_tokens: 3, output_tokens: 1 },
      }),
      text: async () => '',
    }
  }
  return { fetch, bodies }
}

const signedIn = async (): Promise<string | undefined> => 'dsk_test_token'

describe('messagesEffortFields（官方四档）', () => {
  it('off 关思考；low / high / max 开思考并写 output_config.effort；别的档与不选一格不写', () => {
    expect(DEEPSEEK_REASONING_EFFORTS).toEqual(['off', 'low', 'high', 'max'])
    expect(DEEPSEEK_DEFAULT_REASONING_EFFORT).toBe('high')
    expect(messagesEffortFields('off', undefined)).toEqual({ thinking: { type: 'disabled' } })
    for (const effort of ['low', 'high', 'max'] as const) {
      expect(messagesEffortFields(effort, undefined)).toEqual({
        thinking: { type: 'enabled' },
        output_config: { effort },
      })
    }
    expect(messagesEffortFields('medium', undefined)).toEqual({})
    expect(messagesEffortFields(undefined, undefined)).toEqual({})
    // 调用方硬要「别想」（WP243 那条）时不叠这两格
    expect(messagesEffortFields('max', 'off')).toEqual({})
  })
})

describe('经网关交到 DeepSeek 账号那一条', () => {
  const gatewayOf = (provider: ModelProvider) =>
    createModelGateway({
      providers: [provider],
      policy: policy({
        default: provider.ref,
        prices: {
          [`${provider.ref.provider}/${provider.ref.model}`]: { in: 0, out: 0, cached: 0 },
        },
      }),
      clock: fixedClock(),
      eventSink: recorder().sink,
      env: {},
    })

  it('选了「深想」（max）：请求体带 thinking enabled + output_config.effort = max', async () => {
    const { fetch, bodies } = fakeMessages()
    const gateway = gatewayOf(deepseekAccountProvider({ resolveToken: signedIn, fetch }))
    await gateway.complete({
      messages: [{ role: 'user', content: '在吗' }],
      meta: meta(),
      reasoning_effort: 'max',
    })
    expect(bodies[0]).toMatchObject({
      thinking: { type: 'enabled' },
      output_config: { effort: 'max' },
    })
  })

  it('没选：请求体一格不多（与升级前逐字节相同的那条路）', async () => {
    const { fetch, bodies } = fakeMessages()
    const gateway = gatewayOf(deepseekAccountProvider({ resolveToken: signedIn, fetch }))
    await gateway.complete({ messages: [{ role: 'user', content: '在吗' }], meta: meta() })
    expect(bodies[0]).not.toHaveProperty('thinking')
    expect(bodies[0]).not.toHaveProperty('output_config')
  })
})
