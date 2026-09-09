import type { RunEvent } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  diffAddition,
  extractLessons,
  extractLessonsWithModel,
  kindOfReason,
  MODEL_CONFIDENCE_CAP,
  RULE_MAX_CHARS,
  STRENGTH_CONFIDENCE,
} from '../src/index.js'
import { extractInput } from './helpers.js'

const decision = (over: Record<string, unknown> = {}) => ({
  approval_item_id: 'ai_1',
  action: 'reject' as const,
  at: '2026-09-07T10:00:00.000Z',
  ...over,
})

describe('24 §2 lesson 抽取：驳回原因是最强信号', () => {
  it('驳回 + 原因 → strong 的一条规则，证据里是人的原话与卡 id', () => {
    const out = extractLessons(
      extractInput({ decisions: [decision({ reason: '退货窗口要从送达日算，不是下单日' })] }),
    )
    expect(out).toHaveLength(1)
    const lesson = out[0]
    expect(lesson?.signal).toBe('reject')
    expect(lesson?.strength).toBe('strong')
    expect(lesson?.kind).toBe('rule')
    expect(lesson?.confidence).toBe(STRENGTH_CONFIDENCE.strong)
    expect(lesson?.evidence[0]).toMatchObject({
      quote: '退货窗口要从送达日算，不是下单日',
      approval_item_id: 'ai_1',
      run_id: 'run_0001',
    })
  })

  it('驳回没写原因 → 不抽（没有证据就没有 lesson）', () => {
    expect(extractLessons(extractInput({ decisions: [decision({ reason: '   ' })] }))).toEqual([])
    expect(extractLessons(extractInput({ decisions: [decision()] }))).toEqual([])
  })

  it('原因里带否定词 → 反例而不是规则', () => {
    expect(kindOfReason('不要提补偿')).toBe('anti_example')
    expect(kindOfReason("Don't promise a refund")).toBe('anti_example')
    expect(kindOfReason('先确认收到')).toBe('rule')
  })

  it('过长的原话截断到 240 字以内', () => {
    const long = 'a '.repeat(400)
    const out = extractLessons(extractInput({ decisions: [decision({ reason: long })] }))
    expect((out[0]?.text ?? '').length).toBeLessThanOrEqual(RULE_MAX_CHARS)
    expect(out[0]?.text.endsWith('…')).toBe(true)
  })
})

describe('编辑差异 → 改法', () => {
  it('只取 after 里新增的行', () => {
    expect(diffAddition('第一句\n第二句', '第一句\n第二句\n第三句')).toBe('第三句')
    expect(diffAddition(undefined, '整段是新的')).toBe('整段是新的')
    expect(diffAddition('一样的', '一样的')).toBe('一样的')
  })

  it('抽成 edit_diff / example / strong', () => {
    const out = extractLessons(
      extractInput({
        decisions: [
          decision({
            action: 'approve_edited',
            edit_diff: {
              before: '开头写 Dear customer',
              after: '开头写 Dear customer\n开头直接叫名字',
            },
          }),
        ],
      }),
    )
    expect(out[0]).toMatchObject({ signal: 'edit_diff', kind: 'example', text: '开头直接叫名字' })
  })

  it('after 为空 → 不抽', () => {
    const out = extractLessons(
      extractInput({ decisions: [decision({ edit_diff: { before: 'x', after: '  ' } })] }),
    )
    expect(out).toEqual([])
  })
})

describe('指导与边界', () => {
  it('similar_cases 的指导 → 一条规则', () => {
    const out = extractLessons(
      extractInput({
        decisions: [
          decision({
            action: 'approve',
            instruction: { scope: 'similar_cases', text: '以后类似情况都先给一句我看到你的订单了' },
          }),
        ],
      }),
    )
    expect(out[0]).toMatchObject({ signal: 'redirect', kind: 'rule' })
  })

  it('single_reply / global_rule 的指导不进学习回路', () => {
    for (const scope of ['single_reply', 'global_rule'] as const) {
      const out = extractLessons(
        extractInput({
          decisions: [decision({ action: 'approve', instruction: { scope, text: '就这一条' } })],
        }),
      )
      expect(out).toEqual([])
    }
  })

  it('边界答案 → boundary', () => {
    const out = extractLessons(
      extractInput({
        decisions: [
          decision({
            action: 'approve',
            boundary: { id: 'b1', question: '物流丢件怎么办？', answer: '先补发，不退款' },
          }),
        ],
      }),
    )
    expect(out[0]).toMatchObject({ kind: 'boundary', signal: 'redirect' })
    expect(out[0]?.text).toContain('先补发')
  })
})

