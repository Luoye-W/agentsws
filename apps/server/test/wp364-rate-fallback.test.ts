/**
 * WP364（决策 958 / 959，Luoye 10-17 纠正）：云上没给倍率时，本机兜底与云上**同一个口径**。
 *
 * - 消耗速率 = 典型 token 构成（输入 3 : 输出 1）× 我们的积分价（折成人民币） ÷ 同一构成 × DeepSeek v4 Pro 官方标价；
 * - 折扣 = 同一构成下 我们的积分价 ÷ 这家官方标价，`< 1` 才给；
 * - 云上给了倍率：倍率与折扣都照云上（云上没给折扣 = 不到「折」，本机不另算）；
 * - 本机价目里连 DeepSeek v4 Pro 的官方价都没有：退回 WP362 的老办法。
 */
import {
  type PricingModelEntry,
  TYPICAL_TOKEN_MIX,
  tokenMixCost,
  tokenMixRatio,
} from '@agentsws/contracts'
import type { PriceCatalog } from '@agentsws/model-gateway'
import { describe, expect, it } from 'vitest'
import { cloudRates, officialPriceCny } from '../src/model-rates.js'

const FX = { CNY: 1, USD: 7.1 }
const ctx = { credit_cny: 1, fx: FX }

/** 官方价（美元 / 百万 token）× 汇率 × 倍率 ÷ 1000 = 积分 / 1k token。 */
const credits = (usdPerM: number, times: number): number => (usdPerM * 7.1 * times) / 1000

describe('token 构成的算法（契约里那三个小函数）', () => {
  it('加权平均；缓存不给按输入算；构成全 0 回 0；分母 0 回 undefined', () => {
    expect(tokenMixCost({ in: 1, out: 4 }, { input: 3, cached: 0, output: 1 })).toBe(1.75)
    expect(tokenMixCost({ in: 1, out: 4 }, { input: 0, cached: 2, output: 0 })).toBe(1)
    expect(tokenMixCost({ in: 1, out: 4, cached: 0.1 }, { input: 0, cached: 1, output: 0 })).toBe(
      0.1,
    )
    expect(tokenMixCost({ in: 1, out: 4 }, { input: 0, cached: 0, output: 0 })).toBe(0)
    expect(tokenMixRatio({ in: 1, out: 1 }, { in: 0, out: 0 }, TYPICAL_TOKEN_MIX)).toBeUndefined()
    expect(TYPICAL_TOKEN_MIX).toEqual({ input: 3, cached: 0, output: 1 })
  })
})

describe('本机兜底：同口径', () => {
  it('按官方价 3 倍卖：倍率是相对 v4 Pro 官方价，v4 Pro 自己是 3x；不到「折」', () => {
    const entries: PricingModelEntry[] = [
      { model: 'deepseek-v4-pro', in: credits(1.32, 3), out: credits(3.96, 3) },
      { model: 'deepseek-flash', in: credits(0.3, 3), out: credits(1.2, 3) },
    ]
    const rates = cloudRates(entries, undefined, ctx)
    expect(rates.base).toEqual({ model: 'deepseek-v4-pro', fallback: false })
    const pro = rates.price('deepseek-v4-pro')
    expect(pro?.kind === 'rate' && pro.rate).toBeCloseTo(3, 6)
    expect(pro?.kind === 'rate' && pro.source).toBe('list_price')
    expect(pro !== undefined && 'discount' in pro).toBe(false)
    const flash = rates.price('deepseek-flash')
    // (3 × 0.3 + 1.2) / 4 = 0.525；(3 × 1.32 + 3.96) / 4 = 1.98；× 3
    expect(flash?.kind === 'rate' && flash.rate).toBeCloseTo((0.525 / 1.98) * 3, 6)
  })

  it('按官方价 8 折卖：折扣 0.8（AI 钮写「8 折」），倍率跟着是官方价比 × 0.8', () => {
    const rates = cloudRates(
      [{ model: 'deepseek-flash', in: credits(0.3, 0.8), out: credits(1.2, 0.8) }],
      undefined,
      ctx,
    )
    const flash = rates.price('deepseek-flash')
    expect(flash?.kind === 'rate' && flash.discount).toBe(0.8)
    expect(flash?.kind === 'rate' && flash.rate).toBeCloseTo((0.525 / 1.98) * 0.8, 6)
  })

  it('云上给了倍率：照云上；云上没给折扣就不显示折扣（本机不另算）', () => {
    const rates = cloudRates(
      [
        {
          model: 'deepseek-flash',
          in: credits(0.3, 0.5),
          out: credits(1.2, 0.5),
          consumption_rate: 0.4,
          rate_source: 'stats',
        },
      ],
      undefined,
      ctx,
    )
    expect(rates.price('deepseek-flash')).toEqual({ kind: 'rate', rate: 0.4, source: 'stats' })
  })

  it('价为 0 是限免；本机价目里认不出的模型只出倍率不出折扣', () => {
    const rates = cloudRates(
      [
        { model: 'deepseek-flash', in: 0, out: 0 },
        { model: 'some-new-model', in: credits(1, 1), out: credits(1, 1) },
      ],
      undefined,
      ctx,
    )
    expect(rates.price('deepseek-flash')).toEqual({ kind: 'free' })
    const other = rates.price('some-new-model')
    expect(other?.kind === 'rate' && other.rate).toBeCloseTo(1 / 1.98, 6)
    expect(other !== undefined && 'discount' in other).toBe(false)
  })

  it('本机价目里没有 DeepSeek v4 Pro：退回 WP362 老办法（积分价相对默认模型）', () => {
    const catalog: PriceCatalog = { version: 1, as_of: '2026-10-17', note: '', vendors: [] }
    const rates = cloudRates(
      [
        { model: 'a', in: 0.01, out: 0.02 },
        { model: 'b', in: 0.02, out: 0.04 },
      ],
      'a',
      { ...ctx, catalog },
    )
    expect(rates.base).toEqual({ model: 'a', fallback: true })
    expect(rates.price('b')).toEqual({ kind: 'rate', rate: 2, source: 'list_price' })
  })

  it('官方价折人民币：按价目里的汇率；订阅档（三格 0）不算官方价', () => {
    expect(officialPriceCny('deepseek-v4-pro', ctx)).toEqual({
      in: 1.32 * 7.1,
      out: 3.96 * 7.1,
      cached: 0.044 * 7.1,
    })
    // qwen3.8-max 在订阅档里是 0，在百炼按量那家有价
    expect(officialPriceCny('qwen3.8-max', ctx)?.in).toBe(12)
  })
})
