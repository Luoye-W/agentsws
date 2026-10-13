/**
 * WP301（决策 399 = A）：按店里那一份 Horizon 的 schema 现生成目录、写模板时对着目录查。
 *
 * 用的是手写的 Horizon 形状假主题（`FAKE_HORIZON_FILES`，不是 Horizon 的拷贝）。真 Horizon 4.2.0 上量过一次
 * （没提交，见 WP301 报告）：40 个分区、95 个块，CATALOG.json ≈ 38 万字、CATALOG.index.json ≈ 1.1 万字，
 * 主题自带的模板 / section 组对着目录查 0 个问题。
 */
import { describe, expect, it } from 'vitest'
import {
  acceptsText,
  buildThemeCatalog,
  catalogIndexOf,
  isHorizon,
  isLayoutJson,
  isLegacyTheme,
  liquidSchemaOf,
  parseThemeJson,
  stripJsonComments,
  templateProblems,
  themeInfoOf,
} from '../src/horizon-catalog.js'
import { FAKE_HORIZON_FILES, FAKE_LEGACY_THEME_FILES } from '../src/site-theme-stand-in.js'

const files: Readonly<Record<string, string>> = FAKE_HORIZON_FILES
const catalog = buildThemeCatalog({
  list: (dir) =>
    Object.keys(files)
      .filter((rel) => rel.startsWith(`${dir}/`))
      .sort(),
  read: (rel) => files[rel],
})
const entry = (id: string) => catalog.entries.find((e) => e.id === id)

describe('读主题 JSON / schema / theme_info', () => {
  it('注释头去掉；字符串里的 /* 与 // 不动', () => {
    const text = '/* header\n * auto-generated */\n{"a":"http://x/*y*/","b":1} // tail\n'
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 'http://x/*y*/', b: 1 })
    expect(parseThemeJson(files['templates/index.json'] ?? '')).toMatchObject({
      order: ['hero'],
    })
    expect(parseThemeJson('{oops')).toBeUndefined()
  })

  it('{% schema %} 那一段（{%- -%} 也认）；没有 / 读不懂回 undefined', () => {
    expect(liquidSchemaOf('<p></p>{%- schema -%}{"name":"x"}{%- endschema -%}')).toEqual({
      name: 'x',
    })
    expect(liquidSchemaOf('<p>no schema</p>')).toBeUndefined()
    expect(liquidSchemaOf('{% schema %}{bad{% endschema %}')).toBeUndefined()
  })

  it('theme_info：Horizon 认得出（后台改显示名不影响）；旧的自带主题也认得出', () => {
    const info = themeInfoOf(files['config/settings_schema.json'])
    expect(info).toEqual({
      theme_name: 'Horizon',
      theme_version: '9.9.9-fixture',
      theme_author: 'Shopify',
    })
    expect(isHorizon(info)).toBe(true)
    expect(isHorizon({ theme_name: 'Dawn' })).toBe(false)
    expect(isHorizon(undefined)).toBe(false)
    const legacy = themeInfoOf(FAKE_LEGACY_THEME_FILES['config/settings_schema.json'])
    expect(isLegacyTheme(legacy)).toBe(true)
    expect(legacy?.theme_version).toBe('0.10.0')
    expect(themeInfoOf(undefined)).toBeUndefined()
    expect(themeInfoOf('[]')).toBeUndefined()
  })
})

