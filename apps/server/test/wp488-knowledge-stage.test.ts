/**
 * WP488（决策 1700 = B、1704 = C）：售前 / 售后由 AI 判——同一线程只问一次、出错 / 撞上限退回规则、
 * AI 说拿不准就两边都取；整批一次判完；最便宜那一档。
 */
import { describe, expect, it } from 'vitest'
import { cheapestRef, createStageJudge, type StageModel } from '../src/knowledge-stage.js'

const clock = { now: () => '2026-10-23T09:00:00.000Z' }
const WS = 'ws_1' as never

function model(answer: (prompt: string) => string, extra: Partial<StageModel> = {}) {
  const prompts: string[] = []
  const m: StageModel = {
    complete: async (p) => {
      prompts.push(p)
      return answer(p)
    },
    ...extra,
  }
  return { m, prompts }
}

describe('判一封信', () => {
  it('一律先问 AI（规则会判售前的那句，AI 说售后就是售后）；同一线程只问一次', async () => {
    const { m, prompts } = model(() => 'postsales')
    const judge = createStageJudge({ clock, model: async () => m })
    expect(await judge.judge(WS, 'How much is the 2-pack?', 'thr_1')).toBe('postsales')
    expect(await judge.judge(WS, 'And the price of the 3-pack?', 'thr_1')).toBe('postsales')
    expect(prompts).toHaveLength(1)
    expect(await judge.retrieval(WS, 'Hi', 'thr_2')).toEqual({ stage: 'postsales' })
    expect(prompts).toHaveLength(2)
  })

  it('AI 说拿不准 → 两边都取（不拿规则硬判）', async () => {
    const { m } = model(() => 'unclear')
    const judge = createStageJudge({ clock, model: async () => m })
    expect(await judge.retrieval(WS, 'Where is my order #12345?', 't')).toEqual({})
  })

  it('模型出错 / 没接 / 撞上限 → 退回规则；规则也判不出 → 两边都取', async () => {
    const boom = createStageJudge({
      clock,
      model: async () => ({
        complete: async () => {
          throw new Error('down')
        },
      }),
    })
    expect(await boom.judge(WS, 'Where is my order #12345? not arrived', 'a')).toBe('postsales')
    expect(await boom.judge(WS, 'What is your return policy?', 'b')).toBeUndefined()
    const none = createStageJudge({ clock, model: async () => undefined })
    expect(await none.judge(WS, 'How much is the bundle?', 'c')).toBe('presales')
    const { m, prompts } = model(() => 'postsales', {
      estimate: () => 0.01,
      budget: async () => ({ used: 9.995, cap: 10, frozen: false }),
    })
    const capped = createStageJudge({ clock, model: async () => m })
    expect(await capped.judge(WS, 'How much is the bundle?', 'd')).toBe('presales')
    expect(prompts).toHaveLength(0)
  })
})

describe('整批判', () => {
  it('一次调用判完、同序；回话对不上 / 出错 → undefined（调用方按规则）', async () => {
    const { m, prompts } = model(() => '{"stages":["presales","both"]}')
    const judge = createStageJudge({ clock, model: async () => m })
    expect(await judge.batch(WS, ['Q: price?', 'Q: return policy?'])).toEqual(['presales', 'both'])
    expect(prompts).toHaveLength(1)
    expect(await judge.batch(WS, ['a', 'b', 'c'])).toBeUndefined()
    const capped = createStageJudge({
      clock,
      model: async () => ({
        complete: async () => '{"stages":["both"]}',
        budget: async () => ({ used: 1, cap: 1, frozen: true }),
      }),
    })
    expect(await capped.batch(WS, ['a'])).toBeUndefined()
  })
})

describe('最便宜那一档', () => {
  it('标了价的文字模型里最便宜的；都没价用 extraction 那一档；stub 不算', () => {
    const refs = [
      { provider: 'a', model: 'big' },
      { provider: 'a', model: 'small' },
      { provider: 'b', model: 'text-embed-3' },
      { provider: 'stub', model: 'stub' },
    ]
    const prices: Record<string, { in: number; out: number }> = {
      'a/big': { in: 3, out: 15 },
      'a/small': { in: 0.2, out: 0.8 },
      'b/text-embed-3': { in: 0.01, out: 0 },
    }
    const fallback = { provider: 'a', model: 'big' }
    expect(cheapestRef(refs, (r) => prices[`${r.provider}/${r.model}`], fallback)).toEqual({
      provider: 'a',
      model: 'small',
    })
    expect(cheapestRef(refs, () => undefined, fallback)).toEqual(fallback)
    expect(cheapestRef([], () => undefined, { provider: 'stub', model: 'x' })).toBeUndefined()
  })
})
