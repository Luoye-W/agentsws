/**
 * WP179：官方网页工具在 stub 这一档的样子——工具面、次数上限、剧本、替身后端。
 *
 * - 开了网页工具、问的是"查一下"：先搜、再抓第一条、回一段带来源网址的话（不露工具名）；
 * - 次数上限按查询条数算（与 direct / dsh 同一份 `WebUsageCounter`）；
 * - 没开网页工具的运行一个字节不变：同一句话走原来那条路。
 */
import type { RunRequest } from '@agentsws/contracts'
import { DEFAULT_WEB_LIMITS } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  assemblePrompt,
  createStubRuntime,
  standInWebFetch,
  standInWebSearch,
  urlsIn,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  WebUsageCounter,
  webQueriesOf,
  webResearchPlan,
  webToolEnabled,
} from '../src/index.js'
import { makeRequest, runAndCollect } from './helpers.js'

const clock = { now: () => '2026-09-29T04:00:00.000Z' }
const ASK = '查一下 2026 年 65W 氮化镓充电器的新品和价格'

const withWeb = (text: string, web?: Partial<NonNullable<RunRequest['web']>>): RunRequest => {
  const base = makeRequest({
    roleId: 'dtc.content',
    threadSubject: text,
    threadBody: text,
    allow: [WEB_FETCH_TOOL, WEB_SEARCH_TOOL],
    outputs: ['answer'],
  })
  return {
    ...base,
    web: { search: true, fetch: true, ...DEFAULT_WEB_LIMITS, ...web },
  }
}

describe('WP179 网页工具的判定', () => {
  it('三样都要：RunRequest.web 给了、开关开着、名字在白名单里', () => {
    const req = withWeb(ASK)
    expect(webToolEnabled(req, WEB_SEARCH_TOOL)).toBe(true)
    expect(webToolEnabled(withWeb(ASK, { fetch: false }), WEB_FETCH_TOOL)).toBe(false)
    const { web: _drop, ...noWeb } = req
    expect(webToolEnabled(noWeb as RunRequest, WEB_SEARCH_TOOL)).toBe(false)
    expect(webToolEnabled({ ...req, tools: { ...req.tools, allow: [] } }, WEB_SEARCH_TOOL)).toBe(
      false,
    )
  })

  it('次数上限按查询条数算；超了拒这一次、不截断', () => {
    const counter = new WebUsageCounter(withWeb(ASK, { max_searches: 3, max_fetches: 1 }))
    expect(counter.take(WEB_SEARCH_TOOL, { queries: ['a', 'b'] })).toBeUndefined()
    expect(counter.take(WEB_SEARCH_TOOL, { queries: ['c', 'd'] })).toMatch(/^web_search_limit/)
    expect(counter.take(WEB_SEARCH_TOOL, { queries: ['c'] })).toBeUndefined()
    expect(counter.take(WEB_FETCH_TOOL, { url: 'https://example.com' })).toBeUndefined()
    expect(counter.take(WEB_FETCH_TOOL, { url: 'https://example.com' })).toMatch(/^web_fetch_limit/)
    // 不是网页工具：不管
    expect(counter.take('get_order', {})).toBeUndefined()
    expect(webQueriesOf({ queries: [' a ', 'a', ''] })).toEqual(['a'])
  })

  it('WP220（Luoye 10-05）：reddit.com / x.com 的公开页面照常能抓，与别的站同一个次数上限', () => {
    const counter = new WebUsageCounter(withWeb(ASK, { max_fetches: 2 }))
    expect(
      counter.take(WEB_FETCH_TOOL, { url: 'https://www.reddit.com/r/a/comments/1/' }),
    ).toBeUndefined()
    expect(counter.take(WEB_FETCH_TOOL, { url: 'https://x.com/inmo/status/1' })).toBeUndefined()
    expect(counter.fetches).toBe(2)
    expect(counter.take(WEB_FETCH_TOOL, { url: 'https://www.theverge.com/a' })).toMatch(
      /^web_fetch_limit/,
    )
  })

  it('没开就拒，理由说得清', () => {
    const req = withWeb(ASK, { search: false })
    expect(new WebUsageCounter(req).take(WEB_SEARCH_TOOL, { queries: ['x'] })).toMatch(
      /^web_not_enabled/,
    )
  })
})

describe('WP179 stub 的剧本', () => {
  it('查一下：先搜、再抓第一条，回话里列来源网址、不露工具名', async () => {
    const calls: string[] = []
    const runtime = createStubRuntime({
      clock,
      executeTool: async (call) => {
        calls.push(call.name)
        if (call.name === WEB_SEARCH_TOOL) {
          const q = webQueriesOf(call.input)[0] ?? ''
          return { status: 'ok', data: standInWebSearch(q) }
        }
        if (call.name === WEB_FETCH_TOOL) {
          return { status: 'ok', data: standInWebFetch(String(call.input.url)) }
        }
        return { status: 'error', reason: 'unsupported_tool' }
      },
    })
    const { result, events } = await runAndCollect(runtime, withWeb(ASK))
    expect(calls).toEqual([WEB_SEARCH_TOOL, WEB_FETCH_TOOL])
    const answer = result.outputs.find((o) => o.kind === 'answer')
    const text = answer?.kind === 'answer' ? answer.text : ''
    expect(urlsIn(text)).toHaveLength(3)
    expect(text).toContain('细看了第一条')
    expect(text).not.toMatch(/web_search|web_fetch/)
    expect(events.filter((e) => e.type === 'tool.call')).toHaveLength(2)
  })

  it('工具面里有这两个名字、描述是人话（不是 stand-in tool 占位）', () => {
    const { tools } = assemblePrompt(withWeb(ASK))
    const search = tools.find((t) => t.name === WEB_SEARCH_TOOL)
    expect(search?.description).toMatch(/上网搜索/)
    expect(tools.find((t) => t.name === WEB_FETCH_TOOL)?.description).toMatch(/公开网页/)
  })

  it('岔口：没开网页工具、或者问的不是"查"，都不走这段剧本', () => {
    const req = withWeb(ASK)
    expect(webResearchPlan(req, ASK)).toEqual({ query: ASK, fetch: true })
    expect(webResearchPlan(req, '把这篇草稿发出去')).toBeUndefined()
    const { web: _drop, ...noWeb } = req
    expect(webResearchPlan(noWeb as RunRequest, ASK)).toBeUndefined()
  })

  it('替身后端是确定性的：同一条查询回同一组来源，抓得到的是 200、别的是 404', () => {
    expect(standInWebSearch('a')).toEqual(standInWebSearch('a'))
    const first = standInWebSearch('a').sources[0]?.url ?? ''
    expect(standInWebFetch(first).statusCode).toBe(200)
    expect(standInWebFetch('https://example.org/x').statusCode).toBe(404)
  })
})
