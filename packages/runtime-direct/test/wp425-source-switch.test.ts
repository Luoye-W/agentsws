/**
 * WP425：direct 运行时——网关把这一轮从自己的 AI 切到了工坊积分时，运行记录里照实一行
 * （`progress.step = model_source_switched`，与 dsh 同一个名字）；开关关着停下时，摘要就是那一句。
 */
import type { ModelProvider, ModelRef } from '@agentsws/contracts'
import { MODEL_SOURCE_SWITCHED_STEP } from '@agentsws/contracts'
import { createModelGateway, ProviderError } from '@agentsws/model-gateway'
import { describe, expect, it } from 'vitest'
import { clock, eventsOf, harness, MODEL } from './helpers.js'

const BACKUP: ModelRef = { provider: 'workshop', model: 'scripted-v1', region: 'cn' }

const gatewayWith = (c: ReturnType<typeof clock>, enabled: boolean) => {
  let ownCalls = 0
  const own: ModelProvider = {
    ref: MODEL,
    async complete() {
      ownCalls += 1
      throw new ProviderError('provider http 429', { status: 429 })
    },
  }
  const backup: ModelProvider = {
    ref: BACKUP,
    async complete() {
      return {
        text: 'done',
        usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost_base: 0 },
      }
    },
  }
  const gateway = createModelGateway({
    providers: [own, backup],
    policy: {
      default: MODEL,
      prices: {
        'stub/scripted-v1': { in: 1, out: 2, cached: 0.1 },
        'workshop/scripted-v1': { in: 1, out: 2, cached: 0.1 },
      },
      source_fallback: { to: BACKUP, enabled, labels: { stub: 'ChatGPT' } },
    },
    clock: c,
    env: {},
    eventSink: () => {},
  })
  return { gateway, ownCalls: () => ownCalls }
}

describe('WP425 direct：切到工坊积分照实记一行', () => {
  it('主用 429 → 这一轮用工坊积分跑完，运行记录里一行原因', async () => {
    const c = clock()
    const { gateway } = gatewayWith(c, true)
    const h = harness({ script: [], clock: c, gateway, toolChoice: false })
    const result = await h.run()
    expect(result.status).toBe('completed')
    const lines = eventsOf(h.events, 'progress').filter(
      (e) => e.step === MODEL_SOURCE_SWITCHED_STEP,
    )
    expect(lines.map((e) => e.note)).toEqual(['你的 ChatGPT 额度用完了，这一轮用工坊积分'])
  })

  it('开关关着 → 照实停下，摘要就是那一句（说清原因与开关）', async () => {
    const c = clock()
    const { gateway } = gatewayWith(c, false)
    const h = harness({ script: [], clock: c, gateway, toolChoice: false })
    const result = await h.run()
    expect(result.status).toBe('failed')
    expect(result.summary).toBe(
      '你的 ChatGPT 额度用完了。「自己的用不了时用工坊积分接着做」关着，这一轮先停下',
    )
  })
})
