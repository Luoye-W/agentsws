/**
 * WP428（决策 1246 改）：在线客服按置信度直接答——判定本身（纯函数）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildChatPlan,
  CHAT_ANSWER_CITE_INSTRUCTION,
  type ChatAnswerSource,
  chatAnswerStubScript,
  classifyChatTurn,
  formatChatSources,
  hasPersonalInfo,
  hasTimePromise,
  matchLearnedHold,
  parseChatAnswer,
  scoreChatAutoAnswer,
} from '../src/index.js'

const SHIPPING: ChatAnswerSource = {
  ref: 'K1',
  kind: 'fact_card',
  id: 'fc_ship',
  label: '运费',
  text: '美国订单满 $50 免邮，否则 $6.9。',
}

const plan = (text: string) =>
  buildChatPlan({ classification: classifyChatTurn(text), turn_text: text })

describe('parseChatAnswer', () => {
  it('拆出处标记、自评那一行与句子', () => {
    const p = parseChatAnswer(
      'Shipping to the US is free over $50[K1]. Otherwise it is $6.9 [K1].\n把握：88',
    )
    expect(p.self).toBe(88)
    expect(p.text).toBe('Shipping to the US is free over $50. Otherwise it is $6.9.')
    expect(p.sentences.map((s) => s.cited)).toEqual([['K1'], ['K1']])
  })
})

describe('scoreChatAutoAnswer', () => {
  const q = 'How much is shipping to the US?'

  it('知识库有、每句标了出处、数字对得上 → 直接发', () => {
    const v = scoreChatAutoAnswer({
      plan: plan(q),
      turn_text: q,
      reply: 'Shipping to the US is free over $50[K1]. Anything else I can help with?\n把握：85',
      sources: [SHIPPING],
    })
    expect(v.send).toBe(true)
    expect(v.sources_used.map((s) => s.id)).toEqual(['fc_ship'])
    expect(v.text).not.toContain('[K1]')
    expect(v.score).toBeGreaterThanOrEqual(0.7)
  })

  it('数字在出处里找不到 → 转人（不靠模型自评）', () => {
    const v = scoreChatAutoAnswer({
      plan: plan(q),
      turn_text: q,
      reply: 'Shipping to the US is free over $30[K1].\n把握：99',
      sources: [SHIPPING],
    })
    expect(v.send).toBe(false)
    expect(v.hold?.kind).toBe('low_confidence')
    expect(v.reasons.join(' ')).toContain('30')
  })

  it('没有出处 → 转人', () => {
    const v = scoreChatAutoAnswer({
      plan: plan(q),
      turn_text: q,
      reply: 'Shipping is free.\n把握：95',
      sources: [],
    })
    expect(v.send).toBe(false)
    expect(v.hold?.kind).toBe('no_source')
  })

  it('模型自评低 → 转人；自评高抬不起对不上的句子', () => {
    const low = scoreChatAutoAnswer({
      plan: plan(q),
      turn_text: q,
      reply: 'Shipping to the US is free over $50[K1].\n把握：30',
      sources: [SHIPPING],
    })
    expect(low.send).toBe(false)
    const high = scoreChatAutoAnswer({
      plan: plan(q),
      turn_text: q,
      reply: 'We ship with DHL and it is very fast.\n把握：100',
      sources: [SHIPPING],
    })
    expect(high.send).toBe(false)
  })

  it('退款 / 改单一律转人，不管把握多高', () => {
    const t = 'Can I get a refund for order #1001?'
    const v = scoreChatAutoAnswer({
      plan: plan(t),
      turn_text: t,
      reply: 'Our refund policy allows 30 days[K1].\n把握：100',
      sources: [{ ...SHIPPING, text: 'Refunds within 30 days.' }],
    })
    expect(v.send).toBe(false)
    expect(v.hold?.kind).toBe('money')
  })

  it('许了具体时间 → 转人', () => {
    const v = scoreChatAutoAnswer({
      plan: plan(q),
      turn_text: q,
      reply: "Shipping is free over $50[K1], and we'll ship it tomorrow.\n把握：90",
      sources: [SHIPPING],
    })
    expect(v.send).toBe(false)
    expect(v.reasons.join(' ')).toContain('具体时间')
  })

  it('决策 1303：访客自己留了电话 / 邮箱、回复里不带 → 照常直接答', () => {
    for (const t of ['运费多少？我电话 138 1234 5678', '美国运费多少？我邮箱 ben@example.com']) {
      const v = scoreChatAutoAnswer({
        plan: plan(t),
        turn_text: t,
        reply: '美国订单满 $50 免邮[K1]。\n把握：90',
        sources: [SHIPPING],
      })
      expect(v.hold).toBeUndefined()
      expect(v.send).toBe(true)
    }
  })

  it('回复里带出个人信息（访客的邮箱原样带回 / 订单上的姓名）→ 转人', () => {
    const t = '运费多少？我邮箱 ben@example.com'
    const echo = scoreChatAutoAnswer({
      plan: plan(t),
      turn_text: t,
      reply: '美国订单满 $50 免邮[K1]。详情发到 ben@example.com。\n把握：90',
      sources: [SHIPPING],
    })
    expect(echo.send).toBe(false)
    expect(echo.hold?.kind).toBe('personal_info')
    const order: ChatAnswerSource = {
      ref: 'O1',
      kind: 'order',
      id: '#1001',
      label: '订单 #1001',
      text: '{"status":"shipped","name":"Anna Lee"}',
      private_values: ['Anna Lee'],
    }
    const w = scoreChatAutoAnswer({
      plan: plan('where is my order #1001'),
      turn_text: 'where is my order #1001',
      reply: 'Hi Anna Lee, order #1001 has shipped[O1].\n把握：90',
      sources: [order],
    })
    expect(w.hold?.kind).toBe('personal_info')
  })

  it('同类被说过不该直接答 → 转人', () => {
    const v = scoreChatAutoAnswer({
      plan: plan(q),
      turn_text: q,
      reply: 'Shipping to the US is free over $50[K1].\n把握：90',
      sources: [SHIPPING],
      learned_holds: [{ tokens: ['x'], intent: plan(q).intent, source_ids: ['fc_ship'] }],
    })
    expect(v.hold?.kind).toBe('learned')
  })

  it('三档：同一句「宽松」能发、「严格」不发', () => {
    const input = {
      plan: plan(q),
      turn_text: q,
      reply:
        'Shipping to the US is free over $50[K1]. We also ship worldwide via several carriers.\n把握：80',
      sources: [SHIPPING],
    }
    expect(scoreChatAutoAnswer({ ...input, strictness: 'loose' }).send).toBe(false)
    const one = { ...input, reply: 'Shipping to the US is free over $50[K1].\n把握：65' }
    expect(scoreChatAutoAnswer({ ...one, strictness: 'loose' }).send).toBe(true)
    expect(scoreChatAutoAnswer({ ...one, strictness: 'strict' }).send).toBe(false)
  })
})

describe('护栏小件', () => {
  it('时间承诺 / 个人信息', () => {
    expect(hasTimePromise('我们明天就给你发货')).toBe(true)
    expect(hasTimePromise('通常 3-5 个工作日送达')).toBe(false)
    expect(hasTimePromise('Delivery usually takes 3-5 business days.')).toBe(false)
    expect(hasPersonalInfo('mail me at a@b.com')).toBe(true)
    expect(hasPersonalInfo('order #1001 shipped on 2026-10-19')).toBe(false)
  })

  it('学习回路：同一意图同一张卡，或问句重合过半', () => {
    const holds = [
      { tokens: ['shipping', 'us'], intent: 'presales_product', source_ids: ['fc_ship'] },
    ]
    expect(
      matchLearnedHold(holds, {
        turn_text: 'x',
        intent: 'presales_product',
        source_ids: ['fc_ship'],
      }),
    ).toBe(true)
    expect(
      matchLearnedHold(holds, { turn_text: 'shipping to us', intent: 'other', source_ids: [] }),
    ).toBe(true)
    expect(
      matchLearnedHold(holds, { turn_text: 'warranty length', intent: 'other', source_ids: [] }),
    ).toBe(false)
  })

  it('stub 剧本：材料对得上就照说并标出处，对不上说去确认', () => {
    const user = (visitor: string) =>
      `${formatChatSources([{ ...SHIPPING, text: '充电类产品的保修期是 24 个月。' }])}\n\n${CHAT_ANSWER_CITE_INSTRUCTION}\n\n访客说：\n${visitor}`
    const hit = chatAnswerStubScript([{ role: 'user', content: user('充电器保修多久？') }])
    expect(hit).toContain('[K1]')
    const miss = chatAnswerStubScript([{ role: 'user', content: user('你们有实体店吗') }])
    expect(miss).toContain('确认')
    expect(chatAnswerStubScript([{ role: 'user', content: 'hello' }])).toBeUndefined()
  })

  it('stub 剧本（WP471）：出处要求在系统提示里也认得出', () => {
    const hit = chatAnswerStubScript([
      { role: 'system', content: `客服。\n\n${CHAT_ANSWER_CITE_INSTRUCTION}` },
      {
        role: 'user',
        content: `材料：\n${formatChatSources([{ ...SHIPPING, text: '充电类产品的保修期是 24 个月。' }])}\n\n访客说：\n充电器保修多久？`,
      },
    ])
    expect(hit).toContain('[K1]')
  })

  it('stub 剧本（决策 1303）：访客留邮箱问运费 → 照知识卡说、直接答', () => {
    const visitor = '寄到美国运费多少？我邮箱 ben@example.com'
    const user = `${formatChatSources([SHIPPING])}\n\n${CHAT_ANSWER_CITE_INSTRUCTION}\n\n访客说：\n${visitor}`
    const reply = chatAnswerStubScript([{ role: 'user', content: user }])
    expect(reply).toContain('[K1]')
    expect(reply).not.toContain('ben@example.com')
    const v = scoreChatAutoAnswer({
      plan: plan(visitor),
      turn_text: visitor,
      reply: reply ?? '',
      sources: [SHIPPING],
    })
    expect(v.hold).toBeUndefined()
    expect(v.send).toBe(true)
  })
})
