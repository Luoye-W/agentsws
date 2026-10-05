/**
 * WP220：只读 Reddit 工具（`read_reddit`）的执行器。上游全用替身：接口中台是一个假的 `callData`，
 * 浏览器只读是一个假的单独会话。钉住：按设置的顺序走、某一路不行自动试下一路、两路都不行照实说
 * （不当错误抛）、限速跨调用记得住、入参不对回一句人话。
 */
import { ApiError } from '@agentsws/api'
import type { DataCallResult, DataSourceRoute, RunRequest } from '@agentsws/contracts'
import { DEFAULT_REDDIT_BROWSER_READ_LIMITS } from '@agentsws/contracts'
import { classifySideEffect } from '@agentsws/dsh-adapter'
import type { BrowserAction, RedditReadBrowser } from '@agentsws/social-core'
import { describe, expect, it } from 'vitest'
import { createResearchToolExecutor, redditReadRequestOf } from '../src/research-tools.js'

const NOW = Date.parse('2026-10-05T12:00:00.000Z')
const request = {} as RunRequest

function browser(): RedditReadBrowser & { opened: BrowserAction[] } {
  const opened: BrowserAction[] = []
  return {
    opened,
    session: () => ({ kind: 'readonly_isolated', id: 's1' }),
    run: async (a) => {
      opened.push(a)
      return {
        status: 'ok',
        items: [{ url: 'https://www.reddit.com/r/a/comments/1/x/', title: 'INMO' }],
      }
    },
  }
}

function exec(opts: {
  route?: DataSourceRoute
  callData?: (c: string, i: Record<string, unknown>) => Promise<DataCallResult>
  browser?: RedditReadBrowser
  clock?: { ms: number }
}) {
  const clock = opts.clock ?? { ms: NOW }
  const b = opts.browser
  return createResearchToolExecutor({
    route: () => opts.route ?? { order: ['workshop', 'browser_readonly'], disabled: [] },
    limits: () => DEFAULT_REDDIT_BROWSER_READ_LIMITS,
    ...(opts.callData === undefined ? {} : { callData: opts.callData }),
    ...(b === undefined ? {} : { browser: () => b }),
    nowMs: () => clock.ms,
  })
}

const SEARCH = {
  name: 'read_reddit',
  input: { action: 'search', query: 'INMO', time_window: 'week' },
  request,
}

describe('WP220 read_reddit 执行器', () => {
  it('接口中台成了：回条目 + 来源（哪一路、命中缓存）', async () => {
    const run = exec({
      callData: async (capability, input) => {
        expect(capability).toBe('social.reddit.search')
        expect(input).toEqual({ query: 'INMO', time_window: 'week' })
        return {
          capability,
          items: [{ url: 'https://www.reddit.com/r/a/comments/9/y/', title: 'INMO Air3' }],
          quantity: 1,
          credits: 0.2,
          cached: true,
          fetched_at: '2026-10-05T11:00:00.000Z',
          source: 'official',
        }
      },
    })
    const got = await run(SEARCH)
    expect(got.status).toBe('ok')
    expect(got.data).toMatchObject({ rows: 1, source: { route: 'workshop', cached: true } })
  })

  it('接口中台没开通 → 落浏览器只读；云上那句人话记进来源', async () => {
    const b = browser()
    const run = exec({
      callData: async () => {
        throw new ApiError('not_implemented', '这项数据还没有开通。')
      },
      browser: b,
    })
    const got = await run(SEARCH)
    expect(got.data).toMatchObject({ rows: 1, source: { route: 'browser_readonly' } })
    const attempts = (got.data as { source: { attempts: { outcome: string; message?: string }[] } })
      .source.attempts
    expect(attempts[0]).toEqual({
      route: 'workshop',
      outcome: 'not_configured',
      message: '这项数据还没有开通。',
    })
    expect(b.opened[0]?.writes).toBe(false)
  })

  it('两路都不行（没关联、这台机器没有只读浏览器）：照实说，不当错误抛', async () => {
    const run = exec({
      callData: async () => {
        throw new ApiError('not_implemented', '先去关联一次账号。')
      },
    })
    const got = await run(SEARCH)
    expect(got.status).toBe('ok')
    expect(got.data).toMatchObject({ rows: 0, items: [], source: { route: 'none' } })
    expect((got.data as { missing: string }).missing).toContain('这不等于没人在聊')
  })

  it('品牌把接口中台停了：一次都不调它', async () => {
    let called = 0
    const run = exec({
      route: { order: ['workshop', 'browser_readonly'], disabled: ['workshop'] },
      callData: async () => {
        called++
        throw new Error('不该调到这里')
      },
      browser: browser(),
    })
    const got = await run(SEARCH)
    expect(called).toBe(0)
    expect(got.data).toMatchObject({ source: { route: 'browser_readonly' } })
  })

  it('限速跨调用记得住：20 秒内第二次不开页', async () => {
    const b = browser()
    const run = exec({ route: { order: ['browser_readonly'], disabled: [] }, browser: b })
    await run(SEARCH)
    const second = await run(SEARCH)
    expect(b.opened).toHaveLength(1)
    expect(second.data).toMatchObject({ rows: 0, source: { route: 'none' } })
  })

  it('入参不对回一句人话；别的工具名不认', async () => {
    expect(redditReadRequestOf({ action: 'post' })).toEqual({
      error: 'action 只能是 search / posts / comments。',
    })
    expect(redditReadRequestOf({ action: 'search' })).toEqual({
      error: '搜帖子要给 query（搜什么）。',
    })
    expect(
      redditReadRequestOf({
        action: 'comments',
        post_url: 'https://www.reddit.com/r/a/comments/1/',
      }),
    ).toMatchObject({
      capability: 'social.reddit.comments',
    })
    const run = exec({})
    expect((await run({ name: 'submit_post', input: {}, request })).status).toBe('error')
  })

  it('门禁把它判成「只读外部」（公司端也调得动，它不写任何东西）', () => {
    expect(classifySideEffect('read_reddit')).toBe('read_external')
  })
})
