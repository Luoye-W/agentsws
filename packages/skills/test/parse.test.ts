import { describe, expect, it } from 'vitest'
import {
  bodyHash,
  headingSimilarity,
  jaccard,
  renderSkill,
  splitFrontmatter,
  splitSections,
  tokenize,
} from '../src/index.js'
import { CUSTOMER_CARE_V1, headingId, makeSkills } from './helpers.js'

describe('frontmatter', () => {
  it('缺 name → 报错（Agent Skills 必填）', () => {
    const { skills } = makeSkills()
    expect(() => skills.registry.parse('---\ndescription: 没有 name\n---\n\n## a\n\nb\n')).toThrow(
      /缺少 name/,
    )
  })

  it('没有 frontmatter 或没闭合 → 报错', () => {
    const { skills } = makeSkills()
    expect(() => skills.registry.parse('## a\n\nb\n')).toThrow(/frontmatter/)
    expect(() => skills.registry.parse('---\nname: x\n\n## a\n')).toThrow(/没有闭合/)
  })

  it('支持引号、块标量与额外键，渲染时保持', () => {
    const doc = splitFrontmatter(
      [
        '---',
        'name: "x-skill"',
        'description: >',
        '  第一行',
        '  第二行',
        'license: Apache-2.0',
        '---',
        '',
        '## a',
        '',
        'b',
      ].join('\n'),
    )
    expect(doc.frontmatter.name).toBe('x-skill')
    expect(doc.frontmatter.description).toBe('第一行 第二行')
    expect(doc.frontmatter.extra.license).toBe('Apache-2.0')
    const md = renderSkill(doc.frontmatter, [
      { id: '1', heading: 'a', body: 'b', origin: 'authored' },
    ])
    expect(md).toContain('license: Apache-2.0')
    expect(md).toContain('## a')
  })

  it('字面块标量保留换行', () => {
    const doc = splitFrontmatter('---\nname: x\nnote: |\n  一\n  二\n---\n\n正文\n')
    expect(doc.frontmatter.extra.note).toBe('一\n二')
  })
})

describe('切段', () => {
  it('按 ## 切段，### 与代码围栏里的 ## 不算标题', () => {
    const sections = splitSections(
      [
        '前言在这里',
        '',
        '## 一',
        '',
        '### 子标题',
        '正文',
        '',
        '```md',
        '## 假标题',
        '```',
        '',
        '## 二',
        '',
        'x',
      ].join('\n'),
    )
    expect(sections.map((s) => s.heading)).toEqual(['', '一', '二'])
    expect(sections[1]?.body).toContain('## 假标题')
  })

  it('空文档不产生空段', () => {
    expect(splitSections('\n\n')).toEqual([])
  })
})

describe('段 id 对齐', () => {
  it('给每段发隐藏 ULID，id 唯一且长度 26', () => {
    const { skills } = makeSkills()
    const sections = skills.registry.parse(CUSTOMER_CARE_V1)
    expect(sections).toHaveLength(4)
    expect(new Set(sections.map((s) => s.id)).size).toBe(4)
    for (const s of sections) expect(s.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(sections.every((s) => s.origin === 'authored')).toBe(true)
  })

  it('改标题不改 id（正文哈希对齐）', () => {
    const { skills } = makeSkills()
    const v1 = skills.registry.parse(CUSTOMER_CARE_V1)
    const renamed = CUSTOMER_CARE_V1.replace('## 退换货判定', '## 退换货规则')
    const v2 = skills.registry.parse(renamed, v1)
    expect(headingId(v2, '退换货规则')).toBe(headingId(v1, '退换货判定'))
    expect(v2.map((s) => s.id)).toEqual(v1.map((s) => s.id))
  })

  it('改正文不改 id（标题精确对齐）', () => {
    const { skills } = makeSkills()
    const v1 = skills.registry.parse(CUSTOMER_CARE_V1)
    const edited = CUSTOMER_CARE_V1.replace('不回显卡号。', '不回显卡号，不承诺时效。')
    const v2 = skills.registry.parse(edited, v1)
    expect(headingId(v2, '禁止事项')).toBe(headingId(v1, '禁止事项'))
  })

  it('标题近似（> 0.8）也能对齐：标题和正文同时变也不丢 id', () => {
    const { skills } = makeSkills()
    const v1 = skills.registry.parse('---\nname: t\n---\n\n## Return Window\n\n按 14 天算。\n')
    const v2 = skills.registry.parse(
      '---\nname: t\n---\n\n## Return Windows\n\n完全不同的一段正文。\n',
      v1,
    )
    expect(headingSimilarity('Return Window', 'Return Windows')).toBeGreaterThan(0.8)
    expect(v2[0]?.id).toBe(v1[0]?.id)
  })

  it('一段拆两段：第一段保留旧 id，全组记 split_from', () => {
    const { skills } = makeSkills()
    const v1 = skills.registry.parse(CUSTOMER_CARE_V1)
    const oldId = headingId(v1, '退换货判定')
    const split = CUSTOMER_CARE_V1.replace(
      '## 退换货判定\n\n按记录状态 + 送达日 + 今天 vs 条款窗口算。',
      '## 退换货判定\n\n按记录状态 + 送达日\n\n## 窗口口径\n\n今天 vs 条款窗口算。',
    )
    const doc = skills.registry.parseDocument(split, v1)
    const first = doc.sections.find((s) => s.heading === '退换货判定')
    const second = doc.sections.find((s) => s.heading === '窗口口径')
    expect(first?.id).toBe(oldId)
    expect(first?.split_from).toBe(oldId)
    expect(second?.id).not.toBe(oldId)
    expect(second?.split_from).toBe(oldId)
    expect(doc.splits).toEqual([{ from: oldId, sections: [oldId, second?.id] }])
  })

  it('新增段拿新 id，删除段的 id 不复用', () => {
    const { skills } = makeSkills()
    const v1 = skills.registry.parse(CUSTOMER_CARE_V1)
    const added = `${CUSTOMER_CARE_V1}\n## 升级路径\n\n三次没解决就转人工。\n`
    const v2 = skills.registry.parse(added, v1)
    expect(v2).toHaveLength(5)
    expect(v2.slice(0, 4).map((s) => s.id)).toEqual(v1.map((s) => s.id))
    expect(v1.map((s) => s.id)).not.toContain(headingId(v2, '升级路径'))
  })
})

describe('文本工具', () => {
  it('哈希只看规范化后的正文', () => {
    expect(bodyHash('  a\r\nb  ')).toBe(bodyHash('a\nb'))
  })

  it('中英文混排分词与 Jaccard', () => {
    expect(tokenize('Hi there，开头用 Hi')).toEqual(['hi', 'there', '开', '头', '用', 'hi'])
    expect(jaccard('开头用 Hi there', '开头用 Hi there')).toBe(1)
    expect(jaccard('', '')).toBe(1)
    expect(jaccard('完全不同', 'totally other')).toBe(0)
  })

  it('标题相似度：相同 1、空 0、短标题回落到相等判断', () => {
    expect(headingSimilarity('退货', '退货')).toBe(1)
    expect(headingSimilarity('', '')).toBe(0)
    expect(headingSimilarity('a', 'b')).toBe(0)
    expect(headingSimilarity('退换货判定', '退换货规则')).toBeLessThan(0.8)
  })
})
