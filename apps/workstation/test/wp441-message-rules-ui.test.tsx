/**
 * WP441（docs/108 §5.1 / §5.6）：消息规则的界面。
 *
 * - 规则面板顶上一句话 → 「要建这条规则吗」：试跑几封、会改掉去向的几封、花了多少积分；勾「也处理过去 30 天的」
 *   再点「建」= 选 `after_past`；
 * - 「消息规则」一组：开关带版本号、删、上下键排序、看最近命中；拿旧版本改的照实回「刚被 X 改过」；
 * - 「系统规则」：今天的简报几点发；
 * - 卡片流里那张卡同一个样子，「建」在卡身里；
 * - 类型胶囊弹层：按哪条规则处理、「这封不该归它」、「在对话里改」；
 * - 今天的简报面板：按规则分组、「全部知道了」。
 */
import type {
  MessageDigest,
  MessageRuleList,
  MessageRuleProposal,
  MessageRuleView,
} from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { takePendingAsk } from '@/components/free-chat/pending-ask'
import { KindChip } from '@/components/messages/kind-chip'
import { MESSAGE_DIGEST_ADDRESS } from '@/components/messages/rules-address'
import { ensureBuiltinPanels } from '@/components/rail/builtin-panels'
import { MessageDigestPanel } from '@/components/rail/panels/message-digest-panel'
import { MessageRulesPanel } from '@/components/rail/panels/message-rules-panel'
import { resolvePanel } from '@/components/rail/registry'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const T0 = '2026-10-22T01:00:00.000Z'

const rule = (
  over: Partial<MessageRuleView> & Pick<MessageRuleView, 'id' | 'name'>,
): MessageRuleView => ({
  scope: { kind: 'brand' },
  when: { match: 'all', conditions: [{ type: 'from', value: '@shopify.com' }] },
  actions: [{ type: 'notice' }],
  enabled: true,
  order: 0,
  revision: 1,
  by: 'p_me',
  updated_by: 'p_me',
  created_at: T0,
  updated_at: T0,
  origin_text: over.name,
  ...over,
})

let rules: MessageRuleList = { rules: [] }
const proposal: MessageRuleProposal = {
  ok: true,
  draft: {
    name: 'Shopify 结算通知',
    when: {
      match: 'all',
      conditions: [
        { type: 'from', value: '@shopify.com' },
        { type: 'subject_has', value: 'payout' },
      ],
    },
    actions: [{ type: 'notice' }, { type: 'label', label: 'billing' }],
    origin_text: 'Shopify 结算通知打标签别烦我',
  },
  plain: 'shopify.com 发来、主题含「payout」 → 只是通知、不烦你、打标签「账单与发票」',
  trial: {
    scanned: 120,
    matched: 14,
    sample: [
      {
        message_id: 'm1',
        thread_id: 't1',
        subject: 'Your payout of $120',
        from: 'Shopify',
        at: T0,
      },
    ],
    changed: [
      {
        message_id: 'm2',
        thread_id: 't2',
        subject: 'Payout on hold',
        from: 'Shopify',
        at: T0,
        before: 'customer-care',
        after: 'notice',
      },
    ],
    credits: 0.12,
  },
  card_id: 'ap_rule_1',
}

const api = {
  propose: vi.fn(async (_i: unknown) => proposal),
  decide: vi.fn(async (_id: string, _pick: string) => ({})),
  update: vi.fn(async (_id: string, _p: unknown): Promise<unknown> => ({})),
  remove: vi.fn(async (_id: string) => ({ deleted: true })),
  restore: vi.fn(async (_id: string) => ({ restored: true })),
  reorder: vi.fn(async (_ids: string[]) => rules),
  exclude: vi.fn(async (_m: string, _r: string) => ({})),
  ack: vi.fn(async () => ({ acked: 2 })),
  deckDecide: vi.fn(async (..._a: unknown[]) => ({})),
}

