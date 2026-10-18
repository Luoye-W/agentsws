/**
 * WP423：预算到了也要交东西、没交东西就催——三个运行时共用的判定与 stub 的「预算到了」剧本。
 */
import type { RunRequest } from '@agentsws/contracts'
import { DEFAULT_WEB_LIMITS } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  budgetStopReason,
  createStubRuntime,
  describeRun,
  finalizeWrapUp,
  GENERAL_MAX_NUDGES,
  isWrapUpPrompt,
  renderWrapUp,
  shouldNudgeGeneral,
  standInWebFetch,
  standInWebSearch,
  urlsIn,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  WEB_WRAP_UP_MISSING_FETCH,
  WRAP_UP_STEP,
  webQueriesOf,
  wrapUpFallback,
  wrapUpPrompt,
  wrapUpUsable,
  wrapUpWhichOf,
} from '../src/index.js'
import { makeRequest, runAndCollect } from './helpers.js'

const OPENER = '我先上网查，把版面和数据核实清楚，再和你一起挑选。'

describe('收尾那一段', () => {
  it('10-19 那句开场白不能当收尾交出去；空话、假工具调用文字也不能', () => {
    expect(wrapUpUsable(OPENER)).toBe(false)
    expect(wrapUpUsable('')).toBe(false)
    expect(wrapUpUsable('[calling web_search {"q":"x"}]')).toBe(false)
    expect(wrapUpUsable('查到 5 个版面：r/a、r/b……还差 3 个帖子没挑。\n<next>接着做</next>')).toBe(
      true,
    )
  })

  it('换成照实拼的那一段：为什么停、做了什么（人话，不露工具名）、还差、接着做', () => {
    const text = finalizeWrapUp(OPENER, {
      which: 'max_tokens',
      readTools: ['web_search', 'web_search', 'web_fetch'],
      said: OPENER,
    })
    expect(text.startsWith(budgetStopReason('max_tokens'))).toBe(true)
    expect(text).toContain('共 3 次')
    expect(text).toContain('接着做')
    expect(text).not.toContain(OPENER)
    expect(text).not.toMatch(/web_search|web_fetch|max_tokens/)
    expect(wrapUpFallback({ which: 'max_turns', readTools: [] })).toContain('还没来得及查到东西')
  })

  it('收尾提示认得回是哪一项；别的话不是收尾提示', () => {
    for (const which of ['max_tokens', 'max_tool_calls', 'max_turns', 'max_seconds'] as const) {
      expect(isWrapUpPrompt(wrapUpPrompt(which))).toBe(true)
      expect(wrapUpWhichOf(wrapUpPrompt(which))).toBe(which)
    }
    expect(wrapUpWhichOf('接着做')).toBeUndefined()
    expect(wrapUpPrompt('max_tokens')).toContain('不能再调用任何工具')
  })

  it('摘要说人话原因（不露键名）', () => {
    const s = describeRun({ readTools: [], drafted: false, reply: '好的', exhausted: 'max_tokens' })
    expect(s).toContain('查的东西太多')
    expect(s).not.toContain('max_tokens')
  })
})

describe('没交东西就催（普通运行）', () => {
  const base = { text: OPENER, hasTools: true, delivered: false, nudges: 0 }
  it('开场白、有工具、没交东西 → 催；最多 2 次', () => {
    expect(GENERAL_MAX_NUDGES).toBe(2)
    expect(shouldNudgeGeneral(base)).toBe(true)
    expect(shouldNudgeGeneral({ ...base, nudges: 1 })).toBe(true)
    expect(shouldNudgeGeneral({ ...base, nudges: 2 })).toBe(false)
  })
  it('已经交了东西、没有工具可调、话是正经答复、空话 → 都不催', () => {
    expect(shouldNudgeGeneral({ ...base, delivered: true })).toBe(false)
    expect(shouldNudgeGeneral({ ...base, hasTools: false })).toBe(false)
    expect(shouldNudgeGeneral({ ...base, text: '订单已签收，还在退货窗口内。' })).toBe(false)
    expect(shouldNudgeGeneral({ ...base, text: '' })).toBe(false)
  })
})

describe('stub 剧本：查资料查到一半预算到了', () => {
  const ASK = '查一下 2026 年 65W 氮化镓充电器的新品和价格'
  const request = (maxToolCalls: number): RunRequest => {
    const base = makeRequest({
      roleId: 'dtc.content',
      threadSubject: ASK,
      threadBody: ASK,
      allow: [WEB_FETCH_TOOL, WEB_SEARCH_TOOL],
      outputs: ['answer'],
      maxToolCalls,
    })
    return { ...base, web: { search: true, fetch: true, ...DEFAULT_WEB_LIMITS } }
  }
  const runtime = createStubRuntime({
    clock: { now: () => '2026-09-29T04:00:00.000Z' },
    executeTool: async (call) =>
      call.name === WEB_SEARCH_TOOL
        ? { status: 'ok', data: standInWebSearch(webQueriesOf(call.input)[0] ?? '') }
        : { status: 'ok', data: standInWebFetch(String(call.input.url)) },
  })

  it('搜完一次就到上限：交出已经搜到的来源 + 为什么停 + 还差细看第一条 + 接着做', async () => {
    const { result, events } = await runAndCollect(runtime, request(1))
    expect(result.status).toBe('budget_exhausted')
    expect(events.some((e) => e.type === 'progress' && e.step === WRAP_UP_STEP)).toBe(true)
    const answer = result.outputs.find((o) => o.kind === 'answer')
    const text = answer?.kind === 'answer' ? answer.text : ''
    expect(text.startsWith(budgetStopReason('max_tool_calls'))).toBe(true)
    expect(urlsIn(text)).toHaveLength(3)
    expect(text).toContain(WEB_WRAP_UP_MISSING_FETCH)
    expect(text).toContain('<next>接着做</next>')
    expect(wrapUpUsable(text)).toBe(true)
  })

  it('预算够：照旧那一段（没有收尾的字）', async () => {
    const { result, events } = await runAndCollect(runtime, request(30))
    expect(result.status).toBe('completed')
    expect(events.some((e) => e.type === 'progress' && e.step === WRAP_UP_STEP)).toBe(false)
    const answer = result.outputs.find((o) => o.kind === 'answer')
    expect(answer?.kind === 'answer' && answer.text).not.toContain('先停在这里')
  })

  it('renderWrapUp 的形状：原因开头、查到的在中间、接着做收尾', () => {
    const text = renderWrapUp({
      which: 'max_tokens',
      body: '搜了「x」，找到 1 条来源：\n- https://e.x/1',
    })
    const lines = text.split('\n')
    expect(lines[0]).toContain(budgetStopReason('max_tokens'))
    expect(lines.at(-1)).toBe('<next>接着做</next>')
  })
})
