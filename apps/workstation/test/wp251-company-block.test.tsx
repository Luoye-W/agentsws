/**
 * WP251：设置页公司档案——公司地址是**公司**的，挪进「公司」那一块；「公司」标题旁一句
 * 「改的是公司，这家公司的所有品牌都跟着变」（tooltip，不铺字）。
 */
import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProfileForm } from '@/components/onboarding/profile-form'
import { renderWithProviders } from './helpers'

const profile = {
  legal_name: '深圳卢耶科技有限公司',
  brand_name: 'Rollout',
  discoverable: true,
  vertical: 'goods' as const,
  storefront_platform: 'shopify' as const,
  postal_address: '深圳市南山区科技路 8 号',
  set_at: '2026-10-07T09:00:00.000Z',
}

describe('WP251 公司那一块', () => {
  it('地址在「公司」里、不在「这个品牌」里；标题旁有提示', () => {
    renderWithProviders(
      <ProfileForm profile={profile} busy={false} saved={false} onSave={() => undefined} />,
    )
    const company = screen.getByTestId('profile-company-block')
    const brand = screen.getByTestId('profile-brand-block')
    const address = within(company).getByTestId('company-postal-address') as HTMLInputElement
    expect(address.value).toBe('深圳市南山区科技路 8 号')
    expect(within(brand).queryByTestId('company-postal-address')).toBeNull()
    expect(within(company).getByTestId('profile-company-hint')).toBeTruthy()
    // 公司全称也在公司那一块，品牌名在品牌那一块
    expect(within(company).getByTestId('company-legal-name')).toBeTruthy()
    expect(within(brand).getByTestId('brand-name')).toBeTruthy()
  })

  it('向导（第一个品牌）照旧不出地址与那两个小标题', () => {
    renderWithProviders(
      <ProfileForm
        profile={profile}
        firstBrand
        busy={false}
        saved={false}
        onSave={() => undefined}
      />,
    )
    expect(screen.queryByTestId('company-postal-address')).toBeNull()
    expect(screen.queryByTestId('profile-company-title')).toBeNull()
  })
})
