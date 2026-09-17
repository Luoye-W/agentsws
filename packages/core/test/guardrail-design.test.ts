import type { Mandate } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  DESIGN_PROMPT_FORBIDDEN_CAP,
  evaluateGuardrail,
  HARD_L1,
  KIND_RISK,
  Provenance,
} from '../src/index.js'

const now = '2026-09-17T09:00:00Z'
const brief = { type: 'design_brief', id: 'brief_1' } as const
const request = { type: 'design_request', id: 'req_1' } as const
const asset = { type: 'design_asset', id: 'asset_1' } as const

const prov = (target: { type: string; id: string }) => {
  const p = new Provenance('run_1')
  p.see([target as never], { full: true })
  return p
}
const facts = (
  target: { type: string; id: string },
  over: Partial<Parameters<typeof evaluateGuardrail>[2]> = {},
) => ({ now, changeSet: [], windowCount: 0, provenance: prov(target), ...over })

const mandate = (caps: Mandate['caps']): Mandate => ({ caps })

describe('58 §1 设计四条 ChangeKind 的 guardrail（WP76）', () => {
  it('入库在硬顶里：采纳率再高也升不了级', () => {
    expect(HARD_L1.has('asset_publish')).toBe(true)
    // 另外三条**不在**硬顶里——brief L3 自动、变体 L2 出卡、需求单 L3
    expect(HARD_L1.has('design_brief')).toBe(false)
    expect(HARD_L1.has('design_variant')).toBe(false)
    expect(HARD_L1.has('design_request')).toBe(false)
  })

  it('风险级：三条 low、入库 medium', () => {
    expect(KIND_RISK.design_request).toBe('low')
    expect(KIND_RISK.design_brief).toBe('low')
    expect(KIND_RISK.design_variant).toBe('low')
    expect(KIND_RISK.asset_publish).toBe('medium')
  })

  it('brief：一天 10 份，第 11 份转人审', () => {
    const change = {
      kind: 'design_brief' as const,
      target: brief,
      before: {},
      after: { request_id: 'req_1' },
    }
    const ok = evaluateGuardrail(change, mandate({ max_brief_per_day: 10 }), facts(brief), 'stage')
    expect(ok.verdict).toBe('allow')
    const over = evaluateGuardrail(
      change,
      mandate({ max_brief_per_day: 10 }),
      facts(brief, { windowCount: 10 }),
      'stage',
    )
    expect(over.verdict).toBe('require_review')
    expect(over.hits.map((h) => h.rule)).toContain('max_brief_per_day')
  })

  it('变体：n 超过 max_variants_per_brief 转人审（58 §6 默认 6）', () => {
    const change = (n: number) => ({
      kind: 'design_variant' as const,
      target: brief,
      before: {},
      after: { n, prompt: '白底摆台，产品居中' },
    })
    const caps = mandate({ max_variants_per_brief: 6, max_generations_per_day: 30 })
    expect(evaluateGuardrail(change(6), caps, facts(brief), 'stage').verdict).toBe('allow')
    const over = evaluateGuardrail(change(9), caps, facts(brief), 'stage')
    expect(over.verdict).toBe('require_review')
    expect(over.hits.find((h) => h.rule === 'max_variants_per_brief')?.actual).toBe(9)
  })

  it('变体：一天出图上限按张数累加，不是按次数', () => {
    const caps = mandate({ max_variants_per_brief: 6, max_generations_per_day: 30 })
    const over = evaluateGuardrail(
      { kind: 'design_variant', target: brief, before: {}, after: { n: 4, prompt: '实拍' } },
      caps,
      facts(brief, { windowCount: 28 }),
      'stage',
    )
    expect(over.hits.find((h) => h.rule === 'max_generations_per_day')?.actual).toBe(32)
  })

  it('变体：提示词里带品牌禁忌词 → **block**，不是转人审', () => {
    const caps = mandate({
      max_variants_per_brief: 6,
      [DESIGN_PROMPT_FORBIDDEN_CAP]: ['竞品 logo', 'Competitor'],
    })
    const hit = evaluateGuardrail(
      {
        kind: 'design_variant',
        target: brief,
        before: {},
        after: { n: 3, prompt: '把 competitor 的 logo 放在右下角' },
      },
      caps,
      facts(brief),
      'stage',
    )
    expect(hit.verdict).toBe('block')
    expect(hit.hits.find((h) => h.rule === 'brand_forbidden_term')?.severity).toBe('block')
  })

  it('变体：禁忌词也可以从 brief 的 must_avoid 带过来（品牌系统那一半）', () => {
    const hit = evaluateGuardrail(
      {
        kind: 'design_variant',
        target: brief,
        before: {},
        after: {
          n: 2,
          prompts: ['产品泡在水里的特写'],
          must_avoid: ['泡在水里', '真人脸'],
        },
      },
      mandate({}),
      facts(brief),
      'stage',
    )
    expect(hit.verdict).toBe('block')
  })

  it('变体：禁忌词没命中就放行', () => {
    const ok = evaluateGuardrail(
      {
        kind: 'design_variant',
        target: brief,
        before: {},
        after: { n: 3, prompt: '纯白底，产品居中', must_avoid: ['竞品', '真人脸'] },
      },
      mandate({ max_variants_per_brief: 6 }),
      facts(brief),
      'stage',
    )
    expect(ok.verdict).toBe('allow')
  })

  it('入库：没有 picked_by → block（Agent 自己定稿这条路根本不存在）', () => {
    const noPick = evaluateGuardrail(
      { kind: 'asset_publish', target: asset, before: {}, after: { asset_id: 'asset_1' } },
      mandate({}),
      facts(asset),
      'stage',
    )
    expect(noPick.verdict).toBe('block')
    expect(noPick.hits.map((h) => h.rule)).toContain('human_pick_required')
  })

  it('入库：人点过了也照样是 require_review（硬顶 L1）', () => {
    const picked = evaluateGuardrail(
      {
        kind: 'asset_publish',
        target: asset,
        before: {},
        after: { asset_id: 'asset_1', picked_by: 'p_1' },
      },
      mandate({}),
      facts(asset),
      'stage',
    )
    expect(picked.verdict).toBe('require_review')
    expect(picked.hits.find((h) => h.rule === 'hard_ceiling')?.cap).toBe('L1')
  })

  it('下需求单：额度内放行，超了转人审', () => {
    const change = {
      kind: 'design_request' as const,
      target: request,
      before: {},
      after: { duty: 'social', need: '下周上新要三张图' },
    }
    const caps = mandate({ max_design_requests_per_day: 5 })
    expect(evaluateGuardrail(change, caps, facts(request), 'stage').verdict).toBe('allow')
    expect(
      evaluateGuardrail(change, caps, facts(request, { windowCount: 5 }), 'stage').verdict,
    ).toBe('require_review')
  })
})
