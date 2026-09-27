/** WP159：模型写改动卡初稿——提示词带品牌口吻、回文按改动卡的规矩校验。 */
import { describe, expect, it } from 'vitest'
import { parseSeoDraft, SEO_DRAFT_LIMITS, seoDraftPrompt } from '../src/drafts.js'

const META = {
  title: 'USB-C Laptop Charger | NordVolt',
  meta_description: 'A compact charger for laptops and phones.',
  h1: 'USB-C Laptop Charger',
  opening: 'It charges most laptops. It fits in a pocket.',
}

describe('seoDraftPrompt', () => {
  it('品牌档案一段与设计规范的气质都注进去；两种初稿要的 JSON 不一样', () => {
    const base = {
      query: 'usb c laptop charger',
      suggestion: '标题里没有这个词',
      evidence: '曝光 2,400、点击 12',
      page: { url: 'https://shop.example/products/c', title: 'Charger' },
      language: 'en' as const,
      brand: { name: 'NordVolt', context: 'Positioning: quiet power', voice: 'calm' },
    }
    const meta = seoDraftPrompt({ ...base, kind: 'page_seo_edit' })
    expect(meta).toContain('Positioning: quiet power')
    expect(meta).toContain('Brand voice: calm')
    expect(meta).toContain('"meta_description"')
    expect(meta).toMatch(/never invent numbers/)
    const section = seoDraftPrompt({ ...base, kind: 'page_section_add', language: 'zh' })
    expect(section).toContain('"heading"')
    expect(section).toContain('不编任何数字')
  })
})

describe('parseSeoDraft', () => {
  it('包在代码块里、前后多说几句也读得出', () => {
    const out = parseSeoDraft(
      'page_seo_edit',
      `好的：\n\`\`\`json\n${JSON.stringify(META)}\n\`\`\``,
    )
    expect(out).toEqual({ ok: true, kind: 'page_seo_edit', draft: META })
  })

  it('不合规矩整份不要：读不出 / 空格 / 超长 / 开头三句 / 违规宣称', () => {
    expect(parseSeoDraft('page_seo_edit', 'no json here').ok).toBe(false)
    expect(parseSeoDraft('page_seo_edit', JSON.stringify({ ...META, h1: '' })).ok).toBe(false)
    const long = 'x'.repeat(SEO_DRAFT_LIMITS.title + 1)
    expect(parseSeoDraft('page_seo_edit', JSON.stringify({ ...META, title: long }))).toEqual({
      ok: false,
      reason: '标题太长',
    })
    expect(
      parseSeoDraft('page_seo_edit', JSON.stringify({ ...META, opening: 'One. Two. Three.' })),
    ).toEqual({ ok: false, reason: '开头超过两句' })
    const bad = parseSeoDraft(
      'page_seo_edit',
      JSON.stringify({ ...META, meta_description: 'Guaranteed to last.' }),
    )
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.reason).toMatch(/违规宣称/)
  })

  it('加小节：要小标题与正文；知识库给了规则表就按它判', () => {
    expect(parseSeoDraft('page_section_add', JSON.stringify({ heading: 'H', body: '' })).ok).toBe(
      false,
    )
    const ok = parseSeoDraft(
      'page_section_add',
      JSON.stringify({ heading: 'Care', body: 'Military grade braid.' }),
    )
    expect(ok.ok).toBe(true)
    const custom = parseSeoDraft(
      'page_section_add',
      JSON.stringify({ heading: 'Care', body: 'Military grade braid.' }),
      [{ id: 'r', pattern: 'military grade', category: 'other', reason: '没法证明' }],
    )
    expect(custom).toEqual({
      ok: false,
      reason: '初稿里有违规宣称：没法证明（命中「military grade」）',
    })
  })
})