let digest: MessageDigest = { time: '09:00', total: 0, groups: [] }

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listMessageSenderRules: async () => ({ rules: [], shared: false, recently_deleted: [] }),
    listMessageRules: async () => rules,
    listMessageLabels: async () => ({
      labels: [
        { id: 'billing', name_zh: '账单与发票', name_en: 'Billing', color: 'blue', builtin: true },
      ],
    }),
    proposeMessageRule: (i: unknown) => api.propose(i),
    decideMessageRuleCard: (id: string, pick: string) => api.decide(id, pick),
    updateMessageRule: (id: string, p: unknown) => api.update(id, p),
    deleteMessageRule: (id: string) => api.remove(id),
    restoreMessageRule: (id: string) => api.restore(id),
    reorderMessageRules: (ids: string[]) => api.reorder(ids),
    excludeFromMessageRule: (m: string, r: string) => api.exclude(m, r),
    getMessageDigest: async () => digest,
    ackMessageDigest: () => api.ack(),
    decide: (...a: unknown[]) => api.deckDecide(...a),
    getMessageOverview: async () => ({
      unclaimed: 0,
      notice: 0,
      handed: 0,
      handed_by_position: [],
      cards_waiting: 0,
      notice_groups: [],
      positions: [{ id: 'customer-care', name_zh: '客服', name_en: 'Customer care', open: true }],
      taught: { rules: 0, saved: 0, recent: [] },
    }),
  }
})

beforeEach(() => {
  for (const f of Object.values(api)) f.mockClear()
  rules = { rules: [] }
})

describe('WP441 规则面板：一句话写规则', () => {
  it('试跑数字、会改掉去向的、积分；勾「也处理过去 30 天的」再建 = after_past', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MessageRulesPanel />)
    await user.type(await screen.findByTestId('message-rule-input'), 'Shopify 结算通知打标签别烦我')
    await user.click(screen.getByTestId('message-rule-propose'))
    const box = await screen.findByTestId('rule-proposal')
    expect(api.propose).toHaveBeenCalledWith({ text: 'Shopify 结算通知打标签别烦我' })
    expect(box.textContent).toContain('过去 30 天会命中 14 封')
    const changed = within(box).getByTestId('rule-proposal-changed')
    expect(changed.textContent).toContain('会改掉去向的 1 封')
    await waitFor(() => {
      expect(changed.textContent).toContain('客服')
    })
    expect(changed.textContent).toContain('只是通知')
    expect(within(box).getByTestId('rule-proposal-credits').textContent).toContain('0.12')
    // 默认不勾
    expect((within(box).getByTestId('rule-proposal-past') as HTMLInputElement).checked).toBe(false)
    await user.click(within(box).getByTestId('rule-proposal-past'))
    await user.click(within(box).getByTestId('rule-proposal-build'))
    await waitFor(() => {
      expect(api.decide).toHaveBeenCalledWith('ap_rule_1', 'after_past')
    })
    expect((await screen.findByTestId('message-rules-echo')).textContent).toContain('规则建好了')
  })

  it('「不要」= before；没听懂照实说', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MessageRulesPanel />)
    await user.type(await screen.findByTestId('message-rule-input'), '推销的都告诉我')
    await user.click(screen.getByTestId('message-rule-propose'))
    await user.click(await screen.findByTestId('rule-proposal-drop'))
    await waitFor(() => {
      expect(api.decide).toHaveBeenCalledWith('ap_rule_1', 'before')
    })
    api.propose.mockResolvedValueOnce({ ok: false, message: '没听懂要对哪些信做什么。' })
    await user.clear(screen.getByTestId('message-rule-input'))
    await user.type(screen.getByTestId('message-rule-input'), '今天天气不错')
    await user.click(screen.getByTestId('message-rule-propose'))
    expect((await screen.findByTestId('message-rules-echo')).textContent).toContain('没听懂')
  })
})

