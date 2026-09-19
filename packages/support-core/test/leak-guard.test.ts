/**
 * WP125（72 §2.2 第 1 条）：教 AI 的指导原文泄漏守卫。
 *
 * 钉的是三件事：整串包含、最长公共连续子串、以及「第一次重写、再命中转人工审」。
 */
import { describe, expect, it } from 'vitest'
import {
  containsInstructionVerbatimLeak,
  evaluateLeakGuard,
  LEAK_VERBATIM_MIN_CHARS,
  leakMatchLength,
  longestCommonSubstringLength,
  normalizeForLeakCheck,
} from '../src/leak-guard.js'
import { maskAndSanitize, sanitizeForPrompt } from '../src/prompt-text.js'

describe('containsInstructionVerbatimLeak', () => {
  it('回复里照抄了商家那句中文 → 判泄漏', () => {
    const instruction = '按 14 天窗口跟他说，别提退款金额'
    expect(containsInstructionVerbatimLeak(`好的，${instruction}。`, instruction)).toBe(true)
  })

  it('换了措辞、说的是同一个意思 → 不判泄漏', () => {
    const instruction = '按 14 天窗口跟他说，别提退款金额'
    const reply = 'Our return window is 14 days from delivery. I can walk you through the steps.'
    expect(containsInstructionVerbatimLeak(reply, instruction)).toBe(false)
  })

  it('归一化空白之后再比：换行与多余空格骗不过它', () => {
    const instruction = '按 14 天窗口跟他说，别提退款金额'
    const reply = '好的：\n按 14 天窗口跟他说，\n\n别提退款金额'
    expect(containsInstructionVerbatimLeak(reply, instruction)).toBe(true)
  })

  it('短指导用整串包含判', () => {
    const short = '别提金额'
    expect(short.length).toBeLessThanOrEqual(LEAK_VERBATIM_MIN_CHARS)
    expect(containsInstructionVerbatimLeak('抱歉，别提金额，我们再确认一下', short)).toBe(true)
    expect(containsInstructionVerbatimLeak('抱歉，我们再确认一下', short)).toBe(false)
  })

  it('长指导抄一半也算（最长公共连续子串 ≥ 阈值）', () => {
    const instruction = '告诉他我们会在三个工作日内安排补发，不要承诺任何赔偿或折扣'
    const reply = '我们会在三个工作日内安排补发，稍后给你单号。'
    expect(leakMatchLength(reply, instruction)).toBeGreaterThanOrEqual(LEAK_VERBATIM_MIN_CHARS)
  })

  it('只回长度不回内容（审计行里不该出现商家原话）', () => {
    const result = evaluateLeakGuard({
      reply: '按 14 天窗口跟他说',
      instructions: ['按 14 天窗口跟他说'],
    })
    expect(result.leaked).toBe(true)
    expect(Object.values(result).every((v) => typeof v !== 'string' || v.length <= 20)).toBe(true)
  })
})

describe('evaluateLeakGuard', () => {
  it('没泄漏就发', () => {
    expect(
      evaluateLeakGuard({
        reply: 'Your refund window is 14 days.',
        instructions: ['按 14 天窗口跟他说'],
      }),
    ).toMatchObject({ leaked: false, action: 'send' })
  })

  it('第一次命中重写，再命中转人工审（不让模型试第三次）', () => {
    const instructions = ['按 14 天窗口跟他说，别提退款金额']
    const reply = '按 14 天窗口跟他说，别提退款金额'
    expect(evaluateLeakGuard({ reply, instructions }).action).toBe('rewrite')
    expect(evaluateLeakGuard({ reply, instructions, rewrites: 1 }).action).toBe('human_review')
  })
})

describe('longestCommonSubstringLength', () => {
  it('空串是 0，完全相同是全长', () => {
    expect(longestCommonSubstringLength('', 'abc')).toBe(0)
    expect(longestCommonSubstringLength('abcdef', 'abcdef')).toBe(6)
    expect(longestCommonSubstringLength('xxabcdyy', 'zzabcdzz')).toBe(4)
  })
})

describe('normalizeForLeakCheck', () => {
  it('折空白、去首尾、转小写', () => {
    expect(normalizeForLeakCheck('  Hello   \n World ')).toBe('hello world')
  })
})

describe('打码先于围栏', () => {
  it('进 prompt 的文本里没有卡号，只有标记', () => {
    const out = maskAndSanitize('Charge 4111 1111 1111 1111 please')
    expect(out.text).toContain('[redacted:card]')
    expect(out.text).not.toContain('4111')
    expect(out.masked).toEqual(['card'])
  })

  it('截断发生在打码之后：卡号不会被切成两半漏出去', () => {
    // 卡号正好骑在截断点上；先围栏再打码就会漏出半截
    const text = `${'x'.repeat(30)}4111111111111111 tail`
    expect(sanitizeForPrompt(text, 40)).not.toContain('4111')
  })
})
