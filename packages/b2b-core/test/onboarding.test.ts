/**
 * 首次设置 B2B 分支（移植自 BtoBAgents `runtime-v2/onboarding.ts`）+ 知识六类。
 */
import { DEFAULT_B2B_QUOTE_MANDATE } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  B2B_FACT_CATEGORIES,
  buildOnboardingRecommendation,
  factCategoryFor,
  guessIndustry,
} from '../src/index.js'

describe('行业识别', () => {
  it('3C：推荐 CE / FCC / RoHS / UKCA / PSE', () => {
    const g = guessIndustry('We make GaN chargers and power banks')
    expect(g.industry).toBe('消费电子 / 3C')
    expect(g.sub_industry).toBe('充电与电源产品')
    expect(g.certifications.slice(0, 5)).toEqual(['CE', 'FCC', 'RoHS', 'UKCA', 'PSE'])
  })
  it('智能家居加 Matter', () => {
    expect(guessIndustry('智能家居 IoT 网关').certifications).toContain(
      'Matter/Thread（按产品确认）',
    )
  })
  it('认不出来：综合产品、不编认证', () => {
    const g = guessIndustry('ceramic tableware')
    expect(g).toMatchObject({ industry: 'B2B 出口贸易', certifications: [] })
  })
})

describe('首次设置推荐', () => {
  const rec = buildOnboardingRecommendation({
    website: 'https://nordvolt-factory.example',
    description: 'Shenzhen factory, OEM GaN chargers',
  })
  it('四个授权数都要人确认，提议值是统一后的那一套', () => {
    const byKey = Object.fromEntries(
      rec.requires_confirmation.map((r) => [r.key, r.proposed_value]),
    )
    expect(byKey['commercial.maxQuoteAmountUsd']).toBe(DEFAULT_B2B_QUOTE_MANDATE.max_amount_usd)
    expect(byKey['commercial.minimumMarginPercent']).toBe(20)
    expect(byKey['commercial.maximumDiscountPercent']).toBe(5)
    expect(byKey['commercial.paymentTermsDays']).toBe(30)
    expect(byKey['automation.externalSendLevel']).toBe('L1')
  })
  it('发信域名：建议独立，由用户选', () => {
    const d = rec.requires_confirmation.find((r) => r.key === 'outbound.sendingDomain')
    expect(d?.proposed_value).toBe('separate')
  })
  it('不推荐 Firecrawl 与 Apify 查 LinkedIn', () => {
    expect(rec.recommended_integrations.join(' ')).not.toMatch(/firecrawl|linkedin/i)
  })
  it('工厂 + OEM 识别得出来；公司名取域名', () => {
    expect(rec.profile).toMatchObject({
      company_name: 'nordvolt-factory',
      size: '50–200 人',
      business_model: 'OEM / ODM / Private Label',
    })
  })
})

describe('知识六类', () => {
  it('正好六类，id 不重名', () => {
    expect(B2B_FACT_CATEGORIES.map((c) => c.name)).toEqual([
      '产品线',
      '价格与 MOQ',
      '认证清单',
      '交付能力',
      '样品政策',
      '售后规则',
    ])
  })
  it('承诺类别对得上该查的那一类', () => {
    expect(factCategoryFor('moq')?.id).toBe('pricing_moq')
    expect(factCategoryFor('certification')?.id).toBe('certifications')
    expect(factCategoryFor('lead_time')?.id).toBe('delivery')
  })
})