describe('生成目录', () => {
  it('分区 / 块各一项：名字翻成英文标签、私有块标出来、收哪些块原样给、静态块从预设里找出来', () => {
    expect(catalog.theme).toBe('Horizon 9.9.9-fixture')
    expect(catalog.entries.filter((e) => e.kind === 'section').map((e) => e.id)).toEqual([
      'footer',
      'header',
      'hero',
      'product-list',
      'section',
    ])
    expect(catalog.entries.filter((e) => e.kind === 'block').map((e) => e.id)).toEqual([
      '_divider',
      '_heading',
      'button',
      'group',
      'text',
    ])
    expect(entry('hero')).toMatchObject({
      kind: 'section',
      file: 'sections/hero.liquid',
      name: 'Hero',
      category: 'Banners',
      accepts_blocks: ['@theme', '_heading'],
      static_blocks: [{ id: 'heading', type: '_heading' }],
      use_when: 'Hero · Banners｜收：全部公开块、_heading',
    })
    expect(entry('hero')?.settings[0]).toEqual({
      id: 'height',
      type: 'select',
      label: 'Height',
      default: 'large',
      options: [
        { value: 'small', label: 'Small' },
        { value: 'large', label: 'Large' },
      ],
    })
    // 排版用的 header / paragraph 不收
    expect(entry('section')?.settings.map((s) => s.id)).toEqual(['section_height'])
    expect(entry('_divider')).toMatchObject({ private: true, name: 'Divider' })
    expect(entry('_divider')?.settings[0]).toMatchObject({ min: 1, max: 8, step: 1, unit: 'px' })
    expect(entry('header')).toMatchObject({ enabled_on: { groups: ['header'] } })
    expect(catalog.theme_settings.map((g) => g.group)).toEqual(['Colors', 'Typography'])
    expect(catalog.templates).toEqual(['index.json', 'product.json'])
    expect(catalog.section_groups).toEqual([
      { file: 'sections/footer-group.json', type: 'footer' },
      { file: 'sections/header-group.json', type: 'header' },
    ])
  })

  it('瘦目录：每个分区 / 块一行，说清收哪些块', () => {
    const index = catalogIndexOf(catalog) as {
      sections: unknown[]
      blocks: unknown[]
      how_to: string[]
    }
    expect(index.sections).toContainEqual({
      id: 'section',
      name: 'Section',
      category: 'Layout',
      accepts: '全部公开块、应用块、_divider',
    })
    expect(index.blocks).toContainEqual({ id: '_heading', name: 'Heading', private: true })
    expect(index.how_to.join('\n')).toContain('@theme = 所有不以 _ 开头的公开块')
    expect(acceptsText(undefined)).toBe('不收块')
    expect(acceptsText(['text', 'button'])).toBe('text、button')
  })
})

describe('写模板时对着目录查（只提醒、不拦）', () => {
  const check = (doc: unknown, rel = 'templates/index.json'): string[] =>
    templateProblems(rel, JSON.stringify(doc), catalog)

  it('主题自带的模板与 section 组：0 个问题', () => {
    for (const rel of Object.keys(files).filter(isLayoutJson))
      expect(templateProblems(rel, files[rel] ?? '', catalog), rel).toEqual([])
    expect(isLayoutJson('templates/customers/account.json')).toBe(true)
    expect(isLayoutJson('config/settings_data.json')).toBe(false)
  })

  it('@theme 收公开块、不收没点名的私有块；静态块照收；应用块看 @app', () => {
    expect(
      check({
        sections: {
          a: {
            type: 'section',
            blocks: {
              g: {
                type: 'group',
                blocks: { t: { type: 'text' }, d: { type: '_divider' } },
                block_order: ['t', 'd'],
              },
              app: { type: 'shopify://apps/reviews/blocks/stars/123' },
            },
            block_order: ['g', 'app'],
          },
          h: { type: 'hero', blocks: { heading: { type: '_heading', static: true } } },
        },
        order: ['a', 'h'],
      }),
    ).toEqual([])
    expect(
      check({
        sections: {
          p: {
            type: 'product-list',
            blocks: {
              h: { type: '_heading' },
              app: { type: 'shopify://apps/x/blocks/y/1' },
              ghost: { type: 'carousel-slide' },
            },
          },
          x: { type: 'nope' },
        },
        order: ['p', 'x'],
      }),
    ).toEqual([
      'templates/index.json：分区 p（product-list） 里的块 h（_heading）放错了地方：product-list 收的是 全部公开块',
      'templates/index.json：分区 p（product-list） 里的块 app 是应用块，但 product-list 不收应用块',
      'templates/index.json：分区 p（product-list） 里的块 ghost 用了 carousel-slide，这份主题没有这个块',
      'templates/index.json：分区实例 x 用了 nope，这份主题没有这个分区',
    ])
  })

  it('设置 id 不对、顺序里指着不存在的实例、嵌太深、不是 JSON、没有 sections', () => {
    expect(
      check({
        sections: { h: { type: 'hero', settings: { height: 'small', heigth: 'x' } } },
        order: ['h', 'missing'],
      }),
    ).toEqual([
      'templates/index.json：分区 h（hero） 的设置 heigth 在目录里没有（照 CATALOG.json 那一项的 settings 抄 id）',
      'templates/index.json：页面 的顺序里有 missing，但没有这个实例',
    ])
    let deep: Record<string, unknown> = { type: 'text' }
    for (let i = 0; i < 9; i++) deep = { type: 'group', blocks: { g: deep } }
    expect(
      check({ sections: { s: { type: 'section', blocks: { g: deep } } }, order: ['s'] }).some((p) =>
        p.includes('超过 8 层'),
      ),
    ).toBe(true)
    expect(templateProblems('templates/x.json', '{oops', catalog)).toEqual([
      'templates/x.json 不是合法的 JSON（开头的注释可以留，其余要是 JSON）',
    ])
    expect(check({ order: [] })).toEqual(['templates/index.json 没有 sections'])
  })
})
