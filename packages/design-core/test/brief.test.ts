import type { DesignRequest } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { BrandSystemCard } from '../src/index.js'
import { ANGLES, briefSummaryZh, draftBrief, planVariants, readNeed } from '../src/index.js'

const request = (over: Partial<DesignRequest> = {}): DesignRequest => ({
  id: 'req_1',
  workspace_id: 'ws_1',
  duty: 'social',
  from_role_id: 'social.meta',
  title: '上新那条帖子的配图',
  need: '下周上新，想要一张 IG 的方图。目标：让人一眼看懂它能塞进背包。受众：通勤的上班族。图上写“装得下一天”。',
  spec_ids: ['social.ig.square'],
  status: 'queued',
  created_at: '2026-09-17T09:00:00Z',
  ...over,
})

const brandCard: BrandSystemCard = {
  name: 'brand-system',
  scope: 'org',
  body: [
    '## 色',
    '- #0F172A',
    '- #F97316',
    '## 字',
    '- Inter',
    '## 版式',
    '留白多，产品居中，不堆元素。',
    '## 禁忌',
    '- 竞品 logo —— 法务说过',
    '- 真人脸',
  ].join('\n'),
  updated_at: '2026-08-01',
}

const draft = (over: Partial<DesignRequest> = {}, cards = [brandCard]) =>
  draftBrief({
    request: request(over),
    brand_cards: cards,
    id: 'brief_1',
    at: '2026-09-17T10:00:00Z',
  })

describe('58 §2 需求单 → brief（纯函数）', () => {
  it('切得出目标 / 受众 / 图上文案', () => {
    const { brief } = draft()
    expect(brief.goal).toBe('让人一眼看懂它能塞进背包')
    expect(brief.audience).toBe('通勤的上班族')
    expect(brief.copy).toEqual(['装得下一天'])
  })

  it('禁忌 = 品牌系统的 forbidden + 规格上的硬规矩', () => {
    const { brief } = draft({ duty: 'amazon', spec_ids: ['amazon.main'] })
    // 品牌那一半（行内说明已经剥掉）
    expect(brief.must_avoid).toContain('竞品 logo')
    expect(brief.must_avoid).toContain('真人脸')
    // 规格那一半：Amazon 主图一个字都不许有
    expect(brief.must_avoid).toContain('文字')
    expect(brief.must_avoid).toContain('水印')
  })

  it('需求单没写尺寸就给默认那一条，并且**记一句问**（不静默填）', () => {
    const { brief, questions } = draft({ spec_ids: [] })
    expect(brief.spec_ids).toHaveLength(1)
    expect(questions.join(' ')).toContain('没写尺寸')
  })

  it('写了不认识的规格：原样报出来，不当它不存在', () => {
    const { questions } = draft({ spec_ids: ['social.ig.does-not-exist'] })
    expect(questions.join(' ')).toContain('social.ig.does-not-exist')
  })

  it('需求写得糊涂：brief 照样出，缺的那几样变成问句（不编默认值）', () => {
    const { brief, questions } = draft({ need: '来张图' })
    expect(brief.goal).toBe('')
    expect(brief.audience).toBe('')
    expect(questions.length).toBeGreaterThanOrEqual(2)
  })

  it('没有品牌系统：brief 照样出，并记一句问', () => {
    const { brief, questions, brand } = draft({}, [])
    expect(brand.system).toBeUndefined()
    expect(brief.brand_system).toBeUndefined()
    expect(questions.join(' ')).toContain('品牌系统')
  })

  it('变体张数封在 58 §6 的 6 上', () => {
    const out = draftBrief({
      request: request(),
      brand_cards: [brandCard],
      variants: 99,
      id: 'brief_1',
      at: '2026-09-17T10:00:00Z',
    })
    expect(out.brief.variant_plan).toHaveLength(6)
  })

  it('brief 里**没有**「选中的那一张」——挑图是人的事', () => {
    const { brief } = draft()
    expect(Object.keys(brief)).not.toContain('picked')
    expect(Object.keys(brief)).not.toContain('chosen')
  })

  it('brief 卡正文把缺的那几样说出来', () => {
    const summary = briefSummaryZh(draft({ need: '来张图' }))
    expect(summary).toContain('（需求单没说）')
    expect(summary).toContain('还得你说一句')
  })
})

describe('变体计划', () => {
  it('两个规格 6 张：每个规格 3 张，不是第一个吃满', () => {
    const plan = planVariants(
      [
        {
          id: 'a',
          family: 'web',
          zh: 'A',
          en: 'A',
          unit: 'px',
          width: 100,
          height: 100,
          color_mode: 'sRGB',
        },
        {
          id: 'b',
          family: 'web',
          zh: 'B',
          en: 'B',
          unit: 'px',
          width: 100,
          height: 100,
          color_mode: 'sRGB',
        },
      ],
      6,
    )
    expect(plan.filter((p) => p.spec_id === 'a')).toHaveLength(3)
    expect(plan.filter((p) => p.spec_id === 'b')).toHaveLength(3)
  })

  it('角度轮着来，不是同一个角度出六遍', () => {
    const { brief } = draft()
    const angles = new Set(brief.variant_plan.map((v) => v.angle_zh))
    expect(angles.size).toBe(Math.min(ANGLES.length, brief.variant_plan.length))
  })

  it('没规格就没计划（不编一个画布出来）', () => {
    expect(planVariants([], 6)).toEqual([])
  })
})

describe('需求原文的切法：切不出来就留空，不猜', () => {
  it('没写目标就没有目标', () => {
    expect(readNeed('随便来一张').goal).toBeUndefined()
  })

  it('引号里的都是图上文案', () => {
    expect(readNeed('图上写“省一半电”和「四档调速」').copy).toEqual(['省一半电', '四档调速'])
  })
})
