import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrandDesignProfile } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { extractFileDesign, parsePrintColor } from '../src/file-design.js'
import { conflictCount, editValue, mergeDesignProfile, mergeValue } from '../src/merge.js'
import { cmykToHex, pdfPages } from '../src/pdf.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BOOK = readFileSync(join(HERE, 'fixtures', 'brand-book.pdf'))

describe('PDF：零依赖的文字与填充色读取', () => {
  it('两页都读出来了，页码从 1 数', () => {
    const pages = pdfPages(BOOK)
    expect(pages.map((p) => p.page)).toEqual([1, 2])
    expect(pages[0]?.text).toContain('Heritage Supply Brand Book')
    expect(pages[1]?.text).toContain('Public Sans')
  })

  it('页面上真画出来的那几块填充色也读得到', () => {
    const pages = pdfPages(BOOK)
    expect(pages[0]?.colors).toEqual(['#a8321f', '#1a1c1e', '#f7f5f2'])
    // 第二页只有文字，没有色块 —— 不该凭空冒出颜色
    expect(pages[1]?.colors).toEqual([])
  })

  it('页数上限管用', () => {
    expect(pdfPages(BOOK, { maxPages: 1 })).toHaveLength(1)
  })

  it('不是 PDF、或者写坏了的，回空，**不抛**', () => {
    expect(pdfPages(new Uint8Array([1, 2, 3]))).toEqual([])
    expect(pdfPages(Buffer.from('%PDF-1.4\n garbage'))).toEqual([])
  })
})

