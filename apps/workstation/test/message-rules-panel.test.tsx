/**
 * WP439（docs/108 §5.1.5 / §5.7 ②）：消息页右栏「规则」。
 *
 * 钉住的是：
 * - 地址 `agentsws://message-rules` 有面板认领（「共 N 条 →」、右上那颗、铃铛都开它）；
 * - 你教过的发件人一行一个：发件人、类型、交给谁、30 天命中几次；空组不画；
 * - 删一条 → 打出去的是删除，回声「已删，下一封会重新判」带「撤回」，点撤回打出去的是 restore；
 * - 同事 / 公司模式：写谁教的；「刚删的」那一组能撤回；AI 自己学的单独一组。
 */
import type { SenderRuleList } from '@agentsws/contracts'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MESSAGE_RULES_ADDRESS } from '@/components/messages/rules-address'
import { ensureBuiltinPanels } from '@/components/rail/builtin-panels'
import { MessageRulesPanel } from '@/components/rail/panels/message-rules-panel'
import { resolvePanel } from '@/components/rail/registry'
import { renderWithProviders } from './helpers'

const T0 = '2026-10-21T01:00:00.000Z'

let list: SenderRuleList = { rules: [] }
const deleteMessageSenderRule = vi.fn(async (id: string) => ({ deleted: true, rule: { id } }))
const restoreMessageSenderRule = vi.fn(async (_id: string) => ({ restored: true }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listMessageSenderRules: async () => list,
    deleteMessageSenderRule: (id: string) => deleteMessageSenderRule(id),
    restoreMessageSenderRule: (id: string) => restoreMessageSenderRule(id),
    getMessageOverview: async () => ({
      unclaimed: 0,
      notice: 0,
      handed: 0,
      handed_by_position: [],
      cards_waiting: 0,
      notice_groups: [],
      positions: [
        { id: 'customer-care', name_zh: '客服', name_en: 'Customer care', open: true },
        { id: 'kol-marketing', name_zh: '红人营销', name_en: 'Creators', open: true },
      ],
      taught: { rules: 3, saved: 0, recent: [] },
    }),
  }
})

const base = { labels: [], by: 'p_me', created_at: T0 }

describe('WP439 规则面板', () => {
  beforeEach(() => {
    deleteMessageSenderRule.mockClear()
    restoreMessageSenderRule.mockClear()
  })

  it('地址有面板认领', () => {
    ensureBuiltinPanels()
    expect(resolvePanel({ address: MESSAGE_RULES_ADDRESS })?.id).toBe('message-rules')
  })

  it('个人模式：三行、命中数、交给谁；空组不画；删了回声带撤回', async () => {
    list = {
      shared: false,
      rules: [
        {
          ...base,
          id: 'r1',
          sender: '@shipfast.example',
          kind: 'logistics',
          route: 'inbox',
          hits_30d: 12,
          by_me: true,
        },
        {
          ...base,
          id: 'r2',
          sender: 'mia@creator.example',
          kind: 'creator_reply',
          position: 'kol-marketing',
          hits_30d: 3,
          by_me: true,
        },
        {
          ...base,
          id: 'r3',
          sender: 'ann@buyer.example',
          route: 'support',
          hits_30d: 0,
          by_me: true,
        },
      ],
      recently_deleted: [],
    }
    renderWithProviders(<MessageRulesPanel />)
    const rows = await screen.findAllByTestId('message-rule-row')
    expect(rows).toHaveLength(3)
    // 只有「你教过的发件人」一组（其余三组空着不画）
    expect(
      screen.getAllByTestId('message-rules-group').map((g) => g.getAttribute('data-group')),
    ).toEqual(['sender'])
    const shipfast = rows[0] as HTMLElement
    expect(shipfast.textContent).toContain('@shipfast.example')
    expect(within(shipfast).getByTestId('message-rule-kind').textContent).toContain('物流')
    expect(within(shipfast).getByTestId('message-rule-to').textContent).toContain('留在收件箱')
    expect(within(shipfast).getByTestId('message-rule-hits').textContent).toContain('30 天 12 次')
    await waitFor(() => {
      expect(within(rows[1] as HTMLElement).getByTestId('message-rule-to').textContent).toContain(
        '→ 红人营销',
      )
    })
    // 老规则只教过路由：按路由找到岗位
    expect(within(rows[2] as HTMLElement).getByTestId('message-rule-to').textContent).toContain(
      '→ 客服',
    )
    expect(within(rows[2] as HTMLElement).getByTestId('message-rule-hits').textContent).toContain(
      '30 天没碰到',
    )
    // 个人模式不写「谁教的」
    expect(screen.queryByTestId('message-rule-by')).toBeNull()

    const user = userEvent.setup()
    await user.click(within(rows[0] as HTMLElement).getByTestId('message-rule-delete'))
    expect(deleteMessageSenderRule).toHaveBeenCalledWith('r1')
    const echo = await screen.findByTestId('message-rules-echo')
    expect(echo.textContent).toContain('已删，下一封会重新判')
    await user.click(within(echo).getByTestId('message-rules-undo'))
    expect(restoreMessageSenderRule).toHaveBeenCalledWith('r1')
    await waitFor(() => {
      expect(screen.getByTestId('message-rules-echo').textContent).toContain('已撤回')
    })
  })

  it('同事 / 公司模式：写谁教的；AI 自己学的单独一组；刚删的能撤回', async () => {
    list = {
      shared: true,
      rules: [
        {
          ...base,
          id: 'r1',
          sender: '@shipfast.example',
          kind: 'logistics',
          hits_30d: 2,
          by_me: true,
        },
        {
          ...base,
          id: 'r2',
          sender: 'bob@vendor.example',
          kind: 'billing_system',
          hits_30d: 1,
          by: 'p_lin',
          by_name: '林二',
        },
        {
          ...base,
          id: 'r3',
          sender: 'news@weekly.example',
          kind: 'marketing',
          hits_30d: 5,
          source: 'ai',
        },
      ],
      recently_deleted: [
        {
          rule: { ...base, id: 'r9', sender: 'old@x.example' },
          deleted_by: 'p_lin',
          deleted_by_name: '林二',
          deleted_at: T0,
        },
      ],
    }
    renderWithProviders(<MessageRulesPanel />)
    await screen.findAllByTestId('message-rule-row')
    expect(
      screen.getAllByTestId('message-rules-group').map((g) => g.getAttribute('data-group')),
    ).toEqual(['sender', 'ai', 'deleted'])
    expect(screen.getAllByTestId('message-rule-by').map((e) => e.textContent)).toEqual([
      '你教的',
      '林二 教的',
    ])
    const gone = screen.getByTestId('message-rule-deleted')
    expect(gone.textContent).toContain('old@x.example')
    expect(gone.textContent).toContain('林二 删的')
    await userEvent.setup().click(within(gone).getByTestId('message-rule-restore'))
    expect(restoreMessageSenderRule).toHaveBeenCalledWith('r9')
  })

  it('一条都没有：一句空态', async () => {
    list = { rules: [] }
    renderWithProviders(<MessageRulesPanel />)
    expect(await screen.findByTestId('message-rules-empty')).toBeTruthy()
  })
})
