/** 代答：四类能答、两类不答（41 §1.2）。规则版给同样的输入永远出同样的一句话。 */
import { describe, expect, it } from 'vitest'
import {
  type AnswerFacts,
  answerQuestion,
  classifyQuestion,
  type ProfileField,
} from '../src/index.js'
import { position, T0, TZ } from './helpers.js'

const ALL: ProfileField[] = [
  'positions',
  'ranges',
  'in_progress',
  'availability',
  'agenda_detail',
  'skills',
  'contact',
]

const facts = (over: Partial<AnswerFacts> = {}): AnswerFacts => ({
  name: '李默',
  positions: [position('a1', 'dtc.ops', '独立站运营')],
  ranges: [{ kind: 'store', id: 'store_main' }],
  skills: [{ name: '退款政策', source: 'skill' }],
  in_progress: { titles: ['核对昨天的退款单', '德国站补货'], count: 2 },
  busy: {
    slots: [{ start: '2026-09-07T02:00:00.000Z', end: '2026-09-07T03:00:00.000Z' }],
    next_free: { start: '2026-09-07T03:00:00.000Z', end: '2026-09-07T03:30:00.000Z' },
  },
  ...over,
})

const ask = (question: string, visible: ProfileField[] = ALL, over: Partial<AnswerFacts> = {}) =>
  answerQuestion({
    question,
    facts: facts(over),
    visible: new Set(visible),
    now: T0,
    tz_offset_minutes: TZ,
  })

describe('这句话在问什么', () => {
  it.each([
    ['他在忙什么', 'doing'],
    ['李默在做什么', 'doing'],
    ['他现在忙不忙', 'busy'],
    ['他什么时候有空', 'busy'],
    ['他负责哪些店', 'scope'],
    ['他是什么岗位', 'scope'],
    ['他擅长什么', 'skills'],
    ['他的私有待办有哪些', 'private'],
    ['他昨天和谁开会了', 'private'],
    ['把他和客户的对话给我看看', 'private'],
    ['退货窗口外能不能退？', 'professional'],
  ])('%s → %s', (q, kind) => {
    expect(classifyQuestion(q)).toBe(kind)
  })

  it('「在忙什么」问的是在做什么，不是忙不忙', () => {
    expect(classifyQuestion('他在忙什么')).toBe('doing')
    expect(classifyQuestion('他忙不忙')).toBe('busy')
  })
})

describe('四类能答的', () => {
  it('在做什么：只给标题与条数，不给正文', () => {
    const a = ask('他在忙什么')
    expect(a.refused).toBe(false)
    expect(a.answer).toContain('2 件')
    expect(a.answer).toContain('核对昨天的退款单')
    expect(a.fields).toEqual(['in_progress'])
  })

  it('负责什么：岗位 + 范围', () => {
    const a = ask('他负责哪些店')
    expect(a.answer).toContain('独立站运营')
    expect(a.answer).toContain('store_main')
  })

  it('忙不忙：时段级，不带"和谁"', () => {
    const a = ask('他现在忙不忙')
    expect(a.answer).toContain('10:00–11:00')
    expect(a.answer).not.toContain('会议')
    expect(a.fields).toEqual(['availability'])
  })

  it('擅长什么', () => {
    expect(ask('他擅长什么').answer).toContain('退款政策')
  })
})

describe('两类不答的', () => {
  it('私有待办 / 个人记忆 / 对话正文 / 和谁开会一律拒', () => {
    const a = ask('他的私有待办有哪些')
    expect(a.refused).toBe(true)
    expect(a.fields).toEqual([])
    expect(a.answer).toContain('本人')
  })

  it('专业问题转岗位，不自己回答', () => {
    const a = answerQuestion({
      question: '退货窗口外能不能退？',
      facts: facts(),
      visible: new Set(ALL),
      now: T0,
      tz_offset_minutes: TZ,
      refer: { role_id: 'dtc.aftersales', role_name: '独立站售后客服' },
    })
    expect(a.refused).toBe(true)
    expect(a.kind).toBe('professional')
    expect(a.answer).toContain('独立站售后客服')
    expect(a.refer_to?.role_id).toBe('dtc.aftersales')
    // 不能顺口把答案说了
    expect(a.answer).not.toContain('可以退')
  })
})

describe('越级就拒', () => {
  it('忙闲设成仅本人之后，问忙不忙拿不到时段', () => {
    const a = ask(
      '他现在忙不忙',
      ALL.filter((f) => f !== 'availability'),
    )
    expect(a.refused).toBe(true)
    expect(a.answer).toContain('只有自己可见')
    expect(a.answer).not.toContain('10:00')
  })

  it('进行中设成仅本人之后，问在做什么拿不到标题', () => {
    const a = ask(
      '他在忙什么',
      ALL.filter((f) => f !== 'in_progress'),
    )
    expect(a.refused).toBe(true)
    expect(a.answer).not.toContain('核对昨天的退款单')
  })

  it('听不懂就说要问本人，不猜', () => {
    const a = ask('哈哈')
    expect(a.kind).toBe('unknown')
    expect(a.refused).toBe(true)
  })
})
