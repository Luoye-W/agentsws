import { describe, expect, it } from 'vitest'
import {
  advanceByMail,
  estimateMailStage,
  judgeThreadByRules,
  mailStagePrompt,
  parseMailStage,
  reconcileStage,
  type StageMail,
  stripQuoted,
} from '../src/index.js'

const mail = (
  id: string,
  direction: 'in' | 'out',
  at: string,
  text: string,
  subject = 'Collab',
): StageMail => ({
  id,
  direction,
  at,
  subject,
  text,
})

/** 询价 → 报价 → 谈妥 → 寄样单号 → 发布链接。 */
const thread: StageMail[] = [
  mail(
    'm1',
    'out',
    '2025-01-01T00:00:00Z',
    'Hi Rosa, we love your desk setups and would love to work together. Our budget is flexible.',
  ),
  mail('m2', 'in', '2025-01-02T00:00:00Z', 'Thanks! What is your budget for one video?'),
  mail('m3', 'out', '2025-01-03T00:00:00Z', 'We can offer a flat fee of $500 plus the product.'),
  mail(
    'm4',
    'in',
    '2025-01-04T00:00:00Z',
    'Sounds good, let’s do it. Deal!\n\n> On Jan 3 you wrote:\n> We can offer',
  ),
  mail(
    'm5',
    'out',
    '2025-01-06T00:00:00Z',
    'The lamp has shipped today, tracking number 1Z999AA10123456784 via UPS.',
  ),
  mail(
    'm6',
    'in',
    '2025-01-20T00:00:00Z',
    'The video is live: https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  ),
]

describe('WP489 邮件判阶段（规则）', () => {
  it('一步一步走：每一段判出正确阶段并带依据', () => {
    const at = (n: number) => judgeThreadByRules(thread.slice(0, n))
    expect(at(1)?.stage).toBe('contacted')
    // 开发信里提「budget」不算谈价（对方还没回过话）
    expect(at(1)?.evidence[0]?.message_id).toBe('m1')
    expect(at(2)?.stage).toBe('negotiating')
    expect(at(3)?.stage).toBe('negotiating')
    expect(at(4)?.stage).toBe('agreed')
    expect(at(4)?.evidence[0]).toMatchObject({ message_id: 'm4', direction: 'in' })
    expect(at(5)?.stage).toBe('sample_sent')
    expect(at(5)?.evidence[0]?.quote).toContain('tracking number')
    const done = at(6)
    expect(done?.stage).toBe('delivered')
    expect(done?.evidence[0]).toMatchObject({ message_id: 'm6' })
    expect(done?.evidence[0]?.quote).toContain('youtube.com/watch')
  })

  it('对方最后说不做 → 谢绝；之后又谈起来 → 不算谢绝', () => {
    const no = [
      thread[0] as StageMail,
      mail('n1', 'in', '2025-01-02T00:00:00Z', 'Sorry, not interested at the moment.'),
    ]
    expect(judgeThreadByRules(no)?.stage).toBe('declined')
    const back = [
      ...no,
      mail('n2', 'in', '2025-03-01T00:00:00Z', 'Actually, could you send me a quote?'),
    ]
    expect(judgeThreadByRules(back)?.stage).toBe('negotiating')
  })

  it('去掉引用的旧信', () => {
    expect(stripQuoted('Yes!\n\nOn Mon, Jan 1 Bob wrote:\n> not interested')).toBe('Yes!')
  })
})

describe('WP489 邮件判阶段（模型）', () => {
  it('提示词把邮件围起来；依据必须是那封信里真有的句子', () => {
    const p = mailStagePrompt(thread)
    expect(p.user).toContain('<<<MAILS_START>>>')
    const good = parseMailStage(
      '{"stage":"sample_sent","evidence":[{"message":4,"quote":"The lamp has shipped today"}]}',
      thread,
    )
    expect(good).toMatchObject({
      stage: 'sample_sent',
      by: 'model',
      evidence: [{ message_id: 'm5' }],
    })
    // 编出来的依据 → 作废（调用方退回规则）
    expect(
      parseMailStage(
        '{"stage":"delivered","evidence":[{"message":4,"quote":"video is published"}]}',
        thread,
      ),
    ).toBeUndefined()
    expect(parseMailStage('{"stage":"won","evidence":[]}', thread)).toBeUndefined()
  })

  it('花费预估：每人一次调用，价目为 0 时不报金额', () => {
    const e = estimateMailStage([thread, thread.slice(0, 2)], { in: 1, out: 2 })
    expect(e.creators).toBe(2)
    expect(e.messages).toBe(8)
    expect(e.input_tokens).toBeGreaterThan(100)
    expect(e.cost).toBeGreaterThan(0)
    expect(estimateMailStage([thread], { in: 0, out: 0 }).cost).toBeUndefined()
  })
})

describe('WP489 与表格对照、实时推进', () => {
  it('表格写的 vs 邮件判的', () => {
    expect(reconcileStage(undefined, undefined, 'replied')).toBe('apply')
    expect(reconcileStage('agreed', 'import', 'agreed')).toBe('same')
    expect(reconcileStage('negotiating', 'import', 'sample_sent')).toBe('conflict')
    expect(reconcileStage('closed', 'import', 'delivered')).toBe('same')
    expect(reconcileStage('contacted', undefined, 'agreed')).toBe('apply')
    expect(reconcileStage('delivering', 'mail', 'replied')).toBe('keep')
  })

  it('新来信按全阶段往前推，不往回拉', () => {
    expect(
      advanceByMail('contacted', mail('x', 'in', '', 'Sure, what is your rate card?'))?.stage,
    ).toBe('negotiating')
    expect(advanceByMail('contacted', mail('x', 'in', '', 'Hi!'))?.stage).toBe('replied')
    expect(
      advanceByMail('agreed', mail('x', 'in', '', 'Got the package, here is the draft script.'))
        ?.stage,
    ).toBe('delivering')
    expect(advanceByMail('delivering', mail('x', 'in', '', 'What is your budget?'))).toBeUndefined()
    expect(advanceByMail('negotiating', mail('x', 'in', '', 'no'), { declined: true })?.stage).toBe(
      'declined',
    )
  })
})
