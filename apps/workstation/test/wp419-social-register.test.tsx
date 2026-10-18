/**
 * WP419（决策 1231，自查 S2 / S4）：内容账号组没登记号 → 职责页就地贴主页链接登记（不用开发者应用、不用令牌）；
 * 排期框能带素材库的图，IG 没带图时说一句。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { accountUrlOk } from '@/components/social/social-account-register'
import { renderWithProviders } from './helpers'

const posted: unknown[] = []
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getCalendar: async () => ({ items: [], from: '', to: '' }),
    getSocialAccounts: async () => ({ rows: [] }),
    listBrandAssets: async () => ({ rows: [] }),
    registerSocialAccount: async (input: unknown) => {
      posted.push(input)
      return { id: 'sa_new' }
    },
  }
})

const { SocialCalendar } = await import('@/components/social/social-calendar')
const { SocialMediaPick } = await import('@/components/social/social-media-pick')

describe('WP419 登记要发帖的号（不用开发者应用）', () => {
  it('链接只认这条渠道的站', () => {
    expect(accountUrlOk('instagram', 'https://www.instagram.com/nordvolt')).toBe(true)
    expect(accountUrlOk('instagram', 'https://www.facebook.com/nordvolt')).toBe(false)
    expect(accountUrlOk('x', 'https://x.com/nordvolt')).toBe(true)
    expect(accountUrlOk('x', 'http://x.com/nordvolt')).toBe(false)
    expect(accountUrlOk('discord', 'https://discord.gg/x')).toBe(false)
  })

  it('IG 没登记号：就地贴主页链接登记，不弹连接页', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SocialCalendar assignment="asg_ig" channel="instagram" />)
    const input = await screen.findByTestId('social-account-url')
    expect(screen.getByTestId('social-account-register').textContent).toContain('不用开发者应用')
    const save = screen.getByTestId('social-account-save')
    expect((save as HTMLButtonElement).disabled).toBe(true)
    await user.type(input, 'https://www.instagram.com/nordvolt')
    await user.click(save)
    await waitFor(() => expect(posted.length).toBeGreaterThan(0))
    expect(posted[0]).toMatchObject({
      channel: 'instagram',
      url: 'https://www.instagram.com/nordvolt',
    })
  })

  it('排期框：IG 没带图时说一句', () => {
    renderWithProviders(<SocialMediaPick channel="instagram" picked={[]} onChange={() => {}} />)
    expect(screen.getByTestId('social-media-need').textContent).toContain('图片或视频')
  })
})
