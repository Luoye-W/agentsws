import { describe, expect, it } from 'vitest'
import {
  AD_CREATIVE_SPECS,
  AD_DESIGN_SPECS,
  ALL_DESIGN_SPECS,
  adSpecId,
  adSpecToDesignSpec,
  canvasOf,
  resolveSpec,
  specNoteZh,
  specsForDuty,
} from '../src/index.js'

describe('58 §2 规格表的取数口', () => {
  it('每条职责吃得到自己那一族；认不出的职责给空数组，不给全部', () => {
    expect(specsForDuty('amazon').every((s) => s.family === 'amazon')).toBe(true)
    expect(specsForDuty('exhibition').every((s) => s.family === 'print')).toBe(true)
    expect(specsForDuty('nope' as never)).toEqual([])
  })

  it('广告那一族有货（本地定义那一份，TODO 合并后换 ads-core）', () => {
    const ads = specsForDuty('ads')
    expect(ads.length).toBe(AD_CREATIVE_SPECS.length)
    expect(ads.every((s) => s.id.startsWith('ads.'))).toBe(true)
  })

  it('id 全仓唯一（屏幕 + 印刷 + 广告合在一起也不撞）', () => {
    const ids = ALL_DESIGN_SPECS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('广告规格换算成通用规格：安全区与字数上限原样带过去', () => {
    const story = AD_CREATIVE_SPECS.find((s) => s.platform === 'meta' && s.placement === 'story')
    expect(story).toBeDefined()
    const spec = adSpecToDesignSpec(story as never)
    expect(spec.id).toBe('ads.meta.story')
    expect(spec.safe_area).toEqual(story?.safe_area)
    expect(spec.max_text_chars).toBe(125)
    expect(adSpecId(story as never)).toBe('ads.meta.story')
    expect(AD_DESIGN_SPECS.map((s) => s.id)).toContain('ads.tiktok.in_feed')
  })

  it('画布：屏幕直接用 px，印刷按 dpi 换算', () => {
    expect(canvasOf(resolveSpec('social.ig.story') as never)).toBe('1080x1920')
    // A4：210mm × 300dpi ÷ 25.4 ≈ 2480 × 3508
    expect(canvasOf(resolveSpec('print.brochure.a4') as never)).toBe('2480x3508')
  })

  it('规格说明把平台的硬规矩说出来（藏在数据结构里没人看得见）', () => {
    const main = specNoteZh(resolveSpec('amazon.main') as never)
    expect(main).toContain('2000×2000px')
    expect(main).toContain('一个字都不许有')
    expect(main).toContain('纯白底')
    const card = specNoteZh(resolveSpec('print.namecard') as never)
    expect(card).toContain('CMYK')
    expect(card).toContain('出血 3mm')
  })

  it('不认识的规格回 undefined', () => {
    expect(resolveSpec('ads.meta.nope')).toBeUndefined()
  })
})
