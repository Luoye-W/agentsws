/**
 * WP386：信息监控的多条监控源——汇总一句、拉不到的亮红点、贴一批 RSS、贴错当场说；
 * 连接卡里 Google 账号那一步只给一句 + 登录链接（界面少字）。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { GoogleAccountStep, PrWatchSources } from '@/components/pr/pr-watch-sources'
import { renderWithProviders } from './helpers'

const VIEW = {
  sources: [
    {
      id: 'ms_1',
      workspace_id: 'ws',
      kind: 'google_alerts',
      url_masked: 'www.google.com/…0001',
      group: 'own',
      label: 'Super73',
      every_hours: 24,
      status: 'ok',
      last_ok_at: '2026-10-18T01:00:00.000Z',
      last_fetched: 20,
      added_via: 'paste',
      created_at: '2026-10-17T00:00:00.000Z',
    },
    {
      id: 'ms_2',
      workspace_id: 'ws',
      kind: 'google_alerts',
      url_masked: 'www.google.com/…0002',
      group: 'competitor',
      label: 'Aventon',
      every_hours: 24,
      status: 'failed',
      last_error: 'Google Alerts 说这条 feed 不存在（404）。',
      added_via: 'paste',
      created_at: '2026-10-17T00:00:00.000Z',
    },
  ],
  plan: [],
  settings: { enabled: true, day_start_hour: 9, default_every_hours: 24, reddit_queries: [] },
  summary: '2 条 · 1 条拉不到',
  failed: 1,
  next_run_at: '2026-10-19T01:00:00.000Z',
}

const added = vi.fn(async (_asg: string, input: { links: string }) => ({
  results: [
    {
      input_masked: 'www.google.com/…0003',
      ok: true,
      message: '已订上「Ride1Up」：拉到 3 条，新入表 3 条。',
    },
    {
      input_masked: '…mail',
      ok: false,
      message: '这条还是邮箱投递，去 Google Alerts 把投递方式改成 RSS，再把 RSS 链接贴过来。',
    },
  ],
  view: VIEW,
  _input: input,
}))

vi.mock('@/lib/pr-watch-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pr-watch-api')>('@/lib/pr-watch-api')
  return {
    ...actual,
    getPrWatch: async () => VIEW,
    addPrWatchLinks: (asg: string, input: { links: string }) => added(asg, input),
  }
})

describe('WP386 信息监控的监控源', () => {
  it('汇总一句 + 每条一行；拉不到的那条标红', async () => {
    renderWithProviders(<PrWatchSources assignment="asg_pr" />)
    await waitFor(() => {
      expect(screen.getByTestId('prwatch-summary').textContent).toContain('2 条 · 1 条拉不到')
    })
    expect(screen.getByTestId('prwatch-red-dot')).toBeTruthy()
    const rows = screen.getAllByTestId('prwatch-source')
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['ok', 'failed'])
    expect(rows[1]?.textContent).toContain('拉不到')
    // 地址一格都不出
    expect(document.body.textContent).not.toContain('alerts/feeds')
  })

  it('一次贴一批：成的说订上了，错的当场说「还是邮箱投递」', async () => {
    renderWithProviders(<PrWatchSources assignment="asg_pr" />)
    const box = await screen.findByTestId('prwatch-paste')
    await userEvent.type(
      box,
      'https://www.google.com/alerts/feeds/1/3{enter}https://mail.example/x',
    )
    await userEvent.click(screen.getByTestId('prwatch-add'))
    await waitFor(() => {
      expect(screen.getByTestId('prwatch-results').textContent).toContain('已订上「Ride1Up」')
    })
    expect(screen.getByTestId('prwatch-results').textContent).toContain('邮箱投递')
    expect(added.mock.calls[0]?.[1].links).toContain('https://www.google.com/alerts/feeds/1/3')
  })

  it('没担信息监控：照实说一句，不发请求', () => {
    renderWithProviders(<PrWatchSources assignment={undefined} />)
    expect(screen.queryByTestId('prwatch-sources')).toBeNull()
  })

  it('Google 账号那一步：一句话 + 登录链接 + 看教程', () => {
    renderWithProviders(<GoogleAccountStep />)
    expect(screen.getByTestId('google-account-step').textContent).toContain('Google')
    expect(screen.getByRole('link', { name: /Google/u }).getAttribute('href')).toBe(
      'https://accounts.google.com/',
    )
  })
})