describe('WP441 规则面板：消息规则一组、系统规则', () => {
  it('开关带版本号；上下键排序；删；看最近命中；系统规则改时间', async () => {
    rules = {
      shared: false,
      rules: [
        rule({
          id: 'a',
          name: '结算通知',
          hits_30d: 3,
          recent_hits: [
            { message_id: 'm1', thread_id: 't1', subject: 'Payout sent', from: 'Shopify', at: T0 },
          ],
          actions: [{ type: 'notice' }, { type: 'label', label: 'billing' }],
        }),
        rule({
          id: 'b',
          name: '推销',
          order: 1,
          revision: 4,
          when: { match: 'all', conditions: [{ type: 'ai', value: '推销' }] },
          actions: [{ type: 'notify' }],
        }),
        rule({
          id: 'mrule_sys_digest',
          name: '今天的简报',
          system: 'digest_time',
          time: '09:00',
          order: 1e6,
          when: { match: 'all', conditions: [] },
          actions: [],
        }),
      ],
    }
    const user = userEvent.setup()
    renderWithProviders(<MessageRulesPanel />)
    const items = await screen.findAllByTestId('message-rule-item')
    expect(items).toHaveLength(2)
    const groups = screen
      .getAllByTestId('message-rules-group')
      .map((g) => g.getAttribute('data-group'))
    expect(groups).toEqual(['message', 'system'])
    const first = items[0] as HTMLElement
    await waitFor(() => {
      expect(within(first).getByTestId('message-rule-plain').textContent).toContain(
        '打标签「账单与发票」',
      )
    })
    expect(within(first).getByTestId('message-rule-plain').textContent).toContain(
      'shopify.com 发来',
    )

    await user.click(within(items[1] as HTMLElement).getByTestId('message-rule-toggle'))
    await waitFor(() => {
      expect(api.update).toHaveBeenCalledWith('b', { revision: 4, enabled: false })
    })

    within(first).getByTestId('message-rule-drag').focus()
    fireEvent.keyDown(within(first).getByTestId('message-rule-drag'), { key: 'ArrowDown' })
    await waitFor(() => {
      expect(api.reorder).toHaveBeenCalledWith(['b', 'a'])
    })

    await user.click(within(first).getByTestId('message-rule-hits'))
    expect(within(first).getByTestId('message-rule-recent').textContent).toContain('Payout sent')

    await user.click(within(first).getByTestId('message-rule-remove'))
    await waitFor(() => {
      expect(api.remove).toHaveBeenCalledWith('a')
    })

    const time = screen.getByTestId('message-rule-digest-time') as HTMLInputElement
    fireEvent.change(time, { target: { value: '08:30' } })
    fireEvent.blur(time)
    await waitFor(() => {
      expect(api.update).toHaveBeenCalledWith('mrule_sys_digest', { revision: 1, time: '08:30' })
    })
  })

  it('删了回声带「撤回」；同事模式「刚删的」写谁删的、能撤回', async () => {
    rules = {
      shared: true,
      rules: [rule({ id: 'a', name: '结算通知' })],
      recently_deleted: [
        rule({
          id: 'z',
          name: '旧规则',
          deleted_at: T0,
          deleted_by: 'p_lin',
          deleted_by_name: '林二',
        }),
      ],
    }
    const user = userEvent.setup()
    renderWithProviders(<MessageRulesPanel />)
    const item = await screen.findByTestId('message-rule-item')
    await user.click(within(item).getByTestId('message-rule-remove'))
    await user.click(await screen.findByTestId('message-rules-undo'))
    await waitFor(() => {
      expect(api.restore).toHaveBeenCalledWith('a')
    })
    const gone = screen.getByTestId('message-rule-deleted')
    expect(gone.textContent).toContain('林二 删的')
    await user.click(within(gone).getByTestId('message-rule-restore'))
    await waitFor(() => {
      expect(api.restore).toHaveBeenCalledWith('z')
    })
  })

  it('拿旧版本改的：照实说「刚被 X 改过」', async () => {
    rules = { rules: [rule({ id: 'a', name: '结算通知' })] }
    api.update.mockRejectedValueOnce(
      Object.assign(new Error('这条规则刚被 林二 改过，以它为准再说一次。'), {
        status: 409,
        code: 'conflict',
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<MessageRulesPanel />)
    const item = await screen.findByTestId('message-rule-item')
    await user.click(within(item).getByTestId('message-rule-toggle'))
    expect((await screen.findByTestId('message-rules-echo')).textContent).toContain(
      '刚被 林二 改过',
    )
  })

  it('点「改」：原话带回顶上的输入框，再说一次带着这条规则的版本号', async () => {
    rules = {
      rules: [
        rule({ id: 'a', name: '结算通知', revision: 3, origin_text: 'Shopify 结算通知别烦我' }),
      ],
    }
    const user = userEvent.setup()
    renderWithProviders(<MessageRulesPanel />)
    const item = await screen.findByTestId('message-rule-item')
    await user.click(within(item).getByTestId('message-rule-edit'))
    const input = screen.getByTestId('message-rule-input') as HTMLTextAreaElement
    expect(input.value).toBe('Shopify 结算通知别烦我')
    await user.type(input, '，也告诉我')
    await user.click(screen.getByTestId('message-rule-propose'))
    await waitFor(() => {
      expect(api.propose).toHaveBeenCalledWith({
        text: 'Shopify 结算通知别烦我，也告诉我',
        rule_id: 'a',
        revision: 3,
      })
    })
  })
})

describe('WP441 卡片流里的「要建这条规则吗」', () => {
  it('同一个样子；「建」在卡身里', async () => {
    const base = draftCard()
    const card: DeckCard = draftCard({
      id: 'ap_rule_1',
      kind: 'policy_change',
      layout: 'policy',
      available_actions: ['approve', 'instruct', 'snooze', 'open'],
      detail: {
        ...base.detail,
        payload: {
          form: 'message_rule',
          draft: proposal.draft,
          plain: proposal.plain,
          trial: proposal.trial,
          options: [
            { id: 'after', label: '建' },
            { id: 'after_past', label: '建，也处理过去 30 天的' },
            { id: 'before', label: '不要' },
          ],
        },
      },
    })
    const user = userEvent.setup()
    renderWithProviders(
      <DeckCardView
        card={card}
        mode="zh_summary"
        onDecide={() => undefined}
        onOpen={() => undefined}
      />,
    )
    const body = await screen.findByTestId('deck-rule-proposal')
    expect(body.textContent).toContain('过去 30 天会命中 14 封')
    await user.click(within(body).getByTestId('rule-proposal-build'))
    await waitFor(() => {
      expect(api.deckDecide).toHaveBeenCalledWith(
        'ap_rule_1',
        expect.objectContaining({ action: 'approve', selected_option_id: 'after' }),
        card.position_id,
      )
    })
  })
})

describe('WP441 类型胶囊：为什么这样处理', () => {
  it('写按哪条规则；「这封不该归它」加排除；「在对话里改」带进助理对话', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <KindChip
        messageId="m9"
        kind="billing_system"
        confidence={1}
        by="rule"
        ruleHits={[
          { rule_id: 'a', by: 'static', name: '结算通知' },
          { rule_id: 'b', by: 'ai', confidence: 0.8, name: '推销' },
        ]}
        ruleRoute="a"
        about={{ from: 'Shopify', subject: 'Payout sent' }}
      />,
    )
    await user.click(screen.getByTestId('kind-chip'))
    expect(screen.getByTestId('kind-popover-head').textContent).toContain(
      '按规则「结算通知」处理 · 另有 1 条也命中',
    )
    await user.click(screen.getByTestId('kind-rule-exclude'))
    await waitFor(() => {
      expect(api.exclude).toHaveBeenCalledWith('m9', 'a')
    })
    await user.click(screen.getByTestId('kind-chip'))
    await user.click(screen.getByTestId('kind-rule-chat'))
    expect(takePendingAsk()?.text).toContain(
      '改一下消息规则「结算通知」：Shopify 的「Payout sent」',
    )
  })
})

