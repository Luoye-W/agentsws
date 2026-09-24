/**
 * WP141（docs/78 §2）守卫：**屏幕上不许出现内部值**。
 *
 * 渲染首页与岗位页的几块主要东西（用照着 demo 种子抄的数据：业务边界卡、挑人清单卡、
 * 属于一个没起名事项的回复卡、日报、红人交付物表），把整屏文字扫一遍：
 *
 * - snake_case 内部值（`late_return_grace_days`、`kol_campaign`、`wi_run_demo_42`）
 * - ISO 时间戳（`2026-09-27T01:00:00.000Z`）
 * - `xxx.yyy.zzz` 形态的 i18n 键（`kol.contact.source.sandbox`）
 *
 * 出现一个就失败，失败信息里带着是哪个词——下一次有人把字段名直接印上屏，这里先红。
 * 白名单只放几个合法的写法（邮箱域名那种），不放任何内部值。
 */
import type { BlockData, DeckCard } from '@agentsws/deck'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { BlockBody } from '@/components/blocks/block-view'
import { ReportBlocks } from '@/components/deck/panel-blocks'
import { draftCard, homeData, questionCard } from './fixtures'
import { renderWithProviders } from './helpers'

/** 屏上可能合法出现的「像内部值」的词（不是内部值本身）。 */
const SNAKE_ALLOW = new Set<string>([])
const HOST_ENDINGS = new Set(['com', 'net', 'org', 'io', 'example', 'dev', 'ai', 'cn', 'co', 'app'])

export function rawTokens(text: string): string[] {
  const snake = (text.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g) ?? []).filter((s) => !SNAKE_ALLOW.has(s))
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g) ?? []
  const keys = (text.match(/\b[a-z][a-z_]*(?:\.[a-z][a-z_]*){2,}\b/g) ?? []).filter(
    (k) => !HOST_ENDINGS.has(k.split('.').at(-1) ?? ''),
  )
  return [...new Set([...snake, ...iso, ...keys])]
}

/** 整屏文字 + 输入框的占位字（占位字也是给人看的）。 */
function screenText(root: HTMLElement): string {
  const placeholders = [...root.querySelectorAll('[placeholder]')].map(
    (el) => el.getAttribute('placeholder') ?? '',
  )
  return [root.textContent ?? '', ...placeholders].join('\n')
}

// ── 照 demo 种子抄的几张卡（apps/cli/src/demo.ts 与红人演练里真出现过的形状） ──

const policy = questionCard({
  id: 'ap_policy',
  title: '超过退货窗口一周的请求，怎么办？',
  detail: {
    ...draftCard().detail,
    payload: {
      target: 'workspace_policy',
      before: { late_return_grace_days: 0 },
      after: { late_return_grace_days: 7 },
    },
  },
})

const reply = draftCard({
  id: 'ap_reply',
  matter_id: 'wi_run_demo_42',
  title: '回复 anna@example.com：Re: Return request for #1001',
})

const campaign = draftCard({
  id: 'ap_campaign',
  kind: 'kol_campaign',
  layout: 'person',
  title: '挑人清单：夏季快充（2 人）',
  available_actions: ['approve', 'reject', 'snooze', 'open'],
  detail: {
    ...draftCard().detail,
    payload: {
      campaign_id: 'cmp_1',
      by_channel: [
        {
          channel: 'youtube',
          role_id: 'kol.youtube',
          allowed: true,
          picks: [{ display_name: 'Gadget Jonas' }, { display_name: 'Desk Rosa' }],
        },
      ],
    },
  },
})

const dailyReport: DeckCard = draftCard({
  id: 'ap_daily',
  kind: 'daily_report',
  layout: 'publish',
  title: '店铺日报 · 9 月 23 日',
  detail: {
    ...draftCard().detail,
    payload: { date: '2026-09-23', sales: 1299, orders: 3, low_stock: 1, pending: 2 },
  },
})

const home = homeData({ queue: [policy, reply, campaign], reports: [dailyReport] })

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getHome: async () => home,
    getPositions: async () => ({ positions: [], instances: [], tile_library: [], max_tiles: 4 }),
    listMembers: async () => [],
    listInProgress: async () => ({ items: [], scope: 'position' }),
    decide: async () => ({}),
  }
})

const { HomePage } = await import('@/pages/home')

describe('WP141 守卫：屏幕上没有内部值', () => {
  it('扫描器本身认得出三种毛病（反例）', () => {
    expect(rawTokens('late_return_grace_days: 0 → 7')).toEqual(['late_return_grace_days'])
    expect(rawTokens('期限 2026-09-27T01:00:00.000Z')).toEqual(['2026-09-27T01:00'])
    expect(rawTokens('来源 kol.contact.source.sandbox')).toEqual(['kol.contact.source.sandbox'])
    expect(rawTokens('写信到 sales@kraft-boxes.example 或 www.youtube.com')).toEqual([])
  })

  it('首页：页头、报表块、牌堆里每一张卡、卡型下拉、紧凑列表', async () => {
    const user = userEvent.setup()
    const { container } = renderWithProviders(<HomePage />)
    const deck = await screen.findByTestId('deck-section')
    await screen.findByTestId('deck-card')
    const seen: string[] = []
    for (let i = 0; i < home.queue.length; i += 1) {
      seen.push(...rawTokens(screenText(container)))
      await user.click(within(deck).getByTestId('deck-next'))
    }
    await user.click(within(deck).getByTestId('deck-list-toggle'))
    seen.push(...rawTokens(screenText(container)))
    expect([...new Set(seen)]).toEqual([])
  })

  it('报表块：日报列头是人话', () => {
    const { container } = renderWithProviders(
      <ReportBlocks reports={[dailyReport]} onOpen={() => {}} />,
    )
    expect(rawTokens(screenText(container))).toEqual([])
  })

  it('红人面板的交付物表：形态、期限、渠道都说人话', () => {
    const data = {
      block: {
        id: 'kol.pending_deliverables',
        component: 'table',
        source: 'kol',
        label: '待审交付物',
        query: 'kol.pending_deliverables',
      },
      range: 'yesterday',
      status: 'ok',
      payload: {
        columns: [
          { key: 'name', label: '红人' },
          { key: 'channel', label: '渠道' },
          { key: 'kind', label: '形态' },
          { key: 'due_at', label: '交付期限' },
        ],
        rows: [
          {
            name: 'Gadget Jonas',
            channel: 'youtube',
            kind: 'video',
            due_at: '2026-09-27T01:00:00.000Z',
          },
          {
            name: 'Desk Rosa',
            channel: 'instagram',
            kind: 'post',
            due_at: '2026-10-01T01:00:00.000Z',
          },
        ],
      },
    } as unknown as BlockData
    const { container } = renderWithProviders(<BlockBody data={data} />)
    const text = screenText(container)
    expect(rawTokens(text)).toEqual([])
    expect(text).not.toMatch(/\byoutube\b|\bvideo\b/)
    expect(text).toContain('YouTube')
  })
})
