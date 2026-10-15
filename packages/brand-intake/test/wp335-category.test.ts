/** WP335（决策 659）：品类一格——已有不问、提示词只给读到的几格、回复读不出就不填、落成「请确认」那一档。 */
import type { BrandIntakeProfile } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  categoryPrompt,
  modelCategoryField,
  needsConfirm,
  parseCategoryReply,
  wantsModelCategory,
} from '../src/index.js'

const f = <T>(value: T) => ({
  value,
  confidence: 'high' as const,
  evidence: [{ url: 'https://x.example', locator: 'og' }],
})

describe('WP335 品类', () => {
  it('已经有（面包屑读到 / 人改过）就不问；什么都没读到也不问', () => {
    expect(wantsModelCategory({ brand_name: f('NordVolt'), category: f('Power banks') })).toBe(
      false,
    )
    expect(wantsModelCategory({})).toBe(false)
    expect(wantsModelCategory({ brand_name: f('NordVolt') })).toBe(true)
  })

  it('提示词只带品牌名、一句话、前几个商品名', () => {
    const p: BrandIntakeProfile = {
      brand_name: f('NordVolt'),
      one_liner: f('Travel power banks'),
      products: f([{ title: 'NordVolt Air 10000' }, { title: 'NordVolt Max' }]),
      support_email: f('help@x.example'),
    }
    const text = categoryPrompt(p)
    expect(text).toContain('brand: NordVolt')
    expect(text).toContain('- NordVolt Air 10000')
    expect(text).not.toContain('help@x.example')
  })

  it('读回复：短名词收下；空、null、太长、像一句话都不填', () => {
    expect(parseCategoryReply('{"category": "power bank"}')).toBe('power bank')
    expect(parseCategoryReply('```json\n{"category":"宠物饮水机。"}\n```')).toBe('宠物饮水机')
    expect(parseCategoryReply('{"category": null}')).toBeUndefined()
    expect(parseCategoryReply('{"category": ""}')).toBeUndefined()
    expect(parseCategoryReply('{"category": "chargers, cables and more"}')).toBeUndefined()
    expect(parseCategoryReply(`{"category": "${'x'.repeat(41)}"}`)).toBeUndefined()
    expect(parseCategoryReply('not json')).toBeUndefined()
  })

  it('落成一格：模型那一层、把握度低（界面标「请确认」）', () => {
    const cell = modelCategoryField('power bank', 'https://x.example')
    expect(cell).toMatchObject({ value: 'power bank', confidence: 'low' })
    expect(cell.evidence[0]).toMatchObject({ url: 'https://x.example', locator: 'model' })
    expect(needsConfirm(cell)).toBe(true)
  })
})
