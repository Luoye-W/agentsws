import { describe, expect, it } from 'vitest'
import {
  classifyInbound,
  classifyText,
  deriveNeeds,
  detectLanguage,
  displayLine,
  extractAmount,
  extractEntities,
  extractOrderRef,
  extractRiskTerms,
  haystack,
  inboundText,
  includesAny,
  isDeidentified,
  matchTerms,
  normalizeIntent,
  sanitizeExternal,
  unfence,
} from '../src/index.js'
import { SAMPLES, toInboundEvent } from './samples.js'

const NOW = '2026-09-07T01:00:00.000Z'

describe('入站分类（33 §1 / KefuAgent email-triage 的移植）', () => {
  for (const sample of SAMPLES) {
    it(`${sample.id}：意图 ${sample.intent}、语言 ${sample.language}`, () => {
      const c = classifyText(
        { text: sample.body, subject: sample.subject, from: sample.from },
        { now: NOW },
      )
      expect(c.intent).toBe(sample.intent)
      expect(c.language).toBe(sample.language)
      expect(c.is_customer_service).toBe(sample.is_customer_service)
      expect(c.confidence).toBeGreaterThan(0)
      expect(c.confidence).toBeLessThanOrEqual(1)
    })
  }

  it('陷阱样本：去掉陷阱那句，结论一个字都不变', () => {
    const traps = SAMPLES.filter((s) => s.trap !== undefined)
    expect(traps.length).toBeGreaterThanOrEqual(5)
    for (const sample of traps) {
      const dirty = classifyText(
        { text: sample.body, subject: sample.subject, from: sample.from },
        { now: NOW },
      )
      const clean = classifyText(
        { text: sample.clean_body ?? sample.body, subject: sample.subject, from: sample.from },
        { now: NOW },
      )
      expect(dirty.intent).toBe(clean.intent)
      expect(dirty.is_customer_service).toBe(clean.is_customer_service)
      expect(dirty.language).toBe(clean.language)
    }
  })

  it('围栏包过一层的正文与裸正文得到同一个结论', () => {
    for (const sample of SAMPLES) {
      const bare = classifyInbound(toInboundEvent(sample, false), { now: NOW })
      const fenced = classifyInbound(toInboundEvent(sample, true), { now: NOW })
      expect(fenced.intent).toBe(bare.intent)
      expect(fenced.entities).toEqual(bare.entities)
    }
  })

  it('注入的 turn 边界与特殊标记进不了匹配文本', () => {
    const trap = SAMPLES.find((s) => s.id === 'trap_injection_tags')
    if (trap === undefined) throw new Error('样本缺失')
    const cleaned = sanitizeExternal(trap.body)
    expect(cleaned).not.toContain('<system>')
    expect(cleaned).toContain('[removed]')
  })

  it('线程已被接管：后续来信直接继续，不再看词表', () => {
    const c = classifyText({ text: 'thanks!' }, { now: NOW, thread_taken_over: true })
    expect(c.classifier).toBe('thread_takeover')
    expect(c.intent).toBe('post_sales')
    expect(c.confidence).toBe(1)
    expect(c.matched_terms).toEqual([])
  })

  it('注入的模型分类覆盖规则层，但值域仍由我们裁剪', () => {
    const c = classifyText(
      { text: 'where is my package for order #4105' },
      { now: NOW, model: { intent: 'not_a_real_intent', confidence: 250, reason: '' } },
    )
    expect(c.classifier).toBe('model')
    expect(c.intent).toBe('other')
    expect(c.confidence).toBe(1)
    expect(c.reason.length).toBeGreaterThan(0)
    expect(c.is_customer_service).toBe(false)
  })

  it('模型只给了 is_customer_service 时沿用规则层的意图与置信度', () => {
    const c = classifyText(
      { text: 'where is my package for order #4105' },
      { now: NOW, model: { is_customer_service: true, reason: '模型说是' } },
    )
    expect(c.intent).toBe('order_tracking')
    expect(c.reason).toBe('模型说是')
    expect(c.confidence).toBeCloseTo(0.96)
  })

  it('模型给 0..1 的置信度时原样用', () => {
    const c = classifyText({ text: 'refund order #1' }, { now: NOW, model: { confidence: 0.42 } })
    expect(c.classifier).toBe('lexicon')
    const withIntent = classifyText(
      { text: 'refund order #1' },
      { now: NOW, model: { intent: 'returns_refunds', confidence: 0.42 } },
    )
    expect(withIntent.confidence).toBeCloseTo(0.42)
    const noConfidence = classifyText(
      { text: 'refund order #1' },
      { now: NOW, model: { intent: 'returns_refunds' } },
    )
    expect(noConfidence.confidence).toBeCloseTo(0.94)
  })

  it('紧急度：投诉最高，期限 + 催促次之，垃圾最低', () => {
    const complaint = classifyText({ text: 'this is a complaint about my order' }, { now: NOW })
    expect(complaint.urgency).toBe('high')
    const urgent = classifyText(
      { text: 'urgent: where is my package, I need it before Friday' },
      { now: NOW },
    )
    expect(urgent.urgency).toBe('high')
    const deadlineOnly = classifyText(
      { text: 'where is my package, I need it before Friday' },
      { now: NOW },
    )
    expect(deadlineOnly.urgency).toBe('normal')
    const asapOnly = classifyText({ text: 'where is my order, asap' }, { now: NOW })
    expect(asapOnly.urgency).toBe('normal')
    const spam = classifyText({ text: 'you have won a bitcoin giveaway' }, { now: NOW })
    expect(spam.urgency).toBe('low')
    const commitment = classifyText(
      { text: 'you promised a refund on my order last week' },
      { now: NOW },
    )
    expect(commitment.urgency).toBe('high')
  })

  it('InboundEvent 的非文本部分只留类型提示', () => {
    const parsed = inboundText(toInboundEvent(SAMPLES[0] as (typeof SAMPLES)[number]))
    expect(parsed.text).toContain('[attachment:application/pdf]')
    expect(parsed.from).toBe(SAMPLES[0]?.from)
  })

  it('命中客服词但落不进任何细分 → post_sales 兜底', () => {
    const tracking = classifyText({ text: 'A question about my delivery' }, { now: NOW })
    expect(tracking.intent).toBe('order_tracking')
    const product = classifyText({ text: 'Is this compatible in that size?' }, { now: NOW })
    expect(product.intent).toBe('product_question')
    // customs / tax 在客服词表里，但不属于任何一个细分 → 兜底到 post_sales
    const bare = classifyText({ text: 'What is your customs and tax setup?' }, { now: NOW })
    expect(bare.intent).toBe('post_sales')
    expect(bare.is_customer_service).toBe(true)
    expect(bare.classifier).toBe('lexicon')
  })

  it('normalizeIntent 只认白名单', () => {
    expect(normalizeIntent('complaint')).toBe('complaint')
    expect(normalizeIntent(42)).toBe('other')
    expect(normalizeIntent(undefined)).toBe('other')
  })
})

