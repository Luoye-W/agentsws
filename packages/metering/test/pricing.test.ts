/**
 * 价目表的换算口径（49 §3）。
 *
 * 这些用例锁的不是"某个模型多少钱"（那会随 `catalog.json` 改），而是**口径**：
 * 官网标价（原币）→ 参考汇率折人民币 → × 倍率 → 积分，1 积分 = ¥1。
 */
import { PRICE_CATALOG } from '@agentsws/model-gateway'
import { describe, expect, it } from 'vitest'
import {
  aiCredits,
  buildPricing,
  creditsFor,
  creditsPerThousandTokens,
  entryFor,
  estimateAiCredits,
  isCnAvailable,
  modelPrice,
  PRICING_FILE,
} from '../src/pricing.js'

describe('价目表', () => {
  const pricing = buildPricing()

  it('1 积分 = ¥1，倍率 3，汇率带日期', () => {
    expect(pricing.credit_cny).toBe(1)
    expect(pricing.ai_multiplier).toBe(3)
    expect(pricing.fx.CNY).toBe(1)
    expect(pricing.fx.USD).toBeGreaterThan(1)
    expect(pricing.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('九条能力都在，每条中英标签齐全', () => {
    expect(pricing.entries.map((e) => e.capability)).toEqual([
      'ai.chat',
      'ai.embeddings',
      'data.kol.lookup',
      'data.kol.audit',
      'social.fetch',
      'crawl.page',
      'transcribe.minute',
      'standby.seat.month',
      // WP118 加的第九条：红人营销增值服务（订阅，30 积分 / 月）
      'kol.service.monthly',
    ])
    for (const e of pricing.entries) {
      expect(e.label_zh, e.capability).not.toBe('')
      expect(e.label_en, e.capability).not.toBe('')
      expect(e.credits_per_unit, e.capability).toBeGreaterThan(0)
    }
  })

  it('换算口径：每百万 token 的原币标价 × 汇率 × 倍率 ÷ 1000', () => {
    // $1/1M，汇率 7.1，倍率 3 → 每千 token 0.0213 积分
    expect(creditsPerThousandTokens(1, 'USD', { USD: 7.1 }, 3)).toBe(0.0213)
    // 人民币标价不折
    expect(creditsPerThousandTokens(20, 'CNY', { CNY: 1 }, 3)).toBe(0.06)
    // 认不出的币种按 1 折（而不是猜一个汇率——猜错比不换算更危险）
    expect(creditsPerThousandTokens(10, 'JPY', { USD: 7.1 }, 3)).toBe(0.03)
  })

  it('AI 单价是从 catalog.json 拼出来的，不是手写的', () => {
    const vendor = PRICE_CATALOG.vendors.find((v) => v.id === 'deepseek')
    const source = vendor?.models[0]
    expect(vendor).toBeDefined()
    expect(source).toBeDefined()
    const priced = modelPrice(pricing, (source as { model: string }).model)
    expect(priced?.in).toBe(
      creditsPerThousandTokens(
        (source as { in: number }).in,
        (vendor as { currency: string }).currency,
        PRICING_FILE.fx,
        PRICING_FILE.ai_multiplier,
      ),
    )
  })

  it('境内可用按 cn_vendors 判：DeepSeek 可以，OpenAI 不行', () => {
    const cnModel = PRICE_CATALOG.vendors.find((v) => v.id === 'deepseek')?.models[0]?.model
    const globalModel = PRICE_CATALOG.vendors.find((v) => v.id === 'openai')?.models[0]?.model
    expect(isCnAvailable(pricing, cnModel as string)).toBe(true)
    expect(isCnAvailable(pricing, globalModel as string)).toBe(false)
    // 价目表里根本没有的一律不可用（不猜）
    expect(isCnAvailable(pricing, 'some-model-we-never-heard-of')).toBe(false)
  })

  it('按次 / 按页 / 按分钟：数量 × 单价；认不出的能力回 undefined', () => {
    const per = entryFor(pricing, 'crawl.page')?.credits_per_unit as number
    expect(creditsFor(pricing, 'crawl.page', 10)).toBe(per * 10)
    expect(creditsFor(pricing, 'nope.not.a.capability', 1)).toBeUndefined()
  })

  it('一次 AI 调用：输入 / 输出 / 缓存命中各按各的价', () => {
    const model = PRICE_CATALOG.vendors.find((v) => v.id === 'deepseek')?.models[0]?.model as string
    const p = modelPrice(pricing, model)
    expect(p).toBeDefined()
    const price = p as { in: number; out: number; cached?: number }
    const credits = aiCredits(pricing, model, {
      input_tokens: 2000,
      output_tokens: 1000,
      cached_tokens: 1000,
    })
    // 2000 输入里 1000 是命中的：1000 按 in、1000 按 cached、1000 输出按 out
    const expected = (1000 * price.in + 1000 * (price.cached ?? price.in) + 1000 * price.out) / 1000
    expect(credits).toBeCloseTo(expected, 6)
  })

  it('模型不在价目表里也照收：退到 ai.chat 那条兜底价，不是免费', () => {
    const fallback = entryFor(pricing, 'ai.chat')?.credits_per_unit as number
    expect(aiCredits(pricing, 'unknown-model', { input_tokens: 500, output_tokens: 500 })).toBe(
      fallback,
    )
  })

  it('预扣按 max_tokens 估，且向上取整（多留一点，结算退差额）', () => {
    const model = PRICE_CATALOG.vendors.find((v) => v.id === 'deepseek')?.models[0]?.model as string
    const tight = estimateAiCredits(pricing, model, { input_tokens: 100, max_tokens: 100 })
    const loose = estimateAiCredits(pricing, model, { input_tokens: 100 })
    // 没给 max_tokens 就按默认 1000 估——比给了 100 的那次多
    expect(loose).toBeGreaterThan(tight)
    expect(tight).toBeGreaterThanOrEqual(
      aiCredits(pricing, model, { input_tokens: 100, output_tokens: 100 }),
    )
  })
})
