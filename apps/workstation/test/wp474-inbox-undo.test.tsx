/**
 * WP474（决策 1514）：一张一张里「刚才…撤回」补齐——
 * - 「不要」的能撤回（放回待定）；
 * - 「通过」的在批准后取消窗口里能撤（按钮带剩几秒）；过了窗口 / 已经发了就不出「撤回」；
 * - 撤不回（服务端 409）底下说一句，按钮收起。
 */
import type { InboxView } from '@agentsws/deck'
import { inboxCounts } from '@agentsws/deck'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetInboxOpen } from '@/components/inbox/inbox-model'
import type { ApprovalUndoData, Me } from '@/lib/api'
import { renderWithProviders } from './helpers'
import { inboxItems, inboxView } from './inbox-fixtures'

const state = vi.hoisted(() => ({
  view: undefined as InboxView | undefined,
  states: new Map<string, string>(),
  undo: new Map<string, ApprovalUndoData | undefined>(),
  refuse: false,
}))
const undoApproval = vi.fn(async (_id: string, _asg?: string) => ({}))

const setItems = (ids: (id: string) => boolean): void => {
  const items = inboxItems().filter((i) => ids(i.id))
  state.view = { ...inboxView(items), counts: inboxCounts(items) }
}
const gone = new Set<string>()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getInbox: async () => state.view,
    decide: async (id: string, body: { action: string }) => {
      state.states.set(id, body.action === 'approve' ? 'approved' : 'rejected')
      gone.add(`card:${id}`)
      setItems((x) => !gone.has(x))
      return {}
    },
    getApprovalUndo: async (id: string) => {
      const undo = state.undo.get(id)
      return {
        id,
        state: state.states.get(id) ?? 'pending',
        ...(undo === undefined ? {} : { undo }),
      }
    },
    undoApproval: async (id: string, asg?: string) => {
      await undoApproval(id, asg)
      if (state.refuse)
        throw new actual.ApiClientError(409, {
          code: 'conflict',
          message: '撤不回来了：已经发出去了，或者过了撤回的时间',
          details: { reason: 'UNDO_CLOSED' },
        })
      gone.delete(`card:${id}`)
      state.states.set(id, 'pending')
      setItems((x) => !gone.has(x))
      return { item: { id, state: 'pending' }, undone: 'unapprove' }
    },
    ensureSession: async () =>
      ({
        person: { id: 'per_1', email: 'w@example.com', name: '王岚' },
        workspace: { id: 'ws_1', name: 'NordVolt Gear' },
        assignments: [{ id: 'asg_1', role_id: 'dtc.support', ranges: [] }],
      }) as unknown as Me,
  }
})

const { InboxPage } = await import('@/pages/inbox')

beforeEach(() => {
  gone.clear()
  setItems(() => true)
  state.states.clear()
  state.undo.clear()
  state.refuse = false
  resetInboxOpen()
  undoApproval.mockClear()
})

const current = (): string | null => screen.getByTestId('inbox-focus-card').getAttribute('data-id')

describe('一张一张：撤回「通过」「不要」（WP474）', () => {
  it('「通过」在取消窗口里能撤：按钮带秒数，点了卡回来、停在这一张', async () => {
    state.undo.set('ap_reply', {
      kind: 'unapprove',
      until: new Date(Date.now() + 120_000).toISOString(),
    })
    renderWithProviders(<InboxPage />, '/inbox?mode=focus')
    const focus = await screen.findByTestId('inbox-focus')
    expect(current()).toBe('card:ap_reply')
    fireEvent.keyDown(focus, { key: 'a' })
    const undo = await screen.findByTestId('inbox-focus-undo')
    expect(screen.getByTestId('inbox-focus-recent').textContent).toContain(
      '通过了「回信 · Tom Becker」',
    )
    expect(undo.getAttribute('data-undo')).toBe('unapprove')
    expect(undo.textContent).toMatch(/撤回 · \d+ 秒/)
    fireEvent.click(undo)
    await waitFor(() => {
      expect(undoApproval).toHaveBeenCalledWith('ap_reply', 'asg_1')
    })
    await waitFor(() => {
      expect(current()).toBe('card:ap_reply')
    })
    expect((await screen.findByTestId('inbox-notice')).textContent).toContain('放回来了')
  })

  it('「不要」的能撤回（没有秒数）', async () => {
    state.undo.set('ap_reply', { kind: 'reopen' })
    renderWithProviders(<InboxPage />, '/inbox?mode=focus')
    const focus = await screen.findByTestId('inbox-focus')
    fireEvent.keyDown(focus, { key: 'd' })
    const undo = await screen.findByTestId('inbox-focus-undo')
    expect(screen.getByTestId('inbox-focus-recent').textContent).toContain('不要了「')
    expect(undo.textContent).toBe('撤回')
    fireEvent.click(undo)
    await waitFor(() => {
      expect(undoApproval).toHaveBeenCalledWith('ap_reply', 'asg_1')
    })
  })

  it('过了窗口 / 已经发了：只写「通过了」，不出撤回', async () => {
    renderWithProviders(<InboxPage />, '/inbox?mode=focus')
    const focus = await screen.findByTestId('inbox-focus')
    fireEvent.keyDown(focus, { key: 'a' })
    await waitFor(() => {
      expect(screen.getByTestId('inbox-focus-recent').textContent).toContain('通过了「')
    })
    expect(screen.queryByTestId('inbox-focus-undo')).toBeNull()
  })

  it('点了撤回但服务端说撤不回：底下说一句，按钮收起', async () => {
    state.undo.set('ap_reply', {
      kind: 'unapprove',
      until: new Date(Date.now() + 5_000).toISOString(),
    })
    state.refuse = true
    renderWithProviders(<InboxPage />, '/inbox?mode=focus')
    const focus = await screen.findByTestId('inbox-focus')
    fireEvent.keyDown(focus, { key: 'a' })
    fireEvent.click(await screen.findByTestId('inbox-focus-undo'))
    expect((await screen.findByTestId('inbox-notice')).getAttribute('data-tone')).toBe('warn')
    await waitFor(() => {
      expect(screen.queryByTestId('inbox-focus-undo')).toBeNull()
    })
  })
})
