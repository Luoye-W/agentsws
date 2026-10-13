/**
 * WP260：`theme_read_file` 回给模型的那一页——长文件分页、CATALOG.json 目录页 / 按 ids 挑、形状对不上照普通文件。
 * WP301：CATALOG.json 是工坊按店里那一份 Horizon 的 schema 现生成的（`horizon-catalog.ts`），这里照样生成一份来切。
 */
import { THEME_READ_PAGE_CHARS } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { buildThemeCatalog } from '../src/horizon-catalog.js'
import { themeReadPage } from '../src/theme-read.js'
import { wp260ThemeFiles } from './fixtures/wp260-theme.js'

const files = wp260ThemeFiles()
const generated = buildThemeCatalog({
  list: (dir) =>
    Object.keys(files)
      .filter((rel) => rel.startsWith(`${dir}/`))
      .sort(),
  read: (rel) => files[rel],
})
const catalog = { path: 'CATALOG.json', content: JSON.stringify(generated) }

/** 一份很大的目录（每项一堆设置），测「按 ids 挑放不下」用。 */
const big = {
  path: 'CATALOG.json',
  content: JSON.stringify({
    theme: 'Horizon 9.9.9-fixture',
    entries: Array.from({ length: 40 }, (_, i) => ({
      id: `section-${i}`,
      kind: 'section',
      use_when: `section ${i}`,
      settings: Array.from({ length: 30 }, (_, j) => ({
        id: `s_${j}`,
        type: 'text',
        label: 'x'.repeat(60),
      })),
    })),
  }),
}

describe('themeReadPage', () => {
  it('小文件原样回 { path, content }（老形状不变）', () => {
    const f = { path: 'templates/index.json', content: files['templates/index.json'] ?? '' }
    expect(themeReadPage(f, {})).toEqual(f)
  })

  it('长文件按页：第一页带总长与下一段；第二页到底（schema 在尾巴上也看得见）', () => {
    const faq = { path: 'sections/faq.liquid', content: files['sections/faq.liquid'] ?? '' }
    const p1 = themeReadPage(faq, {})
    expect(p1.content).toHaveLength(THEME_READ_PAGE_CHARS)
    expect(p1).toMatchObject({ offset: 0, total_chars: faq.content.length, next_offset: 24_000 })
    const p2 = themeReadPage(faq, { offset: p1.next_offset })
    expect(p2.next_offset).toBe(48_000)
    const p3 = themeReadPage(faq, { offset: p2.next_offset })
    expect(p3.next_offset).toBeUndefined()
    expect(p3.content).toContain('END-OF-FAQ')
    expect(p1.content + p2.content + p3.content).toBe(faq.content)
  })

  it('CATALOG.json 不给 ids：一页目录（每项一行），远小于原文', () => {
    const page = themeReadPage(catalog, {})
    expect(page.catalog).toBe('index')
    expect(page.content).toContain('Horizon 9.9.9-fixture 目录：6 个分区、5 个块。')
    expect(page.content).toContain('- section faq: Faq｜收：全部公开块、应用块')
    expect(page.content).toContain('- block heading:')
    expect(page.content).toContain('模板（templates/）：index.json')
    expect(page.content.length).toBeLessThan(THEME_READ_PAGE_CHARS)
    expect(page.content.length).toBeLessThan(catalog.content.length)
  })

  it('CATALOG.json 给 ids：那几项的完整设置（去掉 assets 等），没找到的列出来', () => {
    const page = themeReadPage(catalog, { ids: ['hero', 'faq', 'nope', 'theme_settings'] })
    expect(page.catalog).toBe('entries')
    expect(page.missing).toEqual(['nope'])
    const parsed = JSON.parse(page.content) as {
      entries: { id: string; accepts_blocks?: string[]; settings?: { id: string }[] }[]
    }
    expect(parsed.entries.map((e) => e.id)).toEqual(['hero', 'faq', 'theme_settings'])
    expect(parsed.entries[0]?.accepts_blocks).toEqual(['@theme', '@app'])
    expect(parsed.entries[0]?.settings?.map((x) => x.id)).toEqual([
      'heading',
      'text',
      'color_scheme',
    ])
  })

  it('一次要太多项：放不下的写进 more_ids，另读一次', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `section-${i}`)
    const page = themeReadPage(big, { ids })
    expect(page.more_ids?.length).toBeGreaterThan(0)
    expect(page.content.length).toBeLessThan(45_000)
  })

  it('WP296：v0.10.0 的私有块（private: true）在目录页上标「私有」，并说清分区只收 accepts_blocks 列的块', () => {
    const v010 = {
      path: 'CATALOG.json',
      content: JSON.stringify({
        theme: '0.10.0',
        entries: [
          { id: 'hero', kind: 'section', use_when: 'banner', accepts_blocks: ['heading', '@app'] },
          { id: 'heading', kind: 'block', use_when: 'a heading' },
          { id: '_product-title', kind: 'block', use_when: 'product info', private: true },
        ],
      }),
    }
    const page = themeReadPage(v010, {})
    expect(page.content).toContain('0.10.0 目录')
    expect(page.content).toContain('- block _product-title（私有）: product info')
    expect(page.content).toContain('- block heading: a heading')
    expect(page.content).toContain('accepts_blocks')
    const picked = JSON.parse(themeReadPage(v010, { ids: ['hero'] }).content) as {
      entries: { accepts_blocks?: string[] }[]
    }
    expect(picked.entries[0]?.accepts_blocks).toEqual(['heading', '@app'])
  })

  it('CATALOG.json 形状对不上（demo 的占位包）就当普通文件', () => {
    const demo = { path: 'CATALOG.json', content: '{"sections":["hero"],"blocks":[]}\n' }
    expect(themeReadPage(demo, {})).toEqual(demo)
  })
})
