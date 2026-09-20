import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrandDesignProfile } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { checkAgainstDesign, extractColorsFromText } from '../src/check.js'
import { contrastRatio, inPalette, nearestColor, parseColor } from '../src/color.js'
import {
  brandDesignContext,
  EMPTY_BRAND_DESIGN_CONTEXT,
  MAX_CONTEXT_CHARS,
} from '../src/context.js'
import { extractSiteDesign } from '../src/site-design.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): string => readFileSync(join(HERE, 'fixtures', name), 'utf8')

function heritage(): BrandDesignProfile {
  return extractSiteDesign([
    {
      url: 'https://heritage.test/',
      kind: 'home',
      html: fixture('shopify-home.html'),
      sheets: [
        {
          url: 'https://cdn.shopify.com/s/files/1/0001/theme.css',
          css: fixture('shopify-theme.css'),
        },
      ],
    },
  ])
}

describe('brandDesignContext()：四个岗位共用的那一份（71 §5 第一条）', () => {
  it('没有规范时 `present: false`、提示词是空串 —— 调用方照常干活', () => {
    expect(brandDesignContext()).toEqual(EMPTY_BRAND_DESIGN_CONTEXT)
    expect(brandDesignContext({ profile: {} }).present).toBe(false)
    expect(brandDesignContext({ profile: {} }).prompt).toBe('')
  })

  it('有规范时出一段人话，色与字都在里面', () => {
    const ctx = brandDesignContext({ profile: heritage() })
    expect(ctx.present).toBe(true)
    expect(ctx.prompt).toContain('#b8422e')
    expect(ctx.prompt).toContain('Public Sans')
    expect(ctx.palette).toContain('#b8422e')
    expect(ctx.fonts).toEqual(['Public Sans'])
  })

  it('没抓到的项**整行不出现**，而不是写"未指定"（那会被当成一条指令）', () => {
    const ctx = brandDesignContext({
      profile: {
        colors: {
          primary: { value: '#123456', confidence: 'high', source: [{ origin: 'manual' }] },
        },
      },
    })
    expect(ctx.prompt).not.toContain('未指定')
    expect(ctx.prompt).not.toContain('字：')
    expect(ctx.prompt).not.toContain('圆角：')
  })

  it('够短 —— 这段话每次出活都要烧一遍钱', () => {
    expect(brandDesignContext({ profile: heritage() }).prompt.length).toBeLessThanOrEqual(
      MAX_CONTEXT_CHARS,
    )
  })

  it('四个岗位各多一句，且**只多一句**', () => {
    const base = brandDesignContext({ profile: heritage() }).prompt
    for (const role of ['design', 'site', 'social', 'ads'] as const) {
      const withRole = brandDesignContext({ profile: heritage(), role }).prompt
      expect(withRole.split('\n')).toHaveLength(base.split('\n').length + 1)
    }
    expect(brandDesignContext({ profile: heritage(), role: 'ads' }).prompt).toContain('对比度')
  })

  it('裸令牌也一起给（主题沙箱 WP89 与自检拿它比对）', () => {
    expect(brandDesignContext({ profile: heritage() }).tokens.colors?.primary).toBe('#b8422e')
  })
})

