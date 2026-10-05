/**
 * WP236 ③⑦⑨：`read_reddit` 缺 action 能推断、默认 10 条、每次运行的取数积分预算。
 *
 * 10-06 Windows 真机：模型第一次没带 action 就报错；五次搜索各取中台缺省 25 条，「看一眼」花了约 6.7 积分。
 */
import type { DataCallResult, RunRequest } from '@agentsws/contracts'
import {
  DEFAULT_DATA_CREDITS_PER_RUN,
  DEFAULT_REDDIT_BROWSER_READ_LIMITS,
  resolveDataCreditBudget,
} from '@agentsws/contracts'
import { RESEARCH_TOOL_DEF_BY_NAME } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import {
  createResearchToolExecutor,
  inferRedditAction,
  redditReadRequestOf,
} from '../src/research-tools.js'

const run1 = { id: 'run_1' } as RunRequest
const run2 = { id: 'run_2' } as RunRequest

/** 假中台：每条 0.05 积分，按实际条数收；记下每次要了几条。 */
function hub() {
  const asked: number[] = []
  return {
    asked,
    callData: async (
      capability: string,
      input: Record<string, unknown>,
    ): Promise<DataCallResult> => {
      const n = Number(input.limit)
      asked.push(n)
      return {
        capability,
        items: Array.from({ length: n }, (_, i) => ({
          url: `https://reddit.com/${i}`,
          title: `t${i}`,
        })),
        quantity: n,
        credits: Math.round(n * 0.05 * 100) / 100,
        cached: false,
        fetched_at: '2026-10-06T10:00:00.000Z',
        source: 'official',
      }
    },
  }
}

function exec(h: ReturnType<typeof hub>, budget?: number, price?: number) {
  return createResearchToolExecutor({
    route: () => ({ order: ['workshop'], disabled: [] }),
    limits: () => DEFAULT_REDDIT_BROWSER_READ_LIMITS,
    callData: h.callData,
    nowMs: () => Date.parse('2026-10-06T10:00:00.000Z'),
    ...(budget === undefined ? {} : { creditBudget: () => budget }),
    ...(price === undefined ? {} : { priceOf: async () => price }),
  })
}

const search = (request: RunRequest, input: Record<string, unknown> = { query: 'INMO' }) => ({
  name: 'read_reddit',
  input,
  request,
})

describe('WP236 ③ action 缺省推断', () => {
  it('有 query → search；有 subreddit → posts；有 post_url → comments', () => {
    expect(inferRedditAction({ query: 'INMO glasses' })).toBe('search')
    expect(inferRedditAction({ subreddit: 'smartglasses' })).toBe('posts')
    expect(inferRedditAction({ post_url: 'https://www.reddit.com/r/a/comments/1/' })).toBe(
      'comments',
    )
    // 搜某个版里的词：query 带 subreddit 仍是搜帖子
    expect(inferRedditAction({ query: 'INMO', subreddit: 'smartglasses' })).toBe('search')
    expect(redditReadRequestOf({ query: 'INMO' })).toMatchObject({
      capability: 'social.reddit.search',
    })
    expect(redditReadRequestOf({ subreddit: 'smartglasses' })).toMatchObject({
      capability: 'social.reddit.posts',
    })
  })

  it('什么都没给：一句人话说清要给什么；给错的 action 照旧报', () => {
    expect(redditReadRequestOf({})).toEqual({
      error: '没看出要做什么：搜帖子给 query，读一个版给 subreddit，读一条帖子的评论给 post_url。',
    })
    expect(redditReadRequestOf({ action: 'post', query: 'x' })).toEqual({
      error: 'action 只能是 search / posts / comments。',
    })
  })

  it('工具描述写清：action 可不填、默认 10 条、按条计积分、先少取', () => {
    const def = RESEARCH_TOOL_DEF_BY_NAME.get('read_reddit')
    expect(def?.description).toContain('action 可以不填')
    expect(def?.description).toContain('不填 limit 就取 10 条')
    expect(def?.description).toContain('先少取')
    expect(def?.description).toContain('换词搜别超过 3 次')
    const schema = (def?.input_schema ?? {}) as { required?: string[] }
    expect(schema.required ?? []).not.toContain('action')
  })
})

describe('WP236 ⑦ 默认 10 条', () => {
  it('不给 limit 就要 10 条；给了照给的', async () => {
    const h = hub()
    const run = exec(h)
    await run(search(run1))
    await run(search(run1, { query: 'INMO', limit: 30 }))
    expect(h.asked).toEqual([10, 30])
  })
})

describe('WP236 ⑨ 每次运行的取数积分预算', () => {
  it('缺省 3 积分；职责阈值可调（坏值回缺省）', () => {
    expect(DEFAULT_DATA_CREDITS_PER_RUN).toBe(3)
    expect(resolveDataCreditBudget(undefined)).toBe(3)
    expect(resolveDataCreditBudget({ data_credits_per_run: 10 })).toBe(10)
    expect(resolveDataCreditBudget({ data_credits_per_run: 0 })).toBe(3)
  })

  it('用到 80% 提示收尾；用完就不再取、照实说「这次取数预算用完了」；按运行分账', async () => {
    const h = hub()
    // 预算 1.2 积分，每次 10 条 = 0.5 积分
    const run = exec(h, 1.2)
    const first = await run(search(run1))
    expect(first.data).toMatchObject({ rows: 10, credits: { used: 0.5, budget: 1.2 } })
    expect((first.data as { notice?: string }).notice).toBeUndefined()
    const second = await run(search(run1))
    expect((second.data as { notice?: string }).notice).toContain('请收尾')
    const third = await run(search(run1))
    expect((third.data as { notice?: string }).notice).toContain('这次取数预算用完了')
    const fourth = await run(search(run1))
    expect(fourth.data).toMatchObject({ rows: 0, budget_exhausted: true })
    expect((fourth.data as { missing: string }).missing).toContain('这次取数预算用完了')
    expect(h.asked).toEqual([10, 10, 10])
    // 别的运行另起一本账
    const other = await run(search(run2))
    expect(other.data).toMatchObject({ rows: 10 })
    expect(h.asked).toEqual([10, 10, 10, 10])
  })

  it('知道单价时按剩下的预算收条数（一条都放不下就当用完）', async () => {
    const h = hub()
    const run = exec(h, 0.7, 0.05)
    await run(search(run1)) // 10 条 0.5
    const second = await run(search(run1)) // 只剩 0.2 → 4 条
    expect(h.asked).toEqual([10, 4])
    expect((second.data as { notice?: string }).notice).toContain('这次取数预算用完了')
    const third = await run(search(run1))
    expect(third.data).toMatchObject({ budget_exhausted: true })
    expect(h.asked).toEqual([10, 4])
  })
})