describe('印刷色原样留着（71 §2）', () => {
  it('Pantone **不换算** —— 没有不带授权的对照表能给出准确的 HEX', () => {
    const c = parsePrintColor('PANTONE 186 C')
    expect(c).toEqual({ raw: 'PANTONE 186 C', space: 'pantone' })
    expect(c?.hex).toBeUndefined()
  })

  it('CMYK 换一个屏幕上能画的 HEX，但原值一个字不动', () => {
    const c = parsePrintColor('C0 M100 Y81 K4')
    expect(c?.space).toBe('cmyk')
    expect(c?.raw).toBe('C0 M100 Y81 K4')
    expect(c?.hex).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('CMYK → HEX 用的是最朴素那条公式（所以原值必须留着）', () => {
    expect(cmykToHex(0, 0, 0, 0)).toBe('#ffffff')
    expect(cmykToHex(0, 0, 0, 1)).toBe('#000000')
    expect(cmykToHex(1, 0, 0, 0)).toBe('#00ffff')
  })
})

describe('手册抽取', () => {
  const result = extractFileDesign({ filename: 'brand-book.pdf', bytes: BOOK })

  it('色板按手册里**出现的顺序**排，不按统计 —— 作者是按重要性排的版', () => {
    expect(result.profile.colors?.primary?.value).toBe('#a8321f')
    expect(result.profile.colors?.surface?.value).toBe('#f7f5f2')
    expect(result.profile.colors?.['on-surface']?.value).toBe('#1a1c1e')
  })

  it('手册是规范，所以它写下来的值把握度就是 high', () => {
    expect(result.profile.colors?.primary?.confidence).toBe('high')
  })

  it('出处记得下**页码**（界面上点开能翻到那一页）', () => {
    const source = result.profile.colors?.primary?.source[0]
    expect(source?.origin).toBe('file')
    expect(source?.page).toBe(1)
    expect(source?.quote).toBe('#A8321F')
  })

  it('字体名读得出来', () => {
    expect(result.profile.typography?.h1?.value.fontFamily).toBe('Public Sans')
    expect(result.profile.typography?.['body-md']?.value.fontFamily).toBe('Space Grotesk')
  })

  it('logo 的最小尺寸与留白读得出来', () => {
    const logo = result.profile.logos?.value[0]
    expect(logo?.min_width_px).toBe(24)
    expect(logo?.clear_space_ratio).toBe(0.5)
  })

  it('印刷色三种写法都收着了', () => {
    expect(result.printColors.map((c) => c.space)).toEqual(
      expect.arrayContaining(['hex', 'cmyk', 'pantone']),
    )
    expect(result.printColors.find((c) => c.space === 'pantone')?.raw).toBe('PANTONE 186 C')
  })

  it('扫描件：**如实说读不到**，不编一份规范出来', () => {
    const empty = extractFileDesign({ filename: '扫描版手册.pdf', bytes: new Uint8Array([0]) })
    expect(empty.profile).toEqual({})
    expect(empty.failure).toContain('扫描件')
    expect(empty.contributed).toEqual([])
  })
})

/* ── 合并与冲突 ──────────────────────────────────────────────────── */

const siteValue = (hex: string): BrandDesignProfile['colors'] => ({
  primary: {
    value: hex,
    confidence: 'medium',
    source: [{ origin: 'site', url: 'https://x.test/' }],
  },
})
const fileValue = (hex: string): BrandDesignProfile['colors'] => ({
  primary: { value: hex, confidence: 'high', source: [{ origin: 'file', page: 1 }] },
})

describe('三条来路合一份（71 §2）', () => {
  it('**用户改过的格子，整格不动** —— 一个吃掉过手工修改的按钮就死了', () => {
    const previous: BrandDesignProfile = { colors: { primary: editValue('#123456', '2026-09-19') } }
    const merged = mergeDesignProfile(previous, { colors: siteValue('#abcdef') })
    expect(merged.colors?.primary?.value).toBe('#123456')
    expect(merged.colors?.primary?.edited).toBe(true)
    // 连出处都不刷新
    expect(merged.colors?.primary?.source[0]?.origin).toBe('manual')
  })

  it('手册赢官网 —— 文件里写的是规范，官网是实现', () => {
    const merged = mergeDesignProfile(
      { colors: siteValue('#b8422e') },
      { colors: fileValue('#a8321f') },
    )
    expect(merged.colors?.primary?.value).toBe('#a8321f')
  })

  it('但输的那个**留着**，不删 —— 界面上并排让用户点一下', () => {
    const merged = mergeDesignProfile(
      { colors: siteValue('#b8422e') },
      { colors: fileValue('#a8321f') },
    )
    expect(merged.colors?.primary?.conflict?.value).toBe('#b8422e')
    expect(merged.colors?.primary?.conflict?.source[0]?.origin).toBe('site')
    expect(conflictCount(merged)).toBe(1)
  })

  it('顺序反过来也一样：先有手册、后抓官网，手册照样赢', () => {
    const merged = mergeDesignProfile(
      { colors: fileValue('#a8321f') },
      { colors: siteValue('#b8422e') },
    )
    expect(merged.colors?.primary?.value).toBe('#a8321f')
    expect(merged.colors?.primary?.conflict?.value).toBe('#b8422e')
  })

  it('两边说的是同一个值：出处并起来，把握度取高的那一档', () => {
    const merged = mergeDesignProfile(
      { colors: siteValue('#a8321f') },
      { colors: fileValue('#a8321f') },
    )
    expect(merged.colors?.primary?.confidence).toBe('high')
    expect(merged.colors?.primary?.source).toHaveLength(2)
    expect(merged.colors?.primary?.conflict).toBeUndefined()
  })

  it('这一轮没抽到、上一轮有的，**留着上一轮的** —— 抓不到不等于这一格空了', () => {
    const merged = mergeDesignProfile({ colors: siteValue('#b8422e') }, {})
    expect(merged.colors?.primary?.value).toBe('#b8422e')
    expect(mergeValue({ value: 1, confidence: 'high', source: [] }, undefined)?.value).toBe(1)
  })

  it('大小写与空白不算"不一样"', () => {
    const a: BrandDesignProfile = {
      name: { value: 'Heritage Supply', confidence: 'high', source: [{ origin: 'site' }] },
    }
    const b: BrandDesignProfile = {
      name: {
        value: ' heritage supply ',
        confidence: 'high',
        source: [{ origin: 'file', page: 1 }],
      },
    }
    expect(mergeDesignProfile(a, b).name?.conflict).toBeUndefined()
  })
})
