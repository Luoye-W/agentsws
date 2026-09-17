import { describe, expect, it } from 'vitest'
import type { BrandSystemCard } from '../src/index.js'
import {
  brandPrompt,
  brandSystemMissingCard,
  MISSING_NOTE,
  parseBrandSystem,
  resolveBrandSystem,
} from '../src/index.js'

const org: BrandSystemCard = {
  name: 'brand-system',
  scope: 'org',
  body: [
    '# 色',
    '- #0F172A 深蓝',
    '- #F97316',
    '# 字',
    '- Inter',
    '- 思源黑体',
    '# 版式',
    '留白多，产品居中，一屏只说一件事。',
    '# 禁忌',
    '- 竞品 logo（法务说过）',
    '- 真人脸',
  ].join('\n'),
  updated_at: '2026-08-01',
}

const amazonOnly: BrandSystemCard = {
  name: 'brand-system-amazon',
  scope: 'duty',
  duty: 'amazon',
  body: '# 色\n- #FFFFFF\n# 禁忌\n- 任何文字',
}

describe('58 §2 品牌系统：只从公司层技能取，不在这里编', () => {
  it('读得出色 / 字 / 版式 / 禁忌四格', () => {
    const s = parseBrandSystem(org)
    expect(s.colors).toEqual(['#0F172A 深蓝', '#F97316'])
    expect(s.fonts).toEqual(['Inter', '思源黑体'])
    expect(s.layout).toContain('留白多')
    // 禁忌拿去查提示词，所以行内说明剥掉
    expect(s.forbidden).toEqual(['竞品 logo', '真人脸'])
  })

  it('人写了一段散文：整段留在版式里，不当它不存在', () => {
    const s = parseBrandSystem({ name: 'b', scope: 'org', body: '就是干净、冷色、别花哨。' })
    expect(s.layout).toBe('就是干净、冷色、别花哨。')
    expect(s.colors).toEqual([])
  })

  it('职责那张优先，**不合并**两张', () => {
    const r = resolveBrandSystem([org, amazonOnly], 'amazon')
    expect(r.system?.name).toBe('brand-system-amazon')
    // 公司那张的字体没有被拼进来
    expect(r.system?.fonts).toEqual([])
  })

  it('职责没单独写就用公司那张', () => {
    expect(resolveBrandSystem([org, amazonOnly], 'social').system?.name).toBe('brand-system')
  })

  it('一张都没有：说没有，**不编一套默认配色**', () => {
    const r = resolveBrandSystem([], 'dtc')
    expect(r.system).toBeUndefined()
    expect(r.note).toBe(MISSING_NOTE)
    expect(brandPrompt(r)).toContain('还没设过品牌系统')
    // 没有色值被编出来
    expect(brandPrompt(r)).not.toMatch(/#[0-9a-f]{6}/i)
  })

  it('缺品牌系统卡：不挡路，但把代价说清楚（58 §3 第四张卡）', () => {
    const card = brandSystemMissingCard()
    expect(card.kind).toBe('brand_system_missing')
    expect(card.blocking).toBe(false)
    expect(card.skill_tier).toBe('company')
    expect(card.body_zh).toContain('十个牌子')
  })

  it('版式那一段**原样引用**，一个字不改写', () => {
    const prompt = brandPrompt(resolveBrandSystem([org], 'dtc'))
    expect(prompt).toContain('留白多，产品居中，一屏只说一件事。')
    expect(prompt).toContain('【不许出现】竞品 logo、真人脸')
  })
})
