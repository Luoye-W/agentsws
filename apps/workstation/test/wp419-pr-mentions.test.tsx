/**
 * WP419（自查 P5 / P10）：信息监控拉回来的提及在右侧「报表」里看得到——按组 / 情绪 / 来源筛、点标题去原文；
 * 没拉到的源照实说一句。
 */
import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RailScope } from '@/components/rail/rail-scope'
import { renderWithProviders } from './helpers'

vi.mock('@/lib/pr-watch-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pr-watch-api')>('@/lib/pr-watch-api')
  return {
    ...actual,
    getPrWatch: async () => ({
      sources: [],
      plan: [],
      settings: {},
      summary: '4 条 · 1 条拉不到',
      failed: 1,
    }),
    getPrMentions: async () => ({
      rows: [
        {
          id: 'mn_1',
          url: 'https://news.example.com/a',
          title: 'Nordvolt battery recall rumor',
          text: '',
          origin: 'news.example.com',
          published_at: '2026-10-17T03:00:00.000Z',
          observed_at: '2026-10-17T04:00:00.000Z',
          sentiment: 'negative',
          group: 'own',
          seen_count: 1,
        },
        {
          id: 'mn_2',
          url: 'https://rival.example.com/b',
          title: 'Rival launches R2',
          text: '',
          origin: 'rival.example.com',
          published_at: '2026-10-16T03:00:00.000Z',
          observed_at: '2026-10-17T04:00:00.000Z',
          group: 'competitor',
          competitor: 'Rival',
          seen_count: 2,
        },
      ],
    }),
  }
})

const { MentionsTable, mentionsPayload } = await import('@/components/pr/mentions-table')

const scope: RailScope = {
  tier: 'role',
  scope_id: 'pr.monitoring',
  name: '信息监控',
  assignment: 'asg_mon',
}

describe('WP419 提及表', () => {
  it('列：哪一组（竞品带名字）、说了什么（链接）、情绪、来源、时间；新的在前', () => {
    const t = (k: string) =>
      ({
        'prm.group.own': '自家',
        'prm.group.competitor': '竞品',
        'prm.sent.negative': '负面',
        'prm.sent.none': '没判',
      })[k] ?? k
    const p = mentionsPayload(
      [
        {
          id: 'a',
          url: 'u1',
          text: 'old',
          origin: 'o',
          published_at: '2026-10-15T00:00:00Z',
          observed_at: '',
          group: 'competitor',
          competitor: 'Rival',
          seen_count: 1,
        },
        {
          id: 'b',
          url: 'u2',
          title: 'new',
          text: '',
          origin: 'o',
          published_at: '2026-10-16T00:00:00Z',
          observed_at: '',
          sentiment: 'negative',
          seen_count: 1,
        },
      ],
      t,
    )
    expect(p.rows.map((r) => r.id)).toEqual(['b', 'a'])
    expect(p.rows[1]).toMatchObject({ group: '竞品 · Rival', sentiment: '没判', url: 'u1' })
    expect(p.rows[0]).toMatchObject({ group: '自家', sentiment: '负面', what: 'new' })
  })

  it('信息监控那一层画出来；没拉到的源照实说', async () => {
    renderWithProviders(<MentionsTable scope={scope} />)
    await waitFor(() =>
      expect(screen.getByTestId('pr-mentions-table').textContent).toContain('battery recall'),
    )
    expect(screen.getByTestId('pr-mentions-failed').textContent).toContain('不等于没人提')
  })
})