describe('规范自检：只提示，不拦人（71 §5 第二条）', () => {
  const profile = heritage()

  it('没有规范就不检查 —— 一个还没抓过规范的工作区不该每张图都报警', () => {
    expect(checkAgainstDesign({}, { colors: ['#ff7a00'], fonts: ['Comic Sans'] })).toEqual([])
  })

  it('色板外的颜色报一条，并给出色板里最接近的那个', () => {
    const findings = checkAgainstDesign(profile, { colors: ['#ff7a00'] })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('color_off_palette')
    expect(findings[0]?.message_zh).toContain('#ff7a00')
    expect(findings[0]?.suggestion).toBeDefined()
  })

  it('色板里的颜色不报（差一两个色阶也算在里面）', () => {
    expect(checkAgainstDesign(profile, { colors: ['#b8422e'] })).toEqual([])
    expect(checkAgainstDesign(profile, { colors: ['#b9432f'] })).toEqual([])
  })

  it('同一个色只报一次', () => {
    expect(checkAgainstDesign(profile, { colors: ['#ff7a00', '#ff7a00'] })).toHaveLength(1)
  })

  it('出图那条路上手里只有提示词 —— 从文本里把颜色抽出来一起查', () => {
    expect(extractColorsFromText('背景 #FF7A00，文字 rgb(255,255,255)')).toEqual([
      '#ff7a00',
      '#ffffff',
    ])
    const findings = checkAgainstDesign(profile, { text: '主视觉用 #ff7a00 的渐变' })
    expect(findings.map((f) => f.kind)).toEqual(['color_off_palette'])
  })

  it('字体表外的字体报一条', () => {
    const findings = checkAgainstDesign(profile, { fonts: ['Comic Sans MS'] })
    expect(findings[0]?.kind).toBe('font_off_list')
    expect(findings[0]?.suggestion).toBe('Public Sans')
  })

  it('对比度按 WCAG AA；大字那一档松一格', () => {
    const findings = checkAgainstDesign(profile, {
      pairs: [{ fg: '#999999', bg: '#ffffff', where: '正文' }],
    })
    expect(findings[0]?.kind).toBe('contrast')
    expect(findings[0]?.message_zh).toContain('正文')
    expect(
      checkAgainstDesign(profile, { pairs: [{ fg: '#767676', bg: '#ffffff', large: true }] }),
    ).toEqual([])
  })

  it('半透明前景先压到背景上再算 —— 否则会得出一个漂亮但假的 21:1', () => {
    const fg = parseColor('rgba(0,0,0,0.4)')
    const bg = parseColor('#ffffff')
    expect(fg).toBeDefined()
    expect(bg).toBeDefined()
    if (fg === undefined || bg === undefined) return
    expect(contrastRatio(fg, bg)).toBeLessThan(5)
  })

  it('logo 画得太小 / 留白不够，各报一条', () => {
    const withRule: BrandDesignProfile = {
      ...profile,
      logos: {
        value: [{ url: 'x', variant: 'light', min_width_px: 24, clear_space_ratio: 0.5 }],
        confidence: 'high',
        source: [{ origin: 'file', page: 2 }],
      },
    }
    const findings = checkAgainstDesign(withRule, { logo: { width_px: 16, clear_space_px: 2 } })
    expect(findings.map((f) => f.kind)).toEqual(['logo_min_size', 'logo_clear_space'])
    expect(findings[1]?.suggestion).toBe('8px')
  })

  it('每一条都有中英两句 —— 界面按语言挑一句，不在渲染时拼字符串', () => {
    for (const f of checkAgainstDesign(profile, { colors: ['#ff7a00'], fonts: ['Comic Sans'] })) {
      expect(f.message_zh.length).toBeGreaterThan(0)
      expect(f.message_en.length).toBeGreaterThan(0)
    }
  })
})

describe('颜色那几个数学函数', () => {
  it('认得 hex / rgb / hsl / 几个名字；认不得的回 undefined，不猜', () => {
    expect(parseColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 })
    expect(parseColor('rgb(1 2 3 / 0.5)')?.a).toBe(0.5)
    expect(parseColor('hsl(0, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseColor('oklch(0.7 0.1 30)')).toBeUndefined()
    expect(parseColor('var(--x)')).toBeUndefined()
    expect(parseColor('currentColor')).toBeUndefined()
  })

  it('色板比对与"最接近的那个"', () => {
    expect(inPalette('#1a1c1e', ['#1b1d1f'])).toBe(true)
    expect(inPalette('#1a1c1e', ['#ffffff'])).toBe(false)
    expect(nearestColor('#ff0000', ['#00ff00', '#ee1111'])).toBe('#ee1111')
    expect(nearestColor('#ff0000', ['#00ff00'], 10)).toBeUndefined()
  })
})
