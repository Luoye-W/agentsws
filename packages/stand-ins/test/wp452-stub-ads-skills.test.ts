/**
 * WP452：stub 运行时的投放第二批剧本——话里点到哪样走哪样；数只从话里原样抽、不编；没点到回 undefined（照旧止损那套）。
 */
import { describe, expect, it } from 'vitest'
import { runAdsSkillScript } from '../src/runtime/stub-ads-skills.js'

const ALL = [
  'run_ads_audit',
  'calc_break_even',
  'check_ad_landing',
  'design_ads_experiment',
  'read_ads_experiment',
]

function fake(data: Record<string, unknown>) {
  const calls: { tool: string; input: Record<string, unknown> }[] = []
  const exec = async (step: { tool: string; input: Record<string, unknown> }) => {
    calls.push(step)
    return { status: 'ok' as const, data: data[step.tool] }
  }
  return { calls, exec }
}

describe('WP452 stub 剧本', () => {
  it('没点到 → undefined', async () => {
    const { exec } = fake({})
    expect(await runAdsSkillScript(exec, '今天花了多少', ALL)).toBeUndefined()
  })
  it('保本线：只把话里有的数交给工具，缺的照工具回的说', async () => {
    const { exec, calls } = fake({
      calc_break_even: {
        computable: true,
        break_even_roas: 2.5,
        break_even_cpa: 40,
        formula: 'f',
        ask: ['运费'],
      },
    })
    const out = await runAdsSkillScript(exec, '帮我算保本 ROAS：客单价 100，毛利 40%', ALL)
    expect(calls[0]?.input).toEqual({ aov: 100, gross_margin_pct: 40 })
    expect(out?.answer).toContain('保本 ROAS 2.5')
    expect(out?.answer).toContain('运费')
  })
  it('体检：三态计数', async () => {
    const { exec } = fake({
      run_ads_audit: { verdicts: { pass: 2, fail: 1, unknown: 6 }, items: [] },
    })
    expect((await runAdsSkillScript(exec, '把这个账户体检一遍', ALL))?.answer).toContain(
      '过 2、不过 1、未知 6',
    )
  })
  it('实验结果：先设计再读，数从话里抽', async () => {
    const { exec, calls } = fake({
      design_ads_experiment: { experiment_id: 'adexp_1' },
      read_ads_experiment: { readout: { verdict: 'keep', reasons: ['r'] }, card_id: 'ap_1' },
    })
    const out = await runAdsSkillScript(
      exec,
      '实验结果出来了：基准 21200/424，新版 21200/530，想看出提升 20%，每天 6000',
      ALL,
    )
    expect(calls.map((c) => c.tool)).toEqual(['design_ads_experiment', 'read_ads_experiment'])
    expect(calls[0]?.input).toMatchObject({
      baseline_rate: 0.02,
      mde_rel_pct: 20,
      daily_units: 6000,
    })
    expect(out?.answer).toContain('建议「保留」')
  })
})
