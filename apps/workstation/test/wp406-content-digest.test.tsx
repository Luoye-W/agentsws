/**
 * WP406（私有 docs/107 §5）：工作台里的岗位更新。
 *
 * - 卡：「<岗位> · 本周更新 · N 项」、AI 一句建议、逐项「没改过 / 你改过 · 会保留 / 撞了」；
 *   「全部应用」「这次跳过」经审批定这张卡（选项），「挑着看」开第三栏；底下那排不再出一个「批准」；
 * - 第三栏：三档设置、逐项勾选、展开看改动、撞了三栏 + 三种选法（AI 那一版点了才出）、应用勾了的、退回；
 * - 公司模式非负责人：只看到「有更新，等负责人看」，没有按钮；
 * - 没订阅：一行小字 +「看看更新了什么」+「订阅」，关掉 30 天不提。
 */
import type {
  ContentDigestCardPayload,
  ContentItemDiffView,
  PositionContentUpdatesView,
} from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PositionUpdates } from '@/components/content-updates/position-updates'
import { DeckCardView } from '@/components/deck/deck-card'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const noop = (): void => {}
const decide = vi.fn(async (_id: string, _input: unknown, _asg: string) => ({}))
const calls: { path: string; method: string; body?: unknown }[] = []
let view: PositionContentUpdatesView
let diff: ContentItemDiffView

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    decide: (id: string, input: unknown, asg: string) => decide(id, input, asg),
    api: async (path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ path, method: init?.method ?? 'GET', body: init?.body })
      if (path.includes('/diff')) return diff
      if (path.endsWith('/ai-merge')) return { text: 'AI 合好的口气。' }
      if (path === '/v1/content-updates/subscription') return { state: 'active' }
      return view
    },
  }
})

const PAYLOAD: ContentDigestCardPayload = {
  form: 'content_update_digest',
  workspace_id: 'ws_1' as never,
  position_id: 'web-ops',
  position_name: { zh: '网站运营', en: 'Web ops' },
  week: '2026-W43',
  urgent: false,
  advice: '建议全部应用，撞了的那一处先保留你的。',
  serial: 3,
  items: [
    {
      item_id: 'rules:seo.claim_rules',
      kind: 'rules',
      name: 'seo.claim_rules',
      version: '1.1.0',
      title: { zh: '违规宣称规则 +3 条', en: 'Claim rules +3' },
      summary: { zh: '10 月新政策', en: 'October policy' },
      mine: 'untouched',
    },
    {
      item_id: 'role_content:dtc.store',
      kind: 'role_content',
      name: 'dtc.store',
      version: '1.2.0',
      title: { zh: '店铺管理 角色定位改口气', en: 'Store tone' },
      summary: { zh: '改口气', en: 'Tone' },
      mine: 'clash',
    },
    {
      item_id: 'skill:flash-sale-check',
      kind: 'skill',
      name: 'flash-sale-check',
      version: '1.0.0',
      title: { zh: '新技能「秒杀报名检查」', en: 'New skill' },
      summary: { zh: '新加', en: 'New' },
      mine: 'untouched',
      added: true,
    },
  ],
}

const digestCard = (): DeckCard => {
  const b = draftCard()
  return draftCard({
    id: 'ap_digest',
    kind: 'content_update_digest' as never,
    layout: 'policy',
    title: '网站运营 · 本周更新 · 3 项',
    available_actions: ['approve', 'snooze', 'open'],
    action_labels: { approve: '全部应用', snooze: '稍后', open: '挑着看' },
    detail: { ...b.detail, payload: PAYLOAD as unknown as Record<string, unknown> },
  })
}

const baseView = (over: Partial<PositionContentUpdatesView> = {}): PositionContentUpdatesView => ({
  position_id: 'web-ops',
  policy: 'ask',
  subscription: { state: 'active', credits_per_month: 30 },
  can_apply: true,
  pending: PAYLOAD.items,
  card_id: 'ap_digest',
  applied: [
    {
      item_id: 'rules:roles.house_rules',
      kind: 'rules',
      title: { zh: '说话规矩 改 1 条', en: 'House rules' },
      version: '1.0.1',
      applied_at: '2026-10-12T02:00:00.000Z',
    },
  ],
  last_batch: {
    batch_id: 'cb_1',
    applied_at: '2026-10-12T02:00:00.000Z',
    by: 'person',
    item_ids: ['rules:roles.house_rules'],
  },
  ...over,
})

beforeEach(() => {
  decide.mockClear()
  calls.length = 0
  view = baseView()
  diff = {
    item_id: 'role_content:dtc.store',
    kind: 'role_content',
    title: { zh: '店铺管理 角色定位改口气', en: 'Store tone' },
    to_version: '1.2.0',
    applied: false,
    parts: [
      {
        key: 'persona.tone',
        label: '口气',
        change: 'changed',
        before: '像管店的人。',
        after: '官方新口气。',
        mine: '我们的口气。',
        edited: true,
        clash: true,
        mergeable: true,
      },
    ],
  }
})

