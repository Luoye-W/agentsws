/**
 * WP219（docs/90 §6.1）：设置 → 通用「已审的内容更新」与两种卡（内容更新卡、冲突选择卡）。
 */
import type { ContentDiffView, ContentUpdatesView } from '@agentsws/contracts'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const calls: string[] = []
let view: ContentUpdatesView

const DIFF: ContentDiffView = {
  item_id: 'skill:shopify',
  title: { zh: 'Shopify 官方技能', en: 'Shopify official skill' },
  from_version: '1.17.1',
  to_version: '1.18.0',
  sections: [
    { heading: '官方参考：liquid', change: 'changed', before: '旧的写法', after: '新的写法' },
    { heading: '官方参考：checkout', change: 'added', after: '新加的一份参考' },
  ],
}

vi.mock('@/lib/content-updates', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/content-updates')>('@/lib/content-updates')
  return {
    ...actual,
    getContentUpdates: async () => view,
    setContentUpdateMode: async (mode: 'auto' | 'ask') => {
      calls.push(`mode:${mode}`)
      view = { ...view, mode }
      return view
    },
    checkContentUpdates: async () => {
      calls.push('check')
      return view
    },
    applyContentUpdate: async (id: string) => {
      calls.push(`apply:${id}`)
      return view
    },
    rollbackContentUpdate: async (id: string) => {
      calls.push(`rollback:${id}`)
      return view
    },
    getContentDiff: async () => DIFF,
  }
})

const { ContentUpdatesSetting } = await import('@/components/settings/content-updates-setting')
const { DeckCardView } = await import('@/components/deck/deck-card')

beforeEach(() => {
  calls.length = 0
  view = {
    mode: 'ask',
    channel: 'beta',
    state: 'ok',
    last_checked_at: '2026-10-05T08:00:00.000Z',
    items: [
      {
        id: 'skill:shopify',
        name: 'shopify',
        title: { zh: 'Shopify 官方技能', en: 'Shopify official skill' },
        state: 'available',
        current_version: '1.17.1',
        available_version: '1.18.0',
        upstream_published_at: '2026-10-01',
      },
      {
        id: 'skill:seo-judgment',
        name: 'seo-judgment',
        title: { zh: '搜索判断', en: 'SEO judgment' },
        state: 'current',
        current_version: '1.2.0',
        previous_version: '1.1.0',
        updated_at: '2026-10-04T08:00:00.000Z',
      },
    ],
  }
})

describe('设置 → 通用「已审的内容更新」', () => {
  it('默认「每次问我」；点「自动」就改；条目用状态图标；更新 / 退回各管各的', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ContentUpdatesSetting />)
    const row = await screen.findByTestId('settings-content-updates')
    const pills = within(row).getByTestId('content-updates-mode')
    expect(
      within(pills).getByRole('button', { name: '每次问我' }).getAttribute('aria-pressed'),
    ).toBe('true')
    const channel = within(row).getByTestId('content-updates-channel')
    expect(within(channel).getByTestId('status-icon').getAttribute('data-state')).toBe('ok')

    const items = within(row).getAllByTestId('content-update-item')
    expect(items.map((i) => i.getAttribute('data-state'))).toEqual(['available', 'current'])
    const [shopify, seo] = items as [HTMLElement, HTMLElement]
    expect(within(shopify).getByTestId('content-update-version').textContent).toBe(
      '1.17.1 → 1.18.0',
    )
    expect(within(shopify).queryByTestId('content-update-rollback')).toBeNull()
    expect(within(seo).queryByTestId('content-update-apply')).toBeNull()

    await user.click(within(pills).getByRole('button', { name: '自动' }))
    await user.click(within(shopify).getByTestId('content-update-apply'))
    await user.click(within(seo).getByTestId('content-update-rollback'))
    await waitFor(() => {
      expect(calls).toEqual(['mode:auto', 'apply:skill:shopify', 'rollback:skill:seo-judgment'])
    })
  })

  it('查看改动：按段列出（原来 / 新版）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ContentUpdatesSetting />)
    const row = await screen.findByTestId('settings-content-updates')
    await user.click(within(row).getAllByTestId('content-update-diff')[0] as HTMLElement)
    const dialog = await screen.findByTestId('content-diff-dialog')
    expect(within(dialog).getAllByTestId('content-diff-section')).toHaveLength(2)
    expect(dialog.textContent).toContain('1.17.1 → 1.18.0')
    expect(within(dialog).getAllByTestId('content-diff-after')[0]?.textContent).toContain(
      '新的写法',
    )
  })

  it('通道关着 / 这次没收：图标 + 一句人话，关着时不给「查一次」', async () => {
    view = {
      ...view,
      state: 'error',
      reason: '这次的更新包签名对不上，没收，照旧用现在这一版。',
      items: [],
    }
    const first = renderWithProviders(<ContentUpdatesSetting />)
    const row = await screen.findByTestId('settings-content-updates')
    expect(within(row).getByTestId('status-icon').getAttribute('data-state')).toBe('fail')
    expect(within(row).getByTestId('content-updates-reason').textContent).toContain('签名对不上')
    first.unmount()
    view = { ...view, state: 'off', reason: '这台没开内容更新（装好的桌面版才开）。' }
    renderWithProviders(<ContentUpdatesSetting />)
    const off = await screen.findByTestId('settings-content-updates')
    expect(within(off).queryByTestId('content-updates-check')).toBeNull()
    expect(within(off).getByTestId('status-icon').getAttribute('data-state')).toBe('unknown')
  })
})