describe('运行内摩擦与反思', () => {
  const failures = (n: number, tool = 'get_order'): RunEvent[] => {
    const out: RunEvent[] = []
    for (let i = 0; i < n; i += 1) {
      out.push({ type: 'tool.call', call_id: `c${i}`, tool, input: {} })
      out.push({ type: 'tool.result', call_id: `c${i}`, status: 'error', reason: 'not_found' })
    }
    return out
  }

  it('同一工具失败 3 次 → 一条 medium 反例；2 次不算', () => {
    expect(extractLessons(extractInput({ events: failures(2) }))).toEqual([])
    const out = extractLessons(extractInput({ events: failures(3) }))
    expect(out[0]).toMatchObject({ signal: 'tool_retry', kind: 'anti_example', strength: 'medium' })
    expect(out[0]?.text).toContain('get_order')
  })

  it('没有 tool.call 配对时按 call_id 计（不丢信号）', () => {
    const events: RunEvent[] = [
      { type: 'tool.result', call_id: 'orphan', status: 'blocked' },
      { type: 'tool.result', call_id: 'orphan', status: 'blocked' },
      { type: 'tool.result', call_id: 'orphan', status: 'blocked' },
    ]
    expect(extractLessons(extractInput({ events }))[0]?.text).toContain('orphan')
  })

  it('反思是弱信号，置信度不超过它那一档', () => {
    const out = extractLessons(
      extractInput({
        reflections: [
          {
            id: 'l1',
            run_id: 'run_0001',
            assignment_id: 'asg_1',
            skill: 'customer-care',
            section_id: 'sec_x',
            signal: 'reflection',
            strength: 'weak',
            text: '这次没引用退货窗口那一条',
            confidence: 0.95,
          },
          {
            id: 'l2',
            run_id: 'run_0001',
            assignment_id: 'asg_1',
            skill: 'customer-care',
            signal: 'reflection',
            strength: 'weak',
            text: '  ',
            confidence: 0.5,
          },
        ],
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.confidence).toBe(STRENGTH_CONFIDENCE.weak)
    expect(out[0]?.applies_to.section_id).toBe('sec_x')
  })
})

describe('同一次抽取里的去重', () => {
  it('两张卡说了同一句话 → 一条 lesson，证据两条', () => {
    const out = extractLessons(
      extractInput({
        decisions: [
          decision({ approval_item_id: 'ai_1', reason: '先看退货窗口，再谈退款' }),
          decision({
            approval_item_id: 'ai_2',
            reason: '先看退货窗口再谈退款',
            at: '2026-09-07T11:00:00.000Z',
          }),
        ],
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.evidence).toHaveLength(2)
  })
})

describe('模型抽取只能补，不能盖', () => {
  it('规则版已有的键被丢掉；模型的置信度被夹到 medium 以下', async () => {
    const input = extractInput({ decisions: [decision({ reason: '先看退货窗口，再谈退款' })] })
    const out = await extractLessonsWithModel(input, async () => [
      { text: '先看退货窗口再谈退款', kind: 'rule' as const, confidence: 0.99 },
      { text: '客户情绪激动时先共情', kind: 'rule' as const, confidence: 0.99 },
      { text: '  ', kind: 'rule' as const },
      { text: '客户情绪激动时先共情', kind: 'rule' as const },
    ])
    expect(out).toHaveLength(2)
    expect(out[0]?.signal).toBe('reject')
    expect(out[1]?.signal).toBe('reflection')
    expect(out[1]?.confidence).toBeLessThanOrEqual(MODEL_CONFIDENCE_CAP)
  })

  it('模型能指定段与原话', async () => {
    const out = await extractLessonsWithModel(extractInput(), async () => [
      { text: '写清币种', kind: 'rule' as const, section_id: 'sec_9', quote: '金额要写 USD' },
    ])
    expect(out[0]?.applies_to.section_id).toBe('sec_9')
    expect(out[0]?.evidence[0]?.quote).toBe('金额要写 USD')
  })
})
