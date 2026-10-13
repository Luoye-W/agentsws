/**
 * WP304（决策 445）：不只 Horizon——任何 Online Store 2.0 主题都按它自己的 schema 现生成目录；老主题认作「太老」。
 *
 * 夹具全是手写的最小 schema（`FAKE_OS2_THEME_FILES` 是编的 Lumen，Dawn 那一代形状；`FAKE_VINTAGE_THEME_FILES`
 * 只有 `.liquid` 模板），不是任何真主题的拷贝。
 */
import { describe, expect, it } from 'vitest'
import {
  buildThemeCatalog,
  CATALOG_HOW_TO,
  catalogIndexOf,
  isOs2Templates,
  templateProblems,
} from '../src/horizon-catalog.js'
import {
  FAKE_HORIZON_FILES,
  FAKE_OS2_THEME_FILES,
  FAKE_VINTAGE_THEME_FILES,
} from '../src/site-theme-stand-in.js'

const catalogOf = (files: Readonly<Record<string, string>>) =>
  buildThemeCatalog({
    list: (dir) =>
      Object.keys(files)
        .filter((rel) => rel.startsWith(`${dir}/`))
        .sort(),
    read: (rel) => files[rel],
  })

describe('任意 Online Store 2.0 主题（WP304）', () => {
  it('Dawn 那一代形状：本地块、没有主题块 / section 组——写法照实记，how_to 不提 @theme', () => {
    const c = catalogOf(FAKE_OS2_THEME_FILES)
    expect(c.theme).toBe('Lumen 1.0.0-fixture')
    expect(c.capabilities).toEqual({
      os2: true,
      theme_blocks: false,
      at_theme: false,
      private_blocks: false,
      static_blocks: false,
      app_blocks: true,
      local_blocks: true,
      section_groups: false,
    })
    const banner = c.entries.find((e) => e.id === 'image-banner')
    expect(banner?.name).toBe('Image banner')
    expect(banner?.local_blocks?.map((b) => b.type)).toEqual(['heading', 'buttons'])
    expect(banner?.local_blocks?.[0]?.name).toBe('Heading')
    const how = c.how_to.join('\n')
    expect(how).toMatch(/local_blocks/)
    expect(how).not.toMatch(/@theme|static|header-group/)
    // 瘦目录照样出
    const index = catalogIndexOf(c) as { sections: { id: string }[]; blocks: unknown[] }
    expect(index.sections.map((s) => s.id).sort()).toEqual([
      'footer',
      'header',
      'image-banner',
      'rich-text',
    ])
    expect(index.blocks).toEqual([])
  })

  it('它自带的模板对着目录查 0 个问题；块用错 / 设置 id 写错照样查得出', () => {
    const c = catalogOf(FAKE_OS2_THEME_FILES)
    expect(
      templateProblems(
        'templates/index.json',
        FAKE_OS2_THEME_FILES['templates/index.json'] ?? '',
        c,
      ),
    ).toEqual([])
    const bad = JSON.stringify({
      sections: {
        banner: {
          type: 'image-banner',
          blocks: {
            x: { type: 'slide', settings: {} },
            h: { type: 'heading', settings: { size: 1 } },
          },
          block_order: ['x', 'h'],
        },
      },
      order: ['banner'],
    })
    const problems = templateProblems('templates/index.json', bad, c)
    expect(problems.some((p) => p.includes('slide'))).toBe(true)
    expect(problems.some((p) => p.includes('size'))).toBe(true)
  })

  it('Horizon 照旧：写法全有，how_to 与 WP301 那一份一字不差', () => {
    const c = catalogOf(FAKE_HORIZON_FILES)
    expect(c.capabilities?.os2).toBe(true)
    expect(c.capabilities?.at_theme).toBe(true)
    expect(c.how_to).toEqual(CATALOG_HOW_TO)
  })

  it('老主题（只有 .liquid 模板）不是 2.0', () => {
    expect(catalogOf(FAKE_VINTAGE_THEME_FILES).capabilities?.os2).toBe(false)
    expect(isOs2Templates(['index.liquid', 'product.liquid'])).toBe(false)
    expect(isOs2Templates(['templates/index.json'])).toBe(true)
    expect(isOs2Templates(['customers/account.json'])).toBe(true)
  })
})
