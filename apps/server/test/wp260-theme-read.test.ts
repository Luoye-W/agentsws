/**
 * WP260：`theme_read_file` 回给模型的那一页——长文件分页、CATALOG.json 目录页 / 按 ids 挑、形状对不上照普通文件。
 */
import { THEME_READ_PAGE_CHARS } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { FAKE_THEME_FILES } from '../src/site-theme-stand-in.js'
import { themeReadPage } from '../src/theme-read.js'
import { wp260ThemeFiles } from './fixtures/wp260-theme.js'

const files = wp260ThemeFiles()
const catalog = { path: 'CATALOG.json', content: files['CATALOG.json'] ?? '' }

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
    expect(p2.next_offset).toBeUndefined()
    expect(p2.content).toContain('END-OF-FAQ')
    expect(p1.content + p2.content).toBe(faq.content)
  })

  it('CATALOG.json 不给 ids：一页目录（每项一行），远小于原文', () => {
    const page = themeReadPage(catalog, {})
    expect(page.catalog).toBe('index')
    expect(page.content).toContain('72 个分区、57 个块、50 个片段')
    expect(page.content).toContain('- section faq:')
    expect(page.content).toContain('- block heading:')
    expect(page.content.length).toBeLessThan(THEME_READ_PAGE_CHARS)
    expect(catalog.content.length).toBeGreaterThan(500_000)
  })

  it('CATALOG.json 给 ids：那几项的完整设置（去掉 assets 等），没找到的列出来', () => {
    const page = themeReadPage(catalog, { ids: ['hero', 'faq', 'nope', 'theme_settings'] })
    expect(page.catalog).toBe('entries')
    expect(page.missing).toEqual(['nope'])
    const parsed = JSON.parse(page.content) as { entries: { id: string; assets?: unknown }[] }
    expect(parsed.entries.map((e) => e.id)).toEqual(['hero', 'faq', 'theme_settings'])
    expect(parsed.entries.every((e) => e.assets === undefined)).toBe(true)
  })

  it('一次要太多项：放不下的写进 more_ids，另读一次', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `section-${i}`)
    const page = themeReadPage(catalog, { ids })
    expect(page.more_ids?.length).toBeGreaterThan(0)
    expect(page.content.length).toBeLessThan(45_000)
  })

  it('CATALOG.json 形状对不上（demo 的占位包）就当普通文件', () => {
    const demo = { path: 'CATALOG.json', content: FAKE_THEME_FILES['CATALOG.json'] ?? '' }
    expect(themeReadPage(demo, {})).toEqual(demo)
  })
})
