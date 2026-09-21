/*
 * 充值四档（67 §2）与付费三块（67 §1）的钉子。
 *
 * 这个文件里的每一条都在防同一类事故：**表是手写的**。四档的数字写错一位
 * （140 写成 1400）在界面上完全看不出来，只会在月底对账时变成一笔说不清的钱；
 * 三块的归类漏一条，「这个月钱花哪儿了」那三张卡就有一块永远是 0。
 */
import { PRICING_BLOCKS, pricingBlockOf } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { PRICING_FILE } from '../src/pricing.js'
import {
  CREDITS_PER_USD,
  TOPUP_TIERS_FILE,
  topupTierById,
  topupTiers,
  topupTiersConsistent,
} from '../src/topup-tiers.js'

describe('充值四档', () => {
  it('就是 Luoye 定的那四档：20/50/100/200 美元 → 140/350/700/1400 积分', () => {
    expect(topupTiers().map((t) => [t.usd, t.credits])).toEqual([
      [20, 140],
      [50, 350],
      [100, 700],
      [200, 1400],
    ])
  })

  it('1 美元 = 7 积分，每一档都对得上（写错一位数就红）', () => {
    expect(CREDITS_PER_USD).toBe(7)
    expect(topupTiersConsistent()).toEqual([])
  })

  it('对不上的那一档会被点名——自检本身有效，不是摆设', () => {
    const broken = {
      ...TOPUP_TIERS_FILE,
      tiers: [{ id: 'bad', usd: 20, credits: 1400, label_zh: '错', label_en: 'bad' }],
    }
    expect(topupTiersConsistent(broken)).toEqual([{ id: 'bad', expected: 140, got: 1400 }])
  })

  it('认不出的档位回 undefined，不退到某个默认档', () => {
    expect(topupTierById('usd50')?.credits).toBe(350)
    expect(topupTierById('usd999')).toBeUndefined()
    expect(topupTierById('')).toBeUndefined()
  })

  it('只推荐一档（推荐两张卡等于没推荐）', () => {
    expect(topupTiers().filter((t) => t.recommended === true)).toHaveLength(1)
  })

  it('档位 id 不重复——重复的话建单时按 id 找会随机命中一张', () => {
    const ids = topupTiers().map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('付费三块', () => {
  it('价目表每一条都归得进三块之一', () => {
    for (const entry of PRICING_FILE.entries) {
      expect(PRICING_BLOCKS).toContain(pricingBlockOf(entry))
    }
  })

  it('三块都不空——空的那一块在界面上是一张永远 0 的卡', () => {
    const seen = new Set(PRICING_FILE.entries.map((e) => pricingBlockOf(e)))
    expect([...PRICING_BLOCKS].every((b) => seen.has(b))).toBe(true)
  })

  it('AI 归 ai、增值服务归 service（WP124 改通用名，红人与客服都归它）、其余归 data', () => {
    const blockOf = (capability: string): string => {
      const entry = PRICING_FILE.entries.find((e) => e.capability === capability)
      if (entry === undefined) throw new Error(`价目表里没有 ${capability}`)
      return pricingBlockOf(entry)
    }
    expect(blockOf('ai.chat')).toBe('ai')
    expect(blockOf('data.kol.lookup')).toBe('data')
    expect(blockOf('kol.service.monthly')).toBe('service')
    expect(blockOf('support.service.monthly')).toBe('service')
  })

  it('红人营销增值服务是 30 积分 / 月（= ¥30）', () => {
    const entry = PRICING_FILE.entries.find((e) => e.capability === 'kol.service.monthly')
    expect(entry?.credits_per_unit).toBe(30)
    expect(entry?.unit).toBe('month')
  })

  it('旧数据（没有 block 那一列）按能力名前缀兜底，不会漏出界面', () => {
    expect(pricingBlockOf({ capability: 'ai.embeddings' })).toBe('ai')
    expect(pricingBlockOf({ capability: 'kol.service.monthly' })).toBe('service')
    expect(pricingBlockOf({ capability: 'support.service.monthly' })).toBe('service')
    expect(pricingBlockOf({ capability: 'crawl.page' })).toBe('data')
    // 显式写了的那一列优先于前缀
    expect(pricingBlockOf({ capability: 'crawl.page', block: 'ai' })).toBe('ai')
    // 老数据里读到 kol_service：归一化成 service（块名改了，老价目表不断界面）
    expect(pricingBlockOf({ capability: 'kol.service.monthly', block: 'kol_service' })).toBe(
      'service',
    )
  })
})
