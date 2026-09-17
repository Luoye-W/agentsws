import type { DesignBrief } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  checkPrompt,
  composePrompt,
  pickCardNoteZh,
  planGeneration,
  resolveBrandSystem,
  resolveSpec,
} from '../src/index.js'

const brand = resolveBrandSystem(
  [
    {
      name: 'brand-system',
      scope: 'org',
      body: '# 色\n- #0F172A\n# 版式\n留白多。\n# 禁忌\n- 竞品 logo\n- 真人脸',
    },
  ],
  'social',
)

const brief = (n: number): DesignBrief => ({
  id: 'brief_1',
  workspace_id: 'ws_1',
  request_id: 'req_1',
  duty: 'social',
  goal: '看懂它能塞进背包',
  audience: '通勤上班族',
  key_message: '装得下一天',
  copy: ['装得下一天'],
  spec_ids: ['social.ig.square'],
  must_avoid: ['竞品 logo'],
  brand_system: 'brand-system',
  variant_plan: Array.from({ length: n }, (_, i) => ({
    id: `social.ig.square#${i + 1}`,
    spec_id: 'social.ig.square',
    angle_zh: `角度 ${i + 1}`,
    prompt: `角度 ${i + 1}`,
  })),
  created_at: '2026-09-17T10:00:00Z',
})

describe('58 §2 变体计划与提示词组装', () => {
  it('额度内：要几张出几张，没有额度话', () => {
    const plan = planGeneration({ brief: brief(4), brand })
    expect(plan.n).toBe(4)
    expect(plan.over_quota).toBe(false)
    expect(plan.quota_notes).toEqual([])
  })

  it('一份 brief 超 6 张：截断并说人话，不报错', () => {
    const plan = planGeneration({ brief: brief(10), brand })
    expect(plan.n).toBe(6)
    expect(plan.over_quota).toBe(true)
    expect(plan.quota_notes.join(' ')).toContain('最多出 6 张')
  })

  it('今天的额度快用完：按剩下的出', () => {
    const plan = planGeneration({ brief: brief(6), brand, generated_today: 28 })
    expect(plan.n).toBe(2)
    expect(plan.quota_notes.join(' ')).toContain('还剩 2 张')
  })

  it('今天的额度用完了：一张都不出，并说明天再来', () => {
    const plan = planGeneration({ brief: brief(6), brand, generated_today: 30 })
    expect(plan.n).toBe(0)
    expect(plan.quota_notes.join(' ')).toContain('用完了')
  })

  it('只重出人点的那几条（"这个角度再来两张"）', () => {
    const plan = planGeneration({
      brief: brief(6),
      brand,
      only_plan_item_ids: ['social.ig.square#2', 'social.ig.square#5'],
    })
    expect(plan.prompts.map((p) => p.plan_item_id)).toEqual([
      'social.ig.square#2',
      'social.ig.square#5',
    ])
  })

  it('提示词：角度在前、规格硬规矩在中、品牌系统在后、禁忌收尾', () => {
    const one = composePrompt(brief(1).variant_plan[0] as never, brand)
    expect(one.size).toBe('1080x1080')
    const lines = one.prompt.split('\n')
    expect(lines[0]).toBe('角度 1')
    expect(one.prompt.indexOf('【规格】')).toBeLessThan(one.prompt.indexOf('【品牌系统'))
    expect(one.prompt.trimEnd().endsWith('【绝对不许出现】竞品 logo、真人脸')).toBe(true)
  })

  /*
   * WP76 ⑤ 的回归：**报上去的那一份不带禁忌行**。
   *
   * 全量提示词收尾那一行写的就是禁忌词的原文，而 guardrail 的
   * `brand_forbidden_term` 是拿同一张表去搜提示词的。报全量上去，
   * 每一次出图都会自己撞自己的门——一张图都出不来，报出来的原因还是
   * "提示词里有品牌禁忌词"。
   */
  it('positive_prompt：正向那一半，禁忌两行都不在里头', () => {
    const one = composePrompt(brief(1).variant_plan[0] as never, brand)
    expect(one.positive_prompt.startsWith('角度 1')).toBe(true)
    expect(one.positive_prompt).toContain('【品牌系统')
    expect(one.positive_prompt).toContain('留白多。')
    // 禁忌那两行（品牌系统里的「不许出现」与收尾的「绝对不许出现」）都不在
    expect(one.positive_prompt).not.toContain('不许出现')
    for (const term of ['竞品 logo', '真人脸']) {
      expect(one.prompt).toContain(term)
      expect(one.positive_prompt).not.toContain(term)
    }
  })

  it('印刷规格按 dpi 换算成像素画布', () => {
    const card = resolveSpec('print.namecard')
    expect(card?.unit).toBe('mm')
    const one = composePrompt(
      { id: 'x', spec_id: 'print.namecard', angle_zh: '正面', prompt: '' },
      brand,
    )
    // 90mm × 300dpi ÷ 25.4 ≈ 1063
    expect(one.size).toBe('1063x638')
  })

  it('认不出的规格：画布退回 1024 见方，不抛', () => {
    const one = composePrompt({ id: 'x', spec_id: 'nope', angle_zh: '随便', prompt: '' }, brand)
    expect(one.size).toBe('1024x1024')
  })

  it('自查：禁忌词命中就要求重写（但这一跳不是门）', () => {
    const bad = checkPrompt('把竞品 logo 放右下角', ['竞品 logo', '真人脸'])
    expect(bad.ok).toBe(false)
    expect(bad.hits).toEqual(['竞品 logo'])
    expect(bad.rewrite_instruction).toContain('当场拦下')
    expect(checkPrompt('纯白底居中', ['竞品 logo']).ok).toBe(true)
  })

  it('挑图卡那一行把「都不行再来」写出来', () => {
    const note = pickCardNoteZh(
      planGeneration({ brief: brief(3), brand }),
      resolveSpec('social.ig.square'),
    )
    expect(note).toContain('就这张')
    expect(note).toContain('都不行再来')
  })
})
