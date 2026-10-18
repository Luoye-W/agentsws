/**
 * WP335（决策 659）：设置页「这个品牌」多一格「品类」——档案里有就带出来，改了随保存发上去；向导第 ① 步不出。
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { type ProfileDraft, ProfileForm } from '@/components/onboarding/profile-form'
import { renderWithProviders } from './helpers'

const base = {
  legal_name: 'IVRA Tech',
  brand_name: 'IVRA',
  discoverable: true,
  vertical: 'goods' as const,
  storefront_platform: 'shopify' as const,
  set_at: '2026-10-15T09:00:00.000Z',
}

describe('WP335 品牌档案「品类」', () => {
  it('档案里有就带出来；改了随保存发上去', async () => {
    const saved: ProfileDraft[] = []
    renderWithProviders(
      <ProfileForm
        profile={{ ...base, category: 'AR 眼镜' }}
        busy={false}
        saved={false}
        onSave={(draft) => {
          saved.push(draft)
        }}
      />,
    )
    const cell = screen.getByTestId('brand-category') as HTMLInputElement
    expect(cell.value).toBe('AR 眼镜')
    await userEvent.clear(cell)
    await userEvent.type(cell, '智能眼镜')
    await userEvent.click(screen.getByTestId('company-save'))
    expect(saved[0]?.category).toBe('智能眼镜')
  })

  it('向导第 ① 步（第一个品牌）不出这一格', () => {
    renderWithProviders(<ProfileForm firstBrand busy={false} saved={false} onSave={() => {}} />)
    expect(screen.queryByTestId('brand-category')).toBeNull()
  })
})
