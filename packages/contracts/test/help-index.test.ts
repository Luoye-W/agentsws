/**
 * 教程上官网（私有 docs/113）：目录格式的校验、文章元数据、版本比较。
 */
import { describe, expect, it } from 'vitest'
import {
  compareHelpVersion,
  HELP_INDEX_SCHEMA,
  helpNeedsNewerApp,
  parseHelpIndex,
  readHelpArticle,
  splitHelpFrontmatter,
} from '../src/index.js'

const HASH = 'a'.repeat(64)
const item = (over: Record<string, unknown> = {}) => ({
  kind: 'guide',
  slug: 'conn-shopify',
  lang: 'zh',
  title: '连 Shopify 店铺',
  description: '点「连接 Shopify」授权就连上了。',
  url: 'https://agentsws.com/docs/conn-shopify/',
  md: 'https://agentsws.com/docs/conn-shopify.md',
  positions: ['dtc-ops'],
  roles: [],
  group: 'connect',
  order: 110,
  updated: '2026-10-20',
  hash: HASH,
  ...over,
})

describe('parseHelpIndex', () => {
  it('合格的整份原样认下', () => {
    const idx = parseHelpIndex({
      schema: HELP_INDEX_SCHEMA,
      generated_at: '2026-10-22T00:00:00Z',
      release: '0.2.1-beta.7',
      items: [item()],
    })
    expect(idx?.items).toHaveLength(1)
    expect(idx?.items[0]?.group).toBe('connect')
    expect(idx?.release).toBe('0.2.1-beta.7')
  })

  it('格式版本不对、不是对象：整份不认', () => {
    expect(parseHelpIndex({ schema: 2, generated_at: 'x', items: [] })).toBeUndefined()
    expect(parseHelpIndex('nope')).toBeUndefined()
  })

  it('单条不合格只丢那一条：别的站的链接、坏 slug、坏指纹、未知种类', () => {
    const idx = parseHelpIndex({
      schema: HELP_INDEX_SCHEMA,
      generated_at: 'x',
      items: [
        item(),
        item({ url: 'https://evil.example/docs/x/' }),
        item({ md: 'https://agentsws.com.evil.example/x.md' }),
        item({ slug: 'Bad Slug' }),
        item({ hash: 'zz' }),
        item({ kind: 'video' }),
      ],
    })
    expect(idx?.items.map((i) => i.slug)).toEqual(['conn-shopify'])
  })

  it('换了站（开发时指到本机）就只认那个站', () => {
    const site = 'http://127.0.0.1:4500'
    const ok = item({ url: `${site}/docs/a/`, md: `${site}/docs/a.md`, slug: 'a' })
    const idx = parseHelpIndex({ schema: 1, generated_at: 'x', items: [ok, item()] }, site)
    expect(idx?.items.map((i) => i.slug)).toEqual(['a'])
  })
})

describe('文章元数据', () => {
  it('列表、字符串、引号、标题取正文第一个 #', () => {
    const text = [
      '---',
      'description: "先说答案：点一下就连上。"',
      'group: connect',
      'order: 110',
      'positions: [dtc-ops, web-ops]',
      'roles: []',
      'requires: next',
      '---',
      '# 连 **Shopify** 店铺',
      '',
      '正文',
    ].join('\n')
    const { meta, body } = readHelpArticle(text)
    expect(meta).toMatchObject({
      title: '连 Shopify 店铺',
      description: '先说答案：点一下就连上。',
      group: 'connect',
      order: 110,
      positions: ['dtc-ops', 'web-ops'],
      roles: [],
      requires: 'next',
      draft: false,
    })
    expect(body.startsWith('# 连')).toBe(true)
  })

  it('Windows 检出的 CRLF、开头带 BOM 的也认（10-23 右栏露出过元数据原文）', () => {
    const { meta, body } = readHelpArticle(
      '\uFEFF---\r\ngroup: tools\r\npositions: [kol-marketing]\r\n---\r\n# 浏览器\r\n',
    )
    expect(meta.positions).toEqual(['kol-marketing'])
    expect(meta.group).toBe('tools')
    expect(body).toBe('# 浏览器\r\n')
  })

  it('没有元数据的原样回', () => {
    expect(splitHelpFrontmatter('# A\n')).toEqual({ data: {}, body: '# A\n' })
  })

  it('笔记：title 写在头上优先于正文标题，draft', () => {
    const { meta } = readHelpArticle(
      '---\ntitle: 为什么\ndate: 2026-10-23\ndraft: true\n---\n# 别的\n',
    )
    expect(meta).toMatchObject({ title: '为什么', date: '2026-10-23', draft: true })
  })
})

describe('版本', () => {
  it('预发布小于正式版、按段比', () => {
    expect(compareHelpVersion('0.2.1-beta.7', '0.2.1-beta.10')).toBe(-1)
    expect(compareHelpVersion('0.2.1', '0.2.1-beta.10')).toBe(1)
    expect(compareHelpVersion('v0.2.2-beta.1', '0.2.1')).toBe(1)
    expect(compareHelpVersion('0.2.1-beta.7', '0.2.1-beta.7')).toBe(0)
  })

  it('这台够不够新：没写 = 够；next = 不够；开发版一律够', () => {
    expect(helpNeedsNewerApp(undefined, '0.2.1-beta.1')).toBe(false)
    expect(helpNeedsNewerApp('0.2.1-beta.6', '0.2.1-beta.5')).toBe(true)
    expect(helpNeedsNewerApp('0.2.1-beta.6', '0.2.1-beta.6')).toBe(false)
    expect(helpNeedsNewerApp('next', '0.2.1-beta.9')).toBe(true)
    expect(helpNeedsNewerApp('next', '0.0.0-dev')).toBe(false)
  })
})
