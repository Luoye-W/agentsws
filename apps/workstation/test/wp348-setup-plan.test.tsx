/**
 * WP348（决策 887）：配置卡的卡面是方案——默认不展开表单；理由与来源（网页可点开）；需要你填；
 * 「就这样」= approve 不带值；「改一下」展开表单且预填方案值、保存 = 人改的值；改设置方案卡只列要改的几格（现值 → 新值）。
 */
import type { SetupRequestPayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const noop = (): void => {}
const decide = vi.fn(async (_id: string, _input: unknown, _asg: string) => ({}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, decide: (id: string, input: unknown, asg: string) => decide(id, input, asg) }
})

beforeEach(() => {
  decide.mockClear()
})

function card(payload: SetupRequestPayload, title = 'Reddit 巡查：我打算这样设'): DeckCard {
  const base = draftCard()
  return draftCard({
    id: 'ap_plan',
    kind: 'setup_request',
    layout: 'policy',
    title,
    available_actions: ['approve', 'reject', 'snooze', 'open'],
    action_labels: { approve: '就这样', reject: '先不设', snooze: '稍后' },
    detail: { ...base.detail, payload: payload as never },
  })
}

const plan: SetupRequestPayload = {
  form: 'setup_request',
  target: 'reddit.watch',
  why: '我先查了一遍，按这个方案巡查。',
  mode: 'plan',
  fields: [
    {
      key: 'watch_subreddits',
      label: '重点版块',
      kind: 'text',
      suggested: 'SmartGlasses, Xreal（每周）',
      suggested_why: '品类、竞品的用户在这几个版',
      sources: [
        { kind: 'web', label: 'r/SmartGlasses', url: 'https://www.reddit.com/r/SmartGlasses/' },
        { kind: 'model', label: 'AI 整理' },
      ],
      required: false,
    },
    {
      key: 'brand_username',
      label: '品牌号',
      kind: 'text',
      suggested: 'INMO_Official',
      suggested_why: '插件里登着的就是这个号',
      sources: [{ kind: 'connected', label: '插件里登着的 Reddit 号' }],
      required: false,
    },
    { key: 'alert_words', label: '告警词', kind: 'text', required: false },
    {
      key: 'every_hours',
      label: '收件箱和关键词',
      kind: 'select',
      options: [
        { value: '24', label: '每天一次' },
        { value: '12', label: '每 12 小时' },
      ],
      suggested: '24',
      suggested_why: '默认每天一次',
      required: true,
    },
  ],
  steps: [
    { text: '看了品牌档案：INMO' },
    {
      text: '插件里登着的 Reddit 号：u/INMO_Official',
      source: { kind: 'connected', label: '插件' },
    },
  ],
}

describe('方案卡（WP348）', () => {
  it('默认是方案不是表单：值 + 理由 + 来源（网页可点开）；查了几处收起；「就这样」= approve 不带值', async () => {
    renderWithProviders(
      <DeckCardView card={card(plan)} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    expect(screen.queryByTestId('setup-fields')).toBeNull()
    const rows = screen.getAllByTestId('setup-plan-row')
    expect(rows.map((r) => r.dataset.key)).toEqual([
      'watch_subreddits',
      'brand_username',
      'alert_words',
      'every_hours',
    ])
    const watch = rows[0] as HTMLElement
    expect(within(watch).getByTestId('setup-plan-value').textContent).toBe(
      'SmartGlasses, Xreal（每周）',
    )
    expect(within(watch).getByTestId('setup-plan-why').textContent).toBe(
      '品类、竞品的用户在这几个版',
    )
    const link = within(watch).getByRole('link')
    expect(link.getAttribute('href')).toBe('https://www.reddit.com/r/SmartGlasses/')
    expect(link.getAttribute('rel')).toContain('noopener')
    // 下拉显示人话
    expect(within(rows[3] as HTMLElement).getByTestId('setup-plan-value').textContent).toBe(
      '每天一次',
    )
    // 空着的可选格：不设（不是「需要你填」）
    expect(rows[2]?.dataset.needsYou).toBeUndefined()
    expect(screen.getByTestId('setup-plan-steps').textContent).toContain('查了 2 处')
    await userEvent.click(screen.getByTestId('setup-plan-accept'))
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    const input = decide.mock.calls[0]?.[1] as { action: string; edited_payload?: unknown }
    expect(input.action).toBe('approve')
    expect(input.edited_payload).toBeUndefined()
  })

  it('「改一下」展开表单且预填方案值；保存 = 人改的值为准', async () => {
    renderWithProviders(
      <DeckCardView card={card(plan)} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    await userEvent.click(screen.getByTestId('setup-plan-edit'))
    const fields = screen.getAllByTestId('setup-field')
    const watch = within(fields[0] as HTMLElement).getByRole('textbox') as HTMLInputElement
    expect(watch.value).toBe('SmartGlasses, Xreal（每周）')
    await userEvent.clear(watch)
    await userEvent.type(watch, 'SmartGlasses')
    await userEvent.click(screen.getByTestId('setup-fields-save'))
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    const input = decide.mock.calls[0]?.[1] as {
      action: string
      edited_payload: { values: Record<string, string> }
    }
    expect(input.edited_payload.values).toMatchObject({
      watch_subreddits: 'SmartGlasses',
      brand_username: 'INMO_Official',
      every_hours: '24',
    })
  })

  it('必填又查不到：标「需要你填」，「就这样」点不了、「改一下」成主按钮', () => {
    const p: SetupRequestPayload = {
      ...plan,
      fields: [
        {
          key: 'google',
          label: 'Google 广告账户',
          kind: 'text',
          required: true,
          needs_you: true,
          suggested_why: '插件还没在后台里看到账户，要你填',
        },
      ],
    }
    renderWithProviders(
      <DeckCardView
        card={card(p, '广告账户：我打算这样设')}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    expect(screen.getByTestId('setup-plan-needs-you').textContent).toBe('需要你填')
    expect((screen.getByTestId('setup-plan-accept') as HTMLButtonElement).disabled).toBe(true)
  })

  it('改设置方案卡：只列要改的（现值 → 新值），其余不动', () => {
    const p: SetupRequestPayload = {
      form: 'setup_request',
      target: 'reddit.watch',
      why: '把 Xreal 改成每周两次。',
      mode: 'change',
      fields: [
        {
          key: 'watch_subreddits',
          label: '重点版块',
          kind: 'text',
          current: 'SmartGlasses, Xreal（每周）',
          suggested: 'SmartGlasses, Xreal（每周2次）',
          suggested_why: '量不大，一周两次够',
          required: false,
        },
        {
          key: 'keywords',
          label: '关键词',
          kind: 'text',
          current: 'INMO',
          suggested: 'INMO',
          required: false,
        },
      ],
    }
    renderWithProviders(
      <DeckCardView
        card={card(p, 'Reddit 巡查：我打算改成这样')}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    const rows = screen.getAllByTestId('setup-plan-row')
    expect(rows.map((r) => r.dataset.key)).toEqual(['watch_subreddits'])
    expect(screen.getByTestId('setup-plan-current').textContent).toBe('SmartGlasses, Xreal（每周）')
    expect(screen.getByTestId('setup-plan-value').textContent).toBe(
      'SmartGlasses, Xreal（每周2次）',
    )
    expect(screen.getByText('其余不动')).toBeTruthy()
  })
})
