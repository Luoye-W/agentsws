/**
 * WP260：「说了要做却停下」的判定、主题文件给模型看的那一段、压缩摘要。
 */
import { describe, expect, it } from 'vitest'
import {
  compactSummary,
  deliversWith,
  fileTouch,
  looksUnfinished,
  renderThemeRead,
  THEME_READ_PAGE_CHARS,
} from '../src/index.js'

describe('looksUnfinished：「我接下来要…」', () => {
  it.each([
    '现在读首页模板、FAQ/容器分区、标题块的 schema，并顺手看店里有没有可引用的商品。',
    '好的，我先读一下 AGENTS.md 和 CATALOG.json。',
    '接下来改 templates/index.json。',
    '下一步：检查并推送未发布主题。',
    '我来把这几个文件看一下：',
    '规矩读完了。接下来我去写首页模板。',
    "Now let me read the hero section's schema.",
    "I'll update templates/index.json next.",
    '',
  ])('算没做完：%s', (text) => {
    expect(looksUnfinished(text)).toBe(true)
  })

  it.each([
    '预览好了：推成了一份未发布主题「Rollout 首页 v1」，线上没动。预览：https://x/?preview_theme_id=1',
    '首页加载慢主要在三处：首屏大图没压缩、第三方脚本、字体。按影响从大到小……',
    '还没登录 Shopify。请到建站岗位页点「登录 Shopify」，登好再让我接着做。',
    '首屏横幅的文案你想用中文还是英文？',
    '改好了 3 个文件。接下来你可以打开预览看看，满意了跟我说发布。',
  ])('不算：%s', (text) => {
    expect(looksUnfinished(text)).toBe(false)
  })
})

describe('deliversWith / fileTouch', () => {
  const produce = {
    deliver_tools: ['theme_push_unpublished', 'theme_publish'],
    max_nudges: 3,
    compact_at_tokens: 48_000,
    keep_recent_results: 6,
  }
  it('带不带服务前缀都认；没有 produce 一律 false', () => {
    expect(deliversWith(produce, 'theme_push_unpublished')).toBe(true)
    expect(deliversWith(produce, 'site.theme_publish')).toBe(true)
    expect(deliversWith(produce, 'theme_read_file')).toBe(false)
    expect(deliversWith(undefined, 'theme_push_unpublished')).toBe(false)
  })
  it('读按「路径 + 哪一段」、写按路径', () => {
    expect(fileTouch('theme_read_file', { path: './AGENTS.md' })).toEqual({
      op: 'read',
      path: 'AGENTS.md',
      key: 'AGENTS.md|0|',
    })
    expect(fileTouch('theme_read_file', { path: 'CATALOG.json', ids: ['faq', 'hero'] })?.key).toBe(
      'CATALOG.json|0|faq,hero',
    )
    expect(fileTouch('theme_write_file', { path: 'templates/index.json' })?.op).toBe('write')
    expect(fileTouch('get_product', { id: 'x' })).toBeUndefined()
  })
})

describe('renderThemeRead：主题文件原文不转义、按页放宽', () => {
  it('全文：一行抬头 + 原文（换行、引号原样）', () => {
    const r = renderThemeRead('theme_read_file', {
      path: 'templates/index.json',
      content: '{\n  "order": ["hero"]\n}',
    })
    expect(r?.text).toBe(
      '主题文件 templates/index.json（全文，23 字）\n\n{\n  "order": ["hero"]\n}',
    )
    expect(r?.max_chars).toBeGreaterThan(THEME_READ_PAGE_CHARS)
  })
  it('分页：写清第几段、后面还有没有、下一段的 offset', () => {
    const r = renderThemeRead('theme_read_file', {
      path: 'sections/faq.liquid',
      content: 'x'.repeat(24_000),
      offset: 0,
      total_chars: 25_657,
      next_offset: 24_000,
    })
    expect(r?.text.split('\n')[0]).toBe(
      '主题文件 sections/faq.liquid（第 1–24,000 字，共 25,657 字；后面还有，接着读给 offset=24000）',
    )
  })
  it('别的工具不归它', () => {
    expect(renderThemeRead('theme_files', { files: [] })).toBeUndefined()
  })
})

describe('compactSummary：压掉时留路径 + 要点', () => {
  it('目录页 / 按 ids 挑的几项 / Markdown 小节', () => {
    expect(
      compactSummary(
        'theme_read_file',
        { path: 'CATALOG.json' },
        { path: 'CATALOG.json', content: '- section hero: x\n- block faq: y', catalog: 'index' },
      ),
    ).toContain('目录页，2 项')
    expect(
      compactSummary(
        'theme_read_file',
        { path: 'CATALOG.json', ids: ['hero'] },
        {
          path: 'CATALOG.json',
          content: '{"entries":[{"id":"hero","kind":"section"}]}',
          catalog: 'entries',
        },
      ),
    ).toContain('完整几项：hero')
    expect(
      compactSummary(
        'theme_read_file',
        { path: 'AGENTS.md' },
        { path: 'AGENTS.md', content: '# AGENTS\n## 1. Pick\n## 2. Rules' },
      ),
    ).toContain('小节 AGENTS, 1. Pick, 2. Rules')
  })
})
