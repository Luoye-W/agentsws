/**
 * WP248（决策 83）：设置页公司档案「这个品牌」一节的三格——一句话介绍、客服邮箱、币种（默认 USD）。
 *
 * 钉住：老档案没有这三格也照常画（币种显示 USD）；改了随保存发上去（币种转大写）；向导第 ① 步不出这三格。
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { type ProfileDraft, ProfileForm } from '@/components/onboarding/profile-form'
import { renderWithProviders } from './helpers'

const AT = '2026-10-07T09:00:00.000Z'

const base = {
  legal_name: 'INMO Tech',
  brand_name: 'INMO',
  discoverable: true,
  vertical: 'goods' as const,
  storefront_platform: 'shopify' as const,
  set_at: AT,
}

describe('WP248 品牌档案三格', () => {
  it('老档案（没有三格、没有币种）：空着画，币种显示 USD；填了随保存发上去', async () => {
    const saved: ProfileDraft[] = []
    renderWithProviders(
      <ProfileForm
        profile={base}
        busy={false}
        saved={false}
        onSave={(draft) => {
          saved.push(draft)
        }}
      />,
    )
    const one = screen.getByTestId('brand-one-liner') as HTMLInputElement
    const email = screen.getByTestId('brand-support-email') as HTMLInputElement
    const currency = screen.getByTestId('brand-currency') as HTMLInputElement
    expect(one.value).toBe('')
    expect(email.value).toBe('')
    expect(currency.value).toBe('USD')

    await userEvent.type(one, '给近视的人做的 AR 眼镜')
    await userEvent.type(email, 'support@inmo.example')
    await userEvent.clear(currency)
    await userEvent.type(currency, 'eur')
    await userEvent.click(screen.getByTestId('company-save'))
    expect(saved[0]).toMatchObject({
      one_liner: '给近视的人做的 AR 眼镜',
      support_email: 'support@inmo.example',
      currency: 'EUR',
    })
  })

  it('档案里写过的照原样带出来', () => {
    renderWithProviders(
      <ProfileForm
        profile={{
          ...base,
          one_liner: '户外滑板与配件',
          support_email: 'help@rollout.example',
          currency: 'CAD',
        }}
        busy={false}
        saved={false}
        onSave={() => {}}
      />,
    )
    expect((screen.getByTestId('brand-one-liner') as HTMLInputElement).value).toBe('户外滑板与配件')
    expect((screen.getByTestId('brand-support-email') as HTMLInputElement).value).toBe(
      'help@rollout.example',
    )
    expect((screen.getByTestId('brand-currency') as HTMLInputElement).value).toBe('CAD')
  })

  it('向导第 ① 步（第一个品牌）不出这三格——那里走第 ② 步的档案卡 / 手填表', () => {
    renderWithProviders(
      <ProfileForm profile={base} firstBrand busy={false} saved={false} onSave={() => {}} />,
    )
    expect(screen.queryByTestId('profile-brand-facts')).toBeNull()
  })
})
