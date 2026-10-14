/**
 * WP313：连接页「浏览器插件」里的「广告动作」。
 * 守三件：十个「默认不碰」开关全部默认关、逐项放开；等确认的活能在这里确认提交、在跑的能停；
 * 本机没装插件动作通道就整块不出。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ADS_ZONES, AdsActionsPanel } from '@/components/connections/ads-actions'
import type { AdsActionJobView, AdsActionSettingsView, AdsGuardedZone } from '@/lib/api'
import { renderWithProviders } from './helpers'

const zonesOff = (): Record<AdsGuardedZone, boolean> =>
  Object.fromEntries(ADS_ZONES.map((z) => [z, false])) as Record<AdsGuardedZone, boolean>

const state = {
  installed: true,
  settings: { zones: zonesOff(), consent: {} } as AdsActionSettingsView,
  jobs: [] as AdsActionJobView[],
  calls: [] as string[],
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getAdsActionSettings: async () => {
      if (!state.installed) throw new Error('not_implemented')
      return state.settings
    },
    setAdsActionZone: async (zone: AdsGuardedZone, enabled: boolean) => {
      state.calls.push(`zone:${zone}:${enabled}`)
      state.settings = { ...state.settings, zones: { ...state.settings.zones, [zone]: enabled } }
      return state.settings
    },
    revokeAdsActionConsent: async (p: string) => {
      state.calls.push(`revoke:${p}`)
      state.settings = { ...state.settings, consent: {} }
      return state.settings
    },
    listAdsActionJobs: async () => ({ jobs: state.jobs }),
    stopAdsActionJob: async (id: string) => {
      state.calls.push(`stop:${id}`)
      return state.jobs[0]
    },
    confirmAdsActionJob: async (id: string) => {
      state.calls.push(`confirm:${id}`)
      return state.jobs[0]
    },
  }
})

const job = (over: Partial<AdsActionJobView>): AdsActionJobView => ({
  id: 'job_1',
  title: '上传表「春季.csv」',
  platform: 'google_ads',
  account_id: '123-456-7890',
  kind: 'upload_sheet',
  status: 'queued',
  created_at: '2026-10-14T09:00:00.000Z',
  ...over,
})

beforeEach(() => {
  state.installed = true
  state.settings = { zones: zonesOff(), consent: {} }
  state.jobs = []
  state.calls = []
})

describe('默认不碰', () => {
  it('十个开关全部默认关；打开「账单」只放开账单', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AdsActionsPanel assignment="asg_owner" />)
    const zones = await screen.findByTestId('ads-actions-zones')
    const switches = within(zones).getAllByRole('switch')
    expect(switches).toHaveLength(10)
    expect(switches.every((s) => s.getAttribute('aria-checked') === 'false')).toBe(true)
    await user.click(screen.getByTestId('ads-zone-billing'))
    await waitFor(() => expect(state.calls).toEqual(['zone:billing:true']))
  })

  it('没连的时候说一句去插件里连；连了能断开', async () => {
    const user = userEvent.setup()
    state.settings = {
      zones: zonesOff(),
      consent: {
        meta_ads: {
          platform: 'meta_ads',
          accepted_at: '2026-10-14T09:00:00.000Z',
          text_version: 'v',
        },
      },
    }
    renderWithProviders(<AdsActionsPanel assignment="asg_owner" />)
    const consent = await screen.findByTestId('ads-actions-consent')
    expect(consent.textContent).toContain('Meta 广告 已连接')
    await user.click(within(consent).getByRole('button'))
    await waitFor(() => expect(state.calls).toEqual(['revoke:meta_ads']))
  })
})

describe('排着 / 在做的活', () => {
  it('等确认的能确认提交，也能停；做完的只看结果', async () => {
    const user = userEvent.setup()
    state.jobs = [
      job({ status: 'waiting_confirm', progress: { step: 10, of: 13, label: '等你确认' } }),
      job({ id: 'job_0', title: '暂停「春季」', status: 'done' }),
    ]
    renderWithProviders(<AdsActionsPanel assignment="asg_owner" />)
    const list = await screen.findByTestId('ads-actions-jobs')
    const [first, second] = within(list).getAllByRole('listitem')
    expect(first?.textContent).toContain('等你确认')
    expect(second?.querySelectorAll('button')).toHaveLength(0)
    await user.click(within(first as HTMLElement).getByText('确认提交'))
    await user.click(within(first as HTMLElement).getByText('停止'))
    await waitFor(() => expect(state.calls).toEqual(['confirm:job_1', 'stop:job_1']))
  })

  it('本机没装插件动作通道 → 整块不出', async () => {
    state.installed = false
    const { container } = renderWithProviders(<AdsActionsPanel assignment="asg_owner" />)
    await new Promise((r) => setTimeout(r, 50))
    expect(container.querySelector('[data-testid="ads-actions"]')).toBeNull()
  })
})
