/**
 * WP452：品牌档案「卖的是」一格（只有投放与 SEO 的建议读它）；广告实验「保留 / 停 / 再测」卡的卡身。
 */
import type { AdsExperimentReadoutPayload } from '@agentsws/contracts'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  ExperimentReadoutBody,
  isExperimentReadoutPayload,
} from '@/components/ads/experiment-readout-body'
import { type ProfileDraft, ProfileForm } from '@/components/onboarding/profile-form'
import { renderWithProviders } from './helpers'

const base = {
  legal_name: 'Desk Co',
  brand_name: 'Desk',
  discoverable: true,
  vertical: 'goods' as const,
  storefront_platform: 'shopify' as const,
  set_at: '2026-10-20T09:00:00.000Z',
}

describe('WP452 品牌档案「卖的是」', () => {
  it('没填是「没说」；选了 App 随保存发上去', async () => {
    const saved: ProfileDraft[] = []
    renderWithProviders(
      <ProfileForm
        profile={{ ...base, category: '台灯' }}
        busy={false}
        saved={false}
        onSave={(draft) => {
          saved.push(draft)
        }}
      />,
    )
    const cell = screen.getByTestId('brand-offering') as HTMLSelectElement
    expect(cell.value).toBe('')
    await userEvent.selectOptions(cell, 'app')
    await userEvent.click(screen.getByTestId('company-save'))
    expect(saved[0]?.offering).toBe('app')
  })
})

const payload: AdsExperimentReadoutPayload = {
  form: 'ads_experiment_readout',
  experiment_id: 'adexp_1',
  platform: 'meta',
  hypothesis: '标题带价格点击率更高',
  change: '只换标题',
  arms: [
    { id: 'base', units: 21200, successes: 424 },
    { id: 'v1', label: '带价格', units: 21200, successes: 530 },
  ],
  readout: {
    verdict: 'keep',
    reached: true,
    guardrail_breaches: [],
    reasons: ['「v1」点击率 2.5% 对基准 2%，提升 25%（p = 0.0002）。'],
    comparisons: [
      {
        arm: 'v1',
        control_rate: 0.02,
        rate: 0.025,
        lift_pct: 25,
        p_value: 0.0002,
        ci_low_pp: 0.2,
        ci_high_pp: 0.8,
        significant: true,
      },
    ],
  },
  recommended: 'keep',
}

describe('WP452 实验结果卡身', () => {
  it('认得出 payload；两行：基准与变体，变体写提升与「确定」', () => {
    expect(isExperimentReadoutPayload(payload)).toBe(true)
    expect(isExperimentReadoutPayload({ form: 'x' })).toBe(false)
    renderWithProviders(<ExperimentReadoutBody payload={payload} />)
    const arm = screen.getByTestId('ads-experiment-arm')
    expect(arm.textContent).toContain('带价格')
    expect(arm.textContent).toContain('+25%')
    expect(arm.textContent).toContain('确定')
    expect(screen.getByTestId('ads-experiment-readout').textContent).toContain('只换标题')
  })
})