describe('WP441 今天的简报面板', () => {
  it('地址有面板认领；按规则分组；全部知道了', async () => {
    ensureBuiltinPanels()
    expect(resolvePanel({ address: MESSAGE_DIGEST_ADDRESS })?.id).toBe('message-digest')
    digest = {
      time: '09:00',
      total: 2,
      groups: [
        {
          rule_id: 'v',
          rule_name: '供应商',
          entries: [
            {
              message_id: 'm1',
              thread_id: 't1',
              rule_ids: ['v'],
              rule_names: ['供应商'],
              subject: 'Quote',
              from: 'Acme',
              summary: '报了新价',
              at: T0,
            },
            {
              message_id: 'm2',
              thread_id: 't2',
              rule_ids: ['v'],
              rule_names: ['供应商'],
              subject: 'Invoice',
              from: 'Bolt',
              summary: '发来发票',
              at: T0,
            },
          ],
        },
      ],
    }
    const user = userEvent.setup()
    renderWithProviders(<MessageDigestPanel />)
    expect((await screen.findByTestId('message-digest-total')).textContent).toContain('2 封')
    expect(screen.getAllByTestId('message-digest-entry')).toHaveLength(2)
    expect(screen.getByTestId('message-digest-group').textContent).toContain('供应商')
    await user.click(screen.getByTestId('message-digest-ack'))
    await waitFor(() => {
      expect(api.ack).toHaveBeenCalled()
    })
  })
})
