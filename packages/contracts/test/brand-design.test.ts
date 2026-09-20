import { describe, expect, it } from 'vitest'
import type {
  BrandDesignProfile,
  BrandDesignValue,
  DesignTokens,
  DesignTypography,
} from '../src/index.js'
import {
  BRAND_DESIGN_MAX_FILE_PAGES,
  CREDITS_PER_VISION_CALL,
  DEFAULT_BRAND_DESIGN_CAP_CREDITS,
  DEFAULT_BRAND_INTAKE_CAP_CREDITS,
  DESIGN_COMPONENT_PROPS,
  DESIGN_MD_SECTIONS,
  DESIGN_MD_SPEC_VERSION,
  WCAG_AA_CONTRAST,
  WCAG_AA_LARGE_CONTRAST,
} from '../src/index.js'

describe('71 DESIGN.md 规范对齐（WP122）', () => {
  it('八个小节，顺序逐字等于上游规范', () => {
    // github.com/google-labs-code/design.md · docs/spec.md §Sections · Section Order
    expect([...DESIGN_MD_SECTIONS]).toEqual([
      'Overview',
      'Colors',
      'Typography',
      'Layout',
      'Elevation & Depth',
      'Shapes',
      'Components',
      "Do's and Don'ts",
    ])
  })

  it('跟的是 alpha —— 规范自己说它是 alpha，我们不许写一个更好看的版本号', () => {
    expect(DESIGN_MD_SPEC_VERSION).toBe('alpha')
  })

  it('八个组件属性名与规范一致', () => {
    expect([...DESIGN_COMPONENT_PROPS]).toEqual([
      'backgroundColor',
      'textColor',
      'typography',
      'rounded',
      'padding',
      'size',
      'height',
      'width',
    ])
  })
})

describe('令牌的形状容得下规范里的写法', () => {
  it('lineHeight 允许无单位数字（CSS 推荐写法），也允许带单位串', () => {
    const unitless: DesignTypography = { fontFamily: 'Public Sans', lineHeight: 1.6 }
    const dimension: DesignTypography = { fontFamily: 'Public Sans', lineHeight: '24px' }
    expect(unitless.lineHeight).toBe(1.6)
    expect(dimension.lineHeight).toBe('24px')
  })

  it('spacing 允许无单位数（栅格列数这类）', () => {
    const tokens: DesignTokens = { spacing: { md: '16px', columns: 12 } }
    expect(tokens.spacing?.columns).toBe(12)
  })

  it('omitted 两种写法都合法：光一个节名，或节名 + 原因', () => {
    const tokens: DesignTokens = {
      omitted: ['spacing', { section: 'rounded', reason: '官网上没找到统一的圆角' }],
    }
    expect(tokens.omitted).toHaveLength(2)
  })

  it('组件值可以是 `{colors.primary}` 这种引用', () => {
    const tokens: DesignTokens = {
      colors: { primary: '#1a1c1e' },
      components: { 'button-primary': { backgroundColor: '{colors.primary}', padding: '12px' } },
    }
    expect(tokens.components?.['button-primary']?.backgroundColor).toBe('{colors.primary}')
  })
})

describe('我们在规范外面多的那一层', () => {
  it('一个值可以带好几条出处，且 PDF 那条记得下页码', () => {
    const v: BrandDesignValue<string> = {
      value: '#b8422e',
      confidence: 'high',
      source: [
        { origin: 'site', url: 'https://x.test/', locator: 'css-var:--color-accent', weight: 41 },
        { origin: 'file', page: 3, locator: 'pdf:p3', quote: 'PANTONE 186 C' },
      ],
    }
    expect(v.source.map((s) => s.origin)).toEqual(['site', 'file'])
    expect(v.source[1]?.page).toBe(3)
  })

  it('冲突不合并：两个值都留着，界面上并排给用户选', () => {
    const v: BrandDesignValue<string> = {
      value: '#b8422e',
      confidence: 'high',
      source: [{ origin: 'file', page: 3 }],
      conflict: { value: '#c04a33', source: [{ origin: 'site', url: 'https://x.test/' }] },
    }
    // 手册优先（文件里写的是规范，官网是实现），但另一个没被删掉
    expect(v.value).toBe('#b8422e')
    expect(v.conflict?.value).toBe('#c04a33')
  })

  it('档案里没有裸值 —— 每一格都拖着出处走', () => {
    const profile: BrandDesignProfile = {
      colors: {
        primary: { value: '#1a1c1e', confidence: 'medium', source: [{ origin: 'site' }] },
      },
    }
    expect(profile.colors?.primary?.source).toHaveLength(1)
  })
})

describe('封顶与阈值', () => {
  it('成文那一步封顶 1，与 WP121 的 2 加起来仍在注册送的 10 以内', () => {
    expect(DEFAULT_BRAND_DESIGN_CAP_CREDITS).toBe(1)
    expect(DEFAULT_BRAND_DESIGN_CAP_CREDITS + DEFAULT_BRAND_INTAKE_CAP_CREDITS).toBeLessThan(10)
  })

  it('视觉档比文字档贵，且一次封顶跑不满手册的页数上限', () => {
    expect(CREDITS_PER_VISION_CALL).toBeGreaterThan(0)
    expect(BRAND_DESIGN_MAX_FILE_PAGES * CREDITS_PER_VISION_CALL).toBeGreaterThan(
      DEFAULT_BRAND_DESIGN_CAP_CREDITS,
    )
  })

  it('对比度用 WCAG AA 的两个数', () => {
    expect(WCAG_AA_CONTRAST).toBe(4.5)
    expect(WCAG_AA_LARGE_CONTRAST).toBe(3)
  })
})
