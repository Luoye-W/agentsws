import { describe, expect, it } from 'vitest'
import type { DesignAsset } from '../src/index.js'
import {
  DESIGN_CAPS,
  DESIGN_DUTIES,
  DESIGN_ROLE_IDS,
  DESIGN_SPECS,
  designDutyForSource,
  designDutyOfRole,
  designDutySpec,
  designSpec,
  designSpecsOfFamily,
  isDesignAssetFinal,
} from '../src/index.js'

describe('58 §1 五条设计职责的常量表（WP76）', () => {
  it('五条，顺序 = 岗位模板里的摆法', () => {
    expect(DESIGN_DUTIES.map((d) => d.id)).toEqual(['dtc', 'amazon', 'social', 'ads', 'exhibition'])
  })

  it('职责 id 写在表里，不由调用方现拼', () => {
    expect(DESIGN_ROLE_IDS).toEqual([
      'design.dtc',
      'design.amazon',
      'design.social',
      'design.ads',
      'design.exhibition',
    ])
    expect(designDutyOfRole('design.exhibition')?.id).toBe('exhibition')
    expect(designDutyOfRole('social.meta')).toBeUndefined()
    expect(designDutySpec('ads')?.role_id).toBe('design.ads')
    expect(designDutySpec('nope')).toBeUndefined()
  })

  it('来源职责 → 设计职责：三条 request_design 的落点（58 §1 来源那一列）', () => {
    expect(designDutyForSource('dtc.store')?.role_id).toBe('design.dtc')
    expect(designDutyForSource('social.meta')?.role_id).toBe('design.social')
    expect(designDutyForSource('kol.youtube')?.role_id).toBe('design.social')
    // 没登记的来源**不猜**一条（54 §2：拿不准就问一句）
    expect(designDutyForSource('dtc.support')).toBeUndefined()
  })

  it('展会设计没有上游职责，人手动开', () => {
    expect(designDutySpec('exhibition')?.request_sources).toEqual(['human'])
  })

  it('每条职责至少有一族规格，且族里真有规格（`ads` 除外——那份在 design-core）', () => {
    for (const duty of DESIGN_DUTIES) {
      expect(duty.spec_families.length).toBeGreaterThan(0)
      for (const family of duty.spec_families) {
        if (family === 'ads') continue
        expect(designSpecsOfFamily(family).length).toBeGreaterThan(0)
      }
    }
  })
})

describe('58 §2 DESIGN_SPECS 规格表', () => {
  it('规格 id 唯一', () => {
    const ids = DESIGN_SPECS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('屏幕规格是 px + sRGB，印刷规格是 mm + CMYK + 出血', () => {
    for (const spec of DESIGN_SPECS) {
      if (spec.family === 'print') {
        expect(spec.unit).toBe('mm')
        expect(spec.color_mode).toBe('CMYK')
        expect(spec.bleed_mm).toBeGreaterThan(0)
        expect(spec.dpi).toBeGreaterThan(0)
      } else {
        expect(spec.unit).toBe('px')
        expect(spec.color_mode).toBe('sRGB')
        // 屏幕规格不该有 dpi / 出血：那是印刷才有的概念
        expect(spec.dpi).toBeUndefined()
        expect(spec.bleed_mm).toBeUndefined()
      }
    }
  })

  it('Amazon 主图：2000 见方、**一个字都不许有**', () => {
    const main = designSpec('amazon.main')
    expect(main?.width).toBe(2000)
    expect(main?.height).toBe(2000)
    expect(main?.max_text_chars).toBe(0)
  })

  it('广告规格不在契约里（真源在 ads-core，58 表头那一行）', () => {
    expect(designSpecsOfFamily('ads')).toEqual([])
  })

  it('不认识的规格回 undefined，不编一条出来', () => {
    expect(designSpec('amazon.does-not-exist')).toBeUndefined()
  })

  it('安全区不许比画布还大', () => {
    for (const spec of DESIGN_SPECS) {
      if (spec.safe_area === undefined) continue
      expect(spec.safe_area.left + spec.safe_area.right).toBeLessThan(spec.width)
      expect(spec.safe_area.top + spec.safe_area.bottom).toBeLessThan(spec.height)
    }
  })
})

describe('58 §6 额度默认值', () => {
  it('每 brief 变体 6、每日出图 30、每日 brief 10', () => {
    expect(DESIGN_CAPS).toEqual({
      max_variants_per_brief: 6,
      max_generations_per_day: 30,
      max_brief_per_day: 10,
    })
  })
})

describe('04 §6「视觉决定永远是人」写在类型里', () => {
  const base: DesignAsset = {
    id: 'asset_1',
    workspace_id: 'ws_1',
    duty: 'social',
    spec_id: 'social.ig.square',
    status: 'variant',
    provenance: { source: 'generated', prompt_sha256: 'abc' },
    created_at: '2026-09-17T09:00:00Z',
  }

  it('没人点过就不是定稿——状态到了也不算', () => {
    expect(isDesignAssetFinal({ ...base, status: 'published' })).toBe(false)
    expect(
      isDesignAssetFinal({
        ...base,
        status: 'published',
        provenance: { ...base.provenance, picked_by: 'p_1' },
      }),
    ).toBe(false)
  })

  it('人点过 + 状态到了才算定稿', () => {
    expect(
      isDesignAssetFinal({
        ...base,
        status: 'published',
        provenance: {
          ...base.provenance,
          picked_by: 'p_1',
          picked_at: '2026-09-17T10:00:00Z',
        },
      }),
    ).toBe(true)
  })

  it('人点过但还没入库，也不算定稿', () => {
    expect(
      isDesignAssetFinal({
        ...base,
        status: 'picked',
        provenance: {
          ...base.provenance,
          picked_by: 'p_1',
          picked_at: '2026-09-17T10:00:00Z',
        },
      }),
    ).toBe(false)
  })
})
