/**
 * WP179：direct 这一档的官方网页工具——**经工具桥**。
 *
 * 工具面里有 `web_search` / `web_fetch`（名字与参数照官方），执行交给宿主的 `executeTool`；
 * 次数上限与"这次运行开没开"与 stub / dsh 同一份判定。规则脑（模拟的模型替身）走
 * "先搜 → 抓第一条 → 列来源"。没开网页工具的运行一个字节不变。
 */
import type { RunRequest, RunWeb } from '@agentsws/contracts'
import { DEFAULT_WEB_LIMITS } from '@agentsws/contracts'
import { standInWebFetch, standInWebSearch, urlsIn, webQueriesOf } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { aftersalesBrain, assembleDirect } from '../src/index.js'
import { clock, contextItem, eventsOf, harness, makeRequest } from './helpers.js'

const ASK = '查一下 2026 年 65W 氮化镓充电器的新品和价格'
const WEB: RunWeb = { search: true, fetch: true, ...DEFAULT_WEB_LIMITS }

function webRequest(web: RunWeb | undefined = WEB): RunRequest {
  return makeRequest({
    actor: { person_id: 'p_li', assignment_id: 'asg_content', role_id: 'dtc.content' },
    grounding: [],
    tools: {
      allow: ['web_fetch', 'web_search'],
      connect_token: 'tok',
      side_effect_policy: 'executor',
    },
    expectations: { outputs: ['answer'], must_stage_if_change_requested: false },
    context: [
      contextItem({
        id: 'brief_1',
        kind: 'thread',
        source_ref: { type: 'matter', id: 'mat_1' },
        content: { subject: ASK, participants: [], text: ASK },
      }),
    ],
    ...(web === undefined ? {} : { web }),
  })
}

const WEB_TOOLS = {
  web_search: (input: Record<string, unknown>) => ({
    status: 'ok' as const,
    data: standInWebSearch(webQueriesOf(input)[0] ?? ''),
  }),
  web_fetch: (input: Record<string, unknown>) => ({
    status: 'ok' as const,
    data: standInWebFetch(String(input.url)),
  }),
}

describe('WP179 direct：网页工具经工具桥', () => {
  it('工具面里有两个官方名字；规则脑先搜、再抓第一条、最后列来源网址', async () => {
    const h = harness({ script: aftersalesBrain({ clock: clock() }), tools: WEB_TOOLS })
    const result = await h.run(webRequest())
    expect(h.toolCalls.map((c) => c.name)).toEqual(['web_search', 'web_fetch'])
    expect(h.toolCalls[0]?.input).toEqual({ queries: [ASK] })
    const answer = result.outputs.find((o) => o.kind === 'answer')
    const text = answer?.kind === 'answer' ? answer.text : ''
    expect(urlsIn(text)).toHaveLength(3)
    expect(text).toContain('细看了第一条')
    expect(eventsOf(h.events, 'tool.result').map((e) => e.status)).toEqual(['ok', 'ok'])
    const tools = assembleDirect(webRequest()).tools.map((t) => t.name)
    expect(tools).toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
  })

  it('次数上限：超了拒这一次，宿主的工具一次都没被调到', async () => {
    const h = harness({
      script: [
        { tool_calls: [{ name: 'web_search', input: { queries: ['a', 'b'] } }] },
        { tool_calls: [{ name: 'web_search', input: { queries: ['c'] } }] },
        { text: 'done' },
      ],
      tools: WEB_TOOLS,
    })
    await h.run(webRequest({ ...WEB, max_searches: 2 }))
    expect(h.toolCalls.map((c) => c.name)).toEqual(['web_search'])
    const results = eventsOf(h.events, 'tool.result')
    expect(results.map((r) => r.status)).toEqual(['ok', 'blocked'])
    expect(results[1]?.reason).toMatch(/^web_search_limit/)
  })

  it('开关关着：名字在白名单里也拒（执行器再判一次）', async () => {
    const h = harness({
      script: [{ tool_calls: [{ name: 'web_fetch', input: { url: 'https://example.com' } }] }],
      tools: WEB_TOOLS,
    })
    await h.run(webRequest({ ...WEB, fetch: false }))
    expect(h.toolCalls).toEqual([])
    expect(eventsOf(h.events, 'tool.result')[0]?.reason).toMatch(/^web_not_enabled/)
  })

  it('没开网页工具的运行：规则脑照原来那条路走（不搜）', async () => {
    const h = harness({ script: aftersalesBrain({ clock: clock() }), tools: WEB_TOOLS })
    const req = webRequest(undefined)
    await h.run({ ...req, tools: { ...req.tools, allow: [] } })
    expect(h.toolCalls.map((c) => c.name)).not.toContain('web_search')
  })
})