describe('WP406 岗位更新卡', () => {
  it('卡面：标题、AI 一句建议、逐项你改过没；全部应用 / 这次跳过走选项，底下不再出「批准」', async () => {
    renderWithProviders(
      <DeckCardView card={digestCard()} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    expect(screen.getByText('网站运营 · 本周更新 · 3 项')).toBeTruthy()
    expect(screen.getByTestId('content-digest-advice').textContent).toBe(
      '建议全部应用，撞了的那一处先保留你的。',
    )
    const rows = screen.getAllByTestId('content-digest-item')
    expect(rows.map((r) => r.getAttribute('data-mine'))).toEqual([
      'untouched',
      'clash',
      'untouched',
    ])
    expect(rows[1]?.textContent).toContain('撞了')
    expect(rows[2]?.textContent).toContain('新增')
    await userEvent.click(screen.getByTestId('content-digest-apply'))
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    expect(decide.mock.calls[0]?.[1]).toMatchObject({
      action: 'approve',
      selected_option_id: 'apply_all',
    })
    await userEvent.click(screen.getByTestId('content-digest-skip'))
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(2))
    expect(decide.mock.calls[1]?.[1]).toMatchObject({ selected_option_id: 'skip' })
    expect(screen.queryByTestId('content-digest-pick')).toBeTruthy()
  })
})

describe('WP406 第三栏「岗位更新」', () => {
  it('逐项勾选、展开撞了的那一项三栏对照、选「用 AI 合好的这版」，应用勾了的带上选法', async () => {
    renderWithProviders(<PositionUpdates positionId="web-ops" />)
    await screen.findByTestId('position-updates')
    const items = screen.getAllByTestId('cd-pending-item')
    expect(items).toHaveLength(3)
    // 第三项不要
    await userEvent.click(within(items[2] as HTMLElement).getByTestId('cd-check'))
    await userEvent.click(within(items[1] as HTMLElement).getByTestId('cd-expand'))
    const part = await screen.findByTestId('cd-part')
    expect(part.textContent).toContain('原来')
    expect(part.textContent).toContain('新版')
    expect(part.textContent).toContain('你的')
    await userEvent.click(screen.getByTestId('cd-choice-use_ai'))
    const box = await screen.findByTestId('cd-ai-text')
    expect(box.querySelector('textarea')?.value).toBe('AI 合好的口气。')
    await userEvent.click(screen.getByTestId('cd-ai-save'))
    await userEvent.click(screen.getByTestId('cd-apply'))
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/apply'))).toBe(true))
    const apply = calls.find((c) => c.path.endsWith('/apply'))
    expect(apply?.body).toEqual({
      item_ids: ['rules:seo.claim_rules', 'role_content:dtc.store'],
      choices: { 'role_content:dtc.store#persona.tone': 'use_ai' },
      ai_texts: { 'role_content:dtc.store#persona.tone': 'AI 合好的口气。' },
    })
  })

  it('三档设置、单项退回、整批退回', async () => {
    renderWithProviders(<PositionUpdates positionId="web-ops" />)
    await screen.findByTestId('position-updates')
    await userEvent.click(screen.getByTestId('cd-policy-auto_clean'))
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/policy'))?.body).toEqual({ policy: 'auto_clean' }),
    )
    await userEvent.click(screen.getByTestId('cd-rollback-item'))
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/rollback'))?.body).toEqual({
        item_id: 'rules:roles.house_rules',
      }),
    )
    await userEvent.click(screen.getByTestId('cd-rollback-batch'))
    await waitFor(() =>
      expect(calls.filter((c) => c.path.endsWith('/rollback')).at(-1)?.body).toEqual({}),
    )
  })

  it('公司模式非负责人：只看到「有更新，等负责人看」，没有勾、没有按钮', async () => {
    view = baseView({ can_apply: false })
    renderWithProviders(<PositionUpdates positionId="web-ops" />)
    const root = await screen.findByTestId('position-updates')
    expect(root.textContent).toContain('有更新，等负责人看')
    expect(screen.queryByTestId('cd-apply')).toBeNull()
    expect(screen.queryByTestId('cd-check')).toBeNull()
    expect(screen.queryByTestId('cd-rollback-item')).toBeNull()
    expect((screen.getByTestId('cd-policy-ask') as HTMLButtonElement).disabled).toBe(true)
  })

  it('没订阅：一行小字 +「看看更新了什么」+「订阅 · 30 积分 / 月」，没有「试用」；关掉 30 天不提', async () => {
    view = baseView({
      subscription: { state: 'none', credits_per_month: 30 },
      pending: [],
      applied: [],
      nudge: {
        count: 5,
        urgent: false,
        titles: [{ zh: 'Listing 体检规则 +3 条', en: 'Listing rules +3' }],
      },
    })
    delete (view as { last_batch?: unknown }).last_batch
    renderWithProviders(<PositionUpdates positionId="web-ops" />)
    const nudge = await screen.findByTestId('cd-nudge')
    expect(nudge.textContent).toContain('官方本周更新了 5 项 · 订阅后可用')
    expect(nudge.textContent).not.toContain('试用')
    await userEvent.click(screen.getByTestId('cd-nudge-look'))
    expect(screen.getByTestId('cd-nudge-titles').textContent).toContain('Listing 体检规则 +3 条')
    expect(screen.getByTestId('cd-subscribe').textContent).toBe('订阅 · 30 积分 / 月')
    await userEvent.click(screen.getByTestId('cd-subscribe'))
    await waitFor(() =>
      expect(
        calls.some((c) => c.path === '/v1/content-updates/subscription' && c.method === 'POST'),
      ).toBe(true),
    )
    await userEvent.click(screen.getByTestId('cd-nudge-close'))
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/nudge/dismiss'))).toBe(true))
  })
})
