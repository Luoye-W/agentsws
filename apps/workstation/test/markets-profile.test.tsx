/**
 * WP166：设置页「公司档案」里的目标市场——与向导档案卡是同一个选择器、同一份档案。
 *
 * 钉住：画成中文国名的小标签、出处在问号里、店铺后台校正过的那一句一眼可见、增删后随保存发上去。
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { type ProfileDraft, ProfileForm } from '@/components/onboarding/profile-form'
import { renderWithProviders } from './helpers'

const AT = '2026-09-27T09:00:00.000Z'

describe('WP166 设置页「公司档案」的目标市场', () => {
  it('画出来、出处在问号里、店里校正过的那一句可见；增删后随保存发上去', async () => {
    const saved: ProfileDraft[] = []
    renderWithProviders(
      <ProfileForm
        profile={{
          legal_name: 'Nordvik Supply AB',
          brand_name: 'Nordvik',
          discoverable: true,
          vertical: 'goods',
          storefront_platform: 'shopify',
          markets: ['US', 'AU'],
          markets_source: {
            from: 'store',
            note: '按店铺后台的「市场」校正：加上了 澳大利亚',
            at: AT,
          },
          set_at: AT,
        }}
        busy={false}
        saved={false}
        onSave={(draft) => {
          saved.push(draft)
        }}
      />,
    )
    const block = screen.getByTestId('profile-markets')
    expect(screen.getAllByTestId('market-chip').map((c) => c.textContent)).toEqual([
      '美国',
      '澳大利亚',
    ])
    expect(block.textContent).toContain('目标市场')
    expect(screen.getByTestId('markets-origin').getAttribute('data-hint')).toContain('澳大利亚')
    expect(screen.getByTestId('profile-markets-note').textContent).toBe(
      '按店铺后台的「市场」校正：加上了 澳大利亚',
    )

    await userEvent.click(screen.getByTestId('market-remove-AU'))
    await userEvent.selectOptions(screen.getByTestId('market-add'), 'GB')
    await userEvent.click(screen.getByTestId('company-save'))
    expect(saved[0]?.markets).toEqual(['US', 'GB'])
  })

  it('WP169：选了两个及以上市场时一句花费提示，细节进问号；只剩一个就不出', async () => {
    renderWithProviders(
      <ProfileForm
        profile={{
          legal_name: 'Nordvik Supply AB',
          brand_name: 'Nordvik',
          discoverable: true,
          vertical: 'goods',
          storefront_platform: 'shopify',
          markets: ['US', 'GB'],
          markets_source: { from: 'human', at: AT },
          set_at: AT,
        }}
        busy={false}
        saved={false}
        onSave={() => {}}
      />,
    )
    expect(screen.getByTestId('markets-cost').textContent).toBe(
      '多一个市场，搜索可见度的探测花费多一份',
    )
    const hint = screen.getByTestId('markets-cost-hint').getAttribute('data-hint') ?? ''
    expect(hint).toContain('6 个 × 3 个 AI 平台 × 2 个市场 × 每次 0.2 积分，约 7.2 积分')
    expect(hint).toContain('每个市场各 5 次')
    await userEvent.click(screen.getByTestId('market-remove-GB'))
    expect(screen.queryByTestId('markets-cost')).toBeNull()
    await userEvent.selectOptions(screen.getByTestId('market-add'), 'DE')
    await userEvent.selectOptions(screen.getByTestId('market-add'), 'FR')
    expect(screen.getByTestId('markets-cost-hint').getAttribute('data-hint')).toContain(
      '约 10.8 积分',
    )
  })

  it('还没有市场：明说请选一下', () => {
    renderWithProviders(<ProfileForm busy={false} saved={false} onSave={() => {}} />)
    expect(screen.getByTestId('markets-empty').textContent).toBe('没看出来，请选一下')
  })
  it('WP176：公司实体地址在档案里（设置页才出）；改了随保存发上去', async () => {
    const saved: ProfileDraft[] = []
    renderWithProviders(
      <ProfileForm
        profile={{
          legal_name: 'Nordvik Supply AB',
          brand_name: 'Nordvik',
          discoverable: true,
          vertical: 'goods',
          storefront_platform: 'shopify',
          postal_address: '8 Keji Rd',
          set_at: AT,
        }}
        busy={false}
        saved={false}
        onSave={(draft) => {
          saved.push(draft)
        }}
      />,
    )
    const input = screen.getByTestId('company-postal-address') as HTMLInputElement
    expect(input.value).toBe('8 Keji Rd')
    await userEvent.clear(input)
    await userEvent.type(input, '9 New Rd, Shenzhen')
    await userEvent.click(screen.getByTestId('company-save'))
    expect(saved[0]?.postal_address).toBe('9 New Rd, Shenzhen')
  })

  it('WP176：向导里（第一个品牌）不问地址', () => {
    renderWithProviders(
      <ProfileForm firstBrand busy={false} saved={false} onSave={() => undefined} />,
    )
    expect(screen.queryByTestId('profile-address')).toBeNull()
  })
})
