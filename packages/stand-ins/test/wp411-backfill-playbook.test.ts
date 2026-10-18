/**
 * WP411（#13）：stub 的「按时间窗回补」剧本——「把 10-11 到 10-16 外部补一下」→ 先带 preview 拿那一句计划，
 * 再照做；回话先说「要补 X 天，约 N 页，在你浏览器里读」，再说各块补进几条；补不了说原因与能做的（不说 0 条）。
 * 工具定义三个运行时同一份：since / until / preview 都在 `run_watch_now` 的参数表里。
 */
import { describe, expect, it } from 'vitest'
import {
  backfillAnswer,
  backfillAsk,
  createStubRuntime,
  REPORT_TOOL_DEF_BY_NAME,
  WATCH_TOOL_NAMES,
} from '../src/index.js'
import { makeRequest, runAndCollect } from './helpers.js'

const clock = { now: () => '2026-10-18T04:00:00.000Z' }
const ASK = '把 Reddit 外部 10-11 到 10-16 的补一下'
const PLAN = {
  ok: true,
  preview: true,
  say: '要补 6 天（10/11–10/16），约 9 页，在你浏览器里读（插件借品牌号只读，不扣积分）。',
}

const req = (text: string) =>
  makeRequest({
    roleId: 'social.reddit',
    threadSubject: text,
    threadBody: text,
    allow: [...WATCH_TOOL_NAMES],
    outputs: ['answer'],
  })

describe('回补剧本', () => {
  it('认日期：10-11 到 10-16、10/11–10/16、10月11日到10月16日；没在要补 / 工具面里没有就不走', () => {
    const allow = [...WATCH_TOOL_NAMES]
    const want = { since: '2026-10-11', until: '2026-10-16' }
    expect(backfillAsk(allow, ASK, clock.now())).toEqual(want)
    expect(backfillAsk(allow, '补搜 10/11–10/16 的帖子', clock.now())).toEqual(want)
    expect(backfillAsk(allow, '10月11日到10月16日的外部补齐', clock.now())).toEqual(want)
    expect(backfillAsk(allow, '看看 10-11 到 10-16 的数据', clock.now())).toBeUndefined()
    expect(backfillAsk(['query_watch_items'], ASK, clock.now())).toBeUndefined()
  })

  it('先看计划、再照做；回话先说那一句、再说各块补进几条，不露工具名', async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = []
    const runtime = createStubRuntime({
      clock,
      executeTool: async (call) => {
        calls.push({ name: call.name, input: call.input })
        if (call.input.preview === true) return { status: 'ok', data: PLAN }
        return {
          status: 'ok',
          data: {
            ok: true,
            say: PLAN.say,
            parts: [{ part: 'external', status: 'ok', fresh: 4, filtered: 9 }],
          },
        }
      },
    })
    const { result } = await runAndCollect(runtime, req(ASK))
    expect(calls).toEqual([
      {
        name: 'run_watch_now',
        input: { platform: 'reddit', since: '2026-10-11', until: '2026-10-16', preview: true },
      },
      {
        name: 'run_watch_now',
        input: { platform: 'reddit', since: '2026-10-11', until: '2026-10-16' },
      },
    ])
    const answer = result.outputs.find((o) => o.kind === 'answer')
    const text = answer?.kind === 'answer' ? answer.text : ''
    expect(text.startsWith(PLAN.say)).toBe(true)
    expect(text).toContain('外部社区：新补进 4 条，丢掉不相关的 9 条')
    expect(text).not.toContain('run_watch_now')
  })

  it('补不了：说原因和能做的，不照做', async () => {
    const calls: string[] = []
    const runtime = createStubRuntime({
      clock,
      executeTool: async (call) => {
        calls.push(call.name)
        return {
          status: 'ok',
          data: {
            ok: false,
            message: '补不了：插件还没配对。',
            can: '打开 Chrome 配好插件再说一次。',
          },
        }
      },
    })
    const { result } = await runAndCollect(runtime, req(ASK))
    expect(calls).toEqual(['run_watch_now'])
    const answer = result.outputs.find((o) => o.kind === 'answer')
    expect(answer?.kind === 'answer' ? answer.text : '').toBe(
      '补不了：插件还没配对。\n能做的：打开 Chrome 配好插件再说一次。',
    )
    expect(backfillAnswer({ ok: true, say: 'x' }, { ok: false, message: '超时' })).toContain(
      '没补成：超时',
    )
  })

  it('三个运行时同一份定义：run_watch_now 带 since / until / preview', () => {
    const def = REPORT_TOOL_DEF_BY_NAME.get('run_watch_now')
    const props = (def?.input_schema as { properties: Record<string, { type: string }> }).properties
    expect(props.since?.type).toBe('string')
    expect(props.until?.type).toBe('string')
    expect(props.preview?.type).toBe('boolean')
    expect(def?.description).toContain('在你浏览器里读')
  })
})