describe('证据芯片', () => {
  it('订单号：三种写法都取得到，取第一个', () => {
    expect(extractOrderRef('order #4101 please')).toBe('#4101')
    expect(extractOrderRef('Order number: 41010')).toBe('#41010')
    expect(extractOrderRef('订单号：4101')).toBe('#4101')
    expect(extractOrderRef('no order here')).toBeUndefined()
  })

  it('金额：符号、代码、中文单位', () => {
    expect(extractAmount('refund $129.00')).toEqual({ value: 129, currency: 'USD' })
    expect(extractAmount('€25,50 back')).toEqual({ value: 25.5, currency: 'EUR' })
    expect(extractAmount('£10 please')).toEqual({ value: 10, currency: 'GBP' })
    expect(extractAmount('¥88 refund')).toEqual({ value: 88, currency: 'CNY' })
    expect(extractAmount('129 USD refund')).toEqual({ value: 129, currency: 'USD' })
    expect(extractAmount('退 12.5 元')).toEqual({ value: 12.5, currency: 'CNY' })
    expect(extractAmount('no money here')).toBeUndefined()
  })

  it('期限与承诺取的是原文片段，且被压成一行', () => {
    const e = extractEntities(
      'You promised a full refund and I need it within 3 days, before Friday.',
    )
    expect(e.commitment).toContain('promised')
    expect(e.deadline).toBeDefined()
    const zh = extractEntities('你们客服答应过全额退款，请在 3 天内处理')
    expect(zh.commitment).toContain('答应')
    expect(zh.deadline).toBeDefined()
    const zhDate = extractEntities('请在 9 月 20 日前处理')
    expect(zhDate.deadline).toBeDefined()
  })

  it('风险词按冻结词表命中，顺序稳定', () => {
    expect(extractRiskTerms('the item is broken and I want a refund')).toEqual(['refund', 'broken'])
    expect(extractRiskTerms('nothing risky')).toEqual([])
  })

  it('缺资料：首条命中即返回', () => {
    expect(deriveNeeds('the item arrived damaged')).toEqual(['photos'])
    expect(deriveNeeds('the tracking is stuck')).toEqual(['tracking_number'])
    expect(deriveNeeds('I want a refund')).toEqual(['order_ref'])
    expect(deriveNeeds('hello there')).toEqual([])
  })

  it('去标识化自检拦得住邮箱、订单号、金额、长数字', () => {
    expect(isDeidentified('returns are accepted within fourteen days')).toBe(true)
    expect(isDeidentified('mail me at a@b.co')).toBe(false)
    expect(isDeidentified('order #12345')).toBe(false)
    expect(isDeidentified('$25 back')).toBe(false)
    expect(isDeidentified('call 13800000000')).toBe(false)
    expect(isDeidentified('the total was 1,234.00')).toBe(false)
  })
})

describe('文本工具', () => {
  it('unfence 能剥掉围栏壳，也能原样返回没壳的文本', () => {
    expect(unfence('<external_data>\nhello\n</external_data>')).toBe('hello')
    expect(unfence('plain')).toBe('plain')
    expect(unfence('a<external_data>\nb\n</external_data>c')).toBe('abc')
  })

  it('displayLine 压空白并截断', () => {
    expect(displayLine('  a   b  ', 10)).toBe('a b')
    expect(displayLine('abcdefghij', 5)).toBe('abcd…')
    expect(displayLine(undefined, 5)).toBe('')
  })

  it('haystack / matchTerms / includesAny', () => {
    const text = haystack('Subject', 'Body with refund', undefined)
    expect(text).toContain('refund')
    expect(matchTerms(text, ['refund', 'nope'])).toEqual(['refund'])
    expect(matchTerms(text, ['', 'refund'])).toEqual(['refund'])
    expect(includesAny(text, ['refund'])).toBe(true)
    expect(includesAny(text, ['', 'zzz'])).toBe(false)
  })

  it('语言判定：判不出一律 en', () => {
    expect(detectLanguage('hello')).toBe('en')
    expect(detectLanguage(undefined, '你好')).toBe('zh')
  })
})
