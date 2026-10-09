/**
 * WP284（决策 275）：「以后都这样」那张卡与职责规矩里那几句。
 *
 * - 卡：标题就是那一句，不出改之前 / 改之后双格、不出「谁能批」；两个按钮「记进规矩 / 不用」，
 *   键盘 → / ← 跟着按钮走；那一句只说一遍；
 * - 规矩：一句一行 + 「谁定的 · 来自哪张卡」；能改的人有「改」「删」（删之前问一句）；
 *   改不了的没有按钮；没有时职责规矩卡说「还没有」，右栏不出这一块。
 */
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { RoleRules } from '@/components/org/role-rules'
import { noticeKeys } from '@/components/peers/handoff-strip'
import type { RoleRuleData } from '@/lib/api'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const T0 = '2026-10-09T02:00:00.000Z'
const RULE = '退款超过 50 美元先问我，别直接答应'

const state: { rules: RoleRuleData[]; calls: string[] } = { rules: [], calls: [] }

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listRoleRules: async () => state.rules,
    updateRoleRule: async (role_id: string, id: string, text: string) => {
      state.calls.push(`put ${role_id} ${id} ${text}`)
      const row = state.rules.find((r) => r.id === id) as RoleRuleData
      Object.assign(row, { text, updated_by: 'per_he', updated_by_name: '何佳' })
      return row
    },
    deleteRoleRule: async (role_id: string, id: string) => {
      state.calls.push(`delete ${role_id} ${id}`)
      state.rules = state.rules.filter((r) => r.id !== id)
      return { removed: true }
    },
  }
})

beforeEach(() => {
  state.rules = [
    {
      id: 'rr_1',
      role_id: 'dtc.support',
      text: RULE,
      by: 'per_wang',
      by_name: '王岚',
      source_card_id: 'apr_rule',
      source_title: '回复 Anna 的退款',
      matter_id: 'mat_1',
      created_at: T0,
      can_edit: true,
    },
  ]
  state.calls = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

function ruleCard(rule = RULE): DeckCard {
  const options = [
    { id: 'after', label: '记进规矩' },
    { id: 'before', label: '不用' },
  ]
  const base = draftCard()
  return draftCard({
    id: 'ap_rule',
    kind: 'policy_change',
    layout: 'policy',
    title: `以后都这样：${rule.length > 40 ? `${rule.slice(0, 40)}…` : rule}`,
    summary: '之后每次都照做；在职责规矩里能改、能删。',
    content_variants: { zh_summary: '之后每次都照做；在职责规矩里能改、能删。' },
    options,
    detail: {
      ...base.detail,
      payload: {
        form: 'instruction_rule',
        target: 'workspace_policy',
        before: null,
        after: { rule },
        source_card_id: 'ap_src',
        options,
      },
      proposer: { kind: 'person', id: 'per_wang' },
    },
  })
}

describe('WP284 「以后都这样」那张卡', () => {
  it('标题就是那一句、没有双格；「记进规矩 / 不用」两个按钮；点了带 after', () => {
    const onDecide = vi.fn()
    renderWithProviders(
      <DeckCardView card={ruleCard()} mode="zh_summary" onDecide={onDecide} onOpen={() => {}} />,
    )
    expect(screen.getByTestId('deck-layout-rule')).toBeDefined()
    expect(screen.queryByTestId('deck-before-after')).toBeNull()
    expect(screen.queryByTestId('deck-rule-text')).toBeNull()
    const card = screen.getByTestId('deck-card')
    // 那一句只说一遍；不出「只有 owner 能批」、不出「选一个」单选
    expect((card.textContent ?? '').split(RULE).length - 1).toBe(1)
    expect(card.textContent).not.toContain('owner')
    expect(card.textContent).not.toContain('按提议改')
    fireEvent.click(screen.getByText('记进规矩'))
    expect(onDecide).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'approve', selected_option_id: 'after' }),
    )
  })

  it('太长被标题截了：正文放整句；键盘提示跟着按钮', () => {
    const long = `${RULE}，${'并且先查订单再回'.repeat(4)}`
    renderWithProviders(
      <DeckCardView
        card={ruleCard(long)}
        mode="zh_summary"
        onDecide={() => {}}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByTestId('deck-rule-text').textContent).toBe(long)
    expect(noticeKeys(ruleCard())).toEqual({
      right: { id: 'after', label: '记进规矩' },
      left: { id: 'before', label: '不用' },
    })
  })
})

describe('WP284 职责规矩里那几句', () => {
  it('一句一行 + 谁定的 · 来自哪张卡（点得过去）；改了留改的人', async () => {
    renderWithProviders(<RoleRules roleId="dtc.support" />)
    const row = await screen.findByTestId('role-rule')
    expect(screen.getByTestId('role-rule-text').textContent).toBe(RULE)
    expect(screen.getByTestId('role-rule-meta').textContent).toBe(
      '王岚 定的 · 来自「回复 Anna 的退款」',
    )
    expect(screen.getByTestId('role-rule-source').getAttribute('href')).toBe('/matters/mat_1')
    fireEvent.click(screen.getByTestId('role-rule-edit'))
    fireEvent.change(screen.getByTestId('role-rule-editor'), {
      target: { value: '退款一律先问我' },
    })
    fireEvent.click(screen.getByTestId('role-rule-save'))
    await waitFor(() => {
      expect(state.calls).toEqual(['put dtc.support rr_1 退款一律先问我'])
    })
    await waitFor(() => {
      expect(screen.getByTestId('role-rule-meta').textContent).toContain('何佳 改的')
    })
    expect(row).toBeDefined()
  })

  it('删之前问一句：取消不删，确认才删；删完职责规矩卡说「还没有」', async () => {
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValueOnce(false)
    renderWithProviders(<RoleRules roleId="dtc.support" />)
    await screen.findByTestId('role-rule')
    fireEvent.click(screen.getByTestId('role-rule-delete'))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(state.calls).toEqual([])
    confirm.mockReturnValueOnce(true)
    fireEvent.click(screen.getByTestId('role-rule-delete'))
    await waitFor(() => {
      expect(state.calls).toEqual(['delete dtc.support rr_1'])
    })
    expect(await screen.findByTestId('role-rules-empty')).toBeDefined()
  })

  it('改不了的人（③ 不是老板 / 管理员）没有改、删；右栏没有规矩就整块不出', async () => {
    state.rules = state.rules.map((r) => ({ ...r, can_edit: false }))
    const { unmount } = renderWithProviders(<RoleRules roleId="dtc.support" />)
    await screen.findByTestId('role-rule')
    expect(screen.queryByTestId('role-rule-edit')).toBeNull()
    expect(screen.queryByTestId('role-rule-delete')).toBeNull()
    unmount()

    state.rules = []
    const { container } = renderWithProviders(<RoleRules roleId="dtc.support" hideWhenEmpty />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container.textContent).toBe('')
  })
})
