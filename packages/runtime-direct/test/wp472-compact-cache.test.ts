/**
 * WP472（docs/116 §6 B，决策 1550）：不用浏览器那一档的压缩——阈值按模型窗口定、一次压一大截。
 *
 * 以前历史一过 1.2 万，之后每一步都把最早一条工具结果换成占位：过线后每一步的请求都和上一步不再是「前缀 + 新增」，
 * 整段历史每步按全价付。现在：一次压到阈值的七成，之后好几步只往后加。
 */
import type { ChatMessage } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { COMPACT_CAP_TOKENS, compactLimitFor, DEFAULT_CONTEXT_WINDOW } from '../src/index.js'
import { eventsOf, harness, makeRequest } from './helpers.js'

describe('compactLimitFor：阈值按模型窗口', () => {
  it('窗口拿不到按 64K 的六成；大窗口封顶 9.6 万；不超过预算的六成', () => {
    expect(compactLimitFor({ max_tokens: 1_000_000 })).toBe(
      Math.floor(DEFAULT_CONTEXT_WINDOW * 0.6),
    )
    expect(compactLimitFor({ max_tokens: 1_000_000, window: 100_000 })).toBe(60_000)
    expect(compactLimitFor({ max_tokens: 1_000_000, window: 1_000_000 })).toBe(COMPACT_CAP_TOKENS)
    expect(compactLimitFor({ max_tokens: 50_000, window: 1_000_000 })).toBe(30_000)
    // 以前的 1.2 万线没了
    expect(compactLimitFor({ max_tokens: 150_000 })).toBeGreaterThan(12_000)
  })
})

/** 每次都回一大段（约 2 千 token）的读工具。 */
const BIG = 'row '.repeat(2_000)
const STEPS = 14

describe('长运行：一次压一大截，之后每一步的请求都是上一步的前缀 + 新增', () => {
  it('窗口 2 万（阈值 1.2 万）、14 步每步读约 2 千 token：两次压缩之间至少隔两步；没压的那几步逐条是前缀', async () => {
    const seen: ChatMessage[][] = []
    const h = harness({
      script: ({ messages, turn }) => {
        seen.push(structuredClone(messages))
        return turn < STEPS
          ? { tool_calls: [{ name: 'list_orders', input: { page: turn } }] }
          : { text: '查完了。' }
      },
      tools: { list_orders: () => ({ status: 'ok', data: { rows: BIG } }) },
      contextWindowOf: () => 20_000,
    })
    const req = makeRequest({
      grounding: [],
      budget: {
        max_tokens: 2_000_000,
        max_tool_calls: 40,
        max_seconds: 600,
        max_cost_base: 50,
        max_turns: 30,
      },
    })
    await h.run(req)
    const compactions = eventsOf(h.events, 'progress').filter((e) => e.step === 'compact')
    expect(seen.length).toBe(STEPS + 1)
    expect(compactions.length).toBeGreaterThan(0)
    // 断了前缀的那几步（= 压了的那几步）；其余每一步都是上一步原样 + 新增
    const broke: number[] = []
    for (let k = 1; k < seen.length; k += 1) {
      const prev = seen[k - 1] ?? []
      const next = seen[k] ?? []
      if (JSON.stringify(next.slice(0, prev.length)) !== JSON.stringify(prev)) broke.push(k)
    }
    // 以前（压回刚好低于线）：一过线之后每一步都断；现在两次压缩之间至少隔两步只往后加
    const first = broke[0] ?? 0
    expect(broke.length).toBeLessThan((seen.length - first) / 2)
    for (let i = 1; i < broke.length; i += 1)
      expect((broke[i] ?? 0) - (broke[i - 1] ?? 0)).toBeGreaterThanOrEqual(2)
    const breaks = broke.length
    expect(breaks).toBe(compactions.length)
  })
})