describe('内容更新卡 / 冲突选择卡', () => {
  it('内容更新卡：主按钮「更新」，旁边「查看改动」开弹窗', async () => {
    const user = userEvent.setup()
    const decided: string[] = []
    renderWithProviders(
      <DeckCardView
        card={draftCard({
          id: 'ap_cu',
          kind: 'content_update',
          layout: 'policy',
          title: 'Shopify 官方技能 有新版 · 官方 2026-10-01 更新 · 已审',
          summary: '官方参考里 Liquid 的写法更新了',
          content_variants: { zh_summary: '官方参考里 Liquid 的写法更新了' },
          available_actions: ['approve', 'snooze', 'open'],
          action_labels: { approve: '更新', snooze: '稍后', open: '查看改动' },
          detail: {
            ...draftCard().detail,
            payload: {
              form: 'content_update',
              item_id: 'skill:shopify',
              before: { 版本: '1.17.1' },
              after: { 版本: '1.18.0' },
            },
          },
        })}
        mode="zh_summary"
        onDecide={(d) => {
          decided.push(d.action)
        }}
        onOpen={() => {
          decided.push('open-matter')
        }}
      />,
    )
    const bar = screen.getByTestId('deck-action-bar')
    expect(within(bar).getByRole('button', { name: '更新' }).getAttribute('data-rank')).toBe(
      'primary',
    )
    await user.click(within(bar).getByTestId('deck-content-compare'))
    expect(await screen.findByTestId('content-diff-dialog')).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByTestId('content-diff-dialog')).toBeNull()
    })
    await user.click(within(bar).getByRole('button', { name: '更新' }))
    expect(decided).toEqual(['approve'])
  })

  it('冲突选择卡：用新版 / 保留我的；「看对比」三栏：旧版 / 新版 / 你的', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <DeckCardView
        card={draftCard({
          id: 'ap_cc',
          kind: 'content_conflict',
          layout: 'choice',
          title: 'Shopify 官方技能「规矩」这一段：新版和你的改动不一样',
          options: [
            { id: 'use_new', label: '用新版' },
            { id: 'keep_mine', label: '保留我的' },
          ],
          available_actions: ['approve', 'snooze', 'open'],
          action_labels: { approve: '就这样', snooze: '稍后', open: '看对比' },
          detail: {
            ...draftCard().detail,
            payload: {
              form: 'content_conflict',
              item_id: 'skill:shopify',
              name: 'shopify',
              heading: '规矩',
              base_before: '出卡等人批。',
              base_after: '出卡等人批；周日不发。',
              mine: '出卡等人批；只在工作日发。',
            },
          },
        })}
        mode="zh_summary"
        onDecide={() => {}}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByRole('radio', { name: '用新版' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: '保留我的' })).toBeTruthy()
    await user.click(screen.getByTestId('deck-content-compare'))
    const dialog = await screen.findByTestId('content-conflict-dialog')
    expect(within(dialog).getByTestId('conflict-before').textContent).toContain('出卡等人批。')
    expect(within(dialog).getByTestId('conflict-after').textContent).toContain('周日不发')
    expect(within(dialog).getByTestId('conflict-mine').textContent).toContain('只在工作日发')
  })
})
