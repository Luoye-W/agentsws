/**
 * WP459（决策 1497–1505）：收件箱页。
 *
 * 钉住的是：
 * - 一条队列：要紧 / 今天 / 不急三组（1500 甲）；每行类型标签、药丸、行尾一颗次按钮 + ⋯；「AI 猜的 · 改」；
 * - 行尾「通过」走岗位卡片流同一条决定（同一张卡），批完那一行没了；信的「交给 B2B」走 confirm-route；
 * - 筛选：全部 / 等我批 / 只看信（带件数）+ 岗位下拉（带件数，最后一行「还没归岗位的信」）（1501 甲）；
 * - 第三栏：回信卡原信 + 草稿；「改」先直接改字、按钮变「改好了，通过」、带着改过的那一版批；
 *   「或者跟 AI 说怎么改」走「改一下」（1502 甲）；别的卡就是岗位里那张卡；
 * - 改判「AI 猜的」：列出交给了谁，展开一封改给别的岗位，「以后都交给 X」默认不勾（1504）；
 * - 一张一张（1505 丁）：第 N 张 / M、A 通过、D 不要、→ 跳过（跳过的能撤回）；
 * - 清空之后的样子；左栏「收件箱」件数徽标。
 */
import type { InboxView } from '@agentsws/deck'
import { inboxCounts } from '@agentsws/deck'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetInboxOpen } from '@/components/inbox/inbox-model'
import type { Me } from '@/lib/api'
import { renderWithProviders } from './helpers'
import { inboxItems, inboxView } from './inbox-fixtures'

const state = vi.hoisted(() => ({ view: undefined as InboxView | undefined }))
const decide = vi.fn(async (_id: string, _body: unknown, _asg: string) => ({}))
const handMessageToPosition = vi.fn(async (_id: string, position: string, _r: boolean) => ({
  message: {},
  handed_off: true,
  position_id: position,
}))
const rehandMessage = vi.fn(async (_id: string, _input: unknown) => ({
  message: {},
  withdrawn: 1,
  handed_off: true,
  position_id: 'pr',
}))
const claimMessage = vi.fn(async (_id: string, _as: string) => ({ message: {} }))

/** 批了 / 交出去之后再取：那一件不在了（同一张卡、同一个账本）。 */
const drop = (id: string): void => {
  const v = state.view
  if (v === undefined) return
  const items = v.items.filter((i) => i.id !== id)
  state.view = { ...v, items, counts: inboxCounts(items) }
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getInbox: async () => state.view,
    decide: async (id: string, body: unknown, asg: string) => {
      const out = await decide(id, body, asg)
      drop(`card:${id}`)
      return out
    },
    handMessageToPosition: async (id: string, p: string, r: boolean) => {
      const out = await handMessageToPosition(id, p, r)
      drop('mail:<t_sam@x>')
      return out
    },
    rehandMessage: (id: string, input: unknown) => rehandMessage(id, input),
    claimMessage: (id: string, as: string) => claimMessage(id, as),
    getMessageOverview: async () => ({
      unclaimed: 2,
      notice: 17,
      handed: 5,
      handed_by_position: [],
      cards_waiting: 3,
      notice_groups: [{ kind: 'logistics', count: 6, senders: ['Bright Logistics'] }],
      positions: [
        { id: 'customer-care', name_zh: '客服', name_en: 'Care', open: true, route: 'support' },
        { id: 'pr', name_zh: '公共关系', name_en: 'PR', open: true },
        { id: 'b2b', name_zh: 'B2B', name_en: 'B2B', open: true, route: 'b2b' },
      ],
      taught: { rules: 12, saved: 3, recent: [] },
    }),
    listMessageFollowUps: async () => ({
      rows: [
        {
          thread_id: '<f1@x>',
          subject: '年货节联名报价',
          account: 'hello@nordvolt.example',
          last_message_id: 'm_f1',
          follow_up: {
            due_at: '2026-10-20T01:00:00.000Z',
            nudges: 0,
            state: 'waiting',
            since: '2026-10-16T01:00:00.000Z',
            waiting_on: { email: 'mia@partner.example', name: 'Mia Chen' },
          },
        },
      ],
    }),
    getMessageThread: async () => ({ thread_id: '<t_sam@x>', subject: 'x', messages: [] }),
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
  state.view = inboxView()
  resetInboxOpen()
  decide.mockClear()
  handMessageToPosition.mockClear()
  rehandMessage.mockClear()
  claimMessage.mockClear()
})

const rows = (): HTMLElement[] => screen.queryAllByTestId('inbox-row')
const row = (id: string): HTMLElement => {
  const hit = rows().find((r) => r.getAttribute('data-id') === id)
  if (hit === undefined) throw new Error(`没有 ${id}`)
  return hit
}

describe('收件箱：一条队列（WP459）', () => {
  it('要紧 / 今天 / 不急三组；类型标签、药丸、「AI 猜的 · 改」；简报和右栏两堆', async () => {
    renderWithProviders(<InboxPage />, '/inbox')
    await screen.findAllByTestId('inbox-row')
    expect(screen.getAllByTestId('inbox-group').map((g) => g.getAttribute('data-urgency'))).toEqual(
      ['urgent', 'today', 'later'],
    )
    expect(rows()).toHaveLength(6)
    expect(within(row('mail:<t_shop@x>')).getByTestId('inbox-row-tag').textContent).toBe('只能你定')
    expect(within(row('mail:<t_sam@x>')).getByTestId('inbox-row-tag').textContent).toBe(
      '归谁拿不准',
    )
    expect(within(row('card:ap_reply')).getByTestId('inbox-row-pill').textContent).toContain('等了')
    expect(within(row('card:ap_jordan')).getByTestId('inbox-row-guess').textContent).toBe(
      'AI 猜的 · 改',
    )
    // 行尾一颗次按钮：通过 / 交给 B2B / 我自己处理 / 打开
    expect(within(row('mail:<t_sam@x>')).getByTestId('inbox-row-primary').textContent).toBe(
      '交给B2B',
    )
    expect(within(row('mail:<t_shop@x>')).getByTestId('inbox-row-primary').textContent).toBe(
      '我自己处理',
    )
    expect(
      within(row('card:ap_choice')).getByTestId('inbox-row-primary').getAttribute('data-act'),
    ).toBe('open')
    expect(screen.getByTestId('inbox-brief-text').textContent).toContain('AI 替你办完 31 件')
    expect(screen.getByTestId('inbox-brief-text').textContent).toContain('最急：回信 · Tom Becker')
    await screen.findByTestId('inbox-waiting-row')
    expect(screen.getByTestId('inbox-waiting').textContent).toContain('Mia Chen')
    expect((await screen.findByTestId('inbox-kept')).textContent).toContain('17')
  })

  it('行尾「通过」= 岗位卡片流同一条决定；批完那一行没了', async () => {
    renderWithProviders(<InboxPage />, '/inbox')
    await screen.findAllByTestId('inbox-row')
    fireEvent.click(within(row('card:ap_price')).getByTestId('inbox-row-primary'))
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith('ap_price', { action: 'approve', version: 1 }, 'asg_2')
    })
    await waitFor(() => {
      expect(rows().some((r) => r.getAttribute('data-id') === 'card:ap_price')).toBe(false)
    })
  })

  it('信的「交给 B2B」走交给岗位那一条（不勾记住）；⋯ 里「不要」是卡的拒绝', async () => {
    renderWithProviders(<InboxPage />, '/inbox')
    await screen.findAllByTestId('inbox-row')
    fireEvent.click(within(row('mail:<t_sam@x>')).getByTestId('inbox-row-primary'))
    await waitFor(() => {
      expect(handMessageToPosition).toHaveBeenCalledWith('msg_sam', 'b2b', false)
    })
    fireEvent.click(within(row('card:ap_jordan')).getByTestId('inbox-row-more'))
    fireEvent.click(await screen.findByTestId('inbox-menu-reject'))
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith('ap_jordan', { action: 'reject', version: 1 }, 'asg_1')
    })
  })
})

describe('收件箱：筛选（决策 1501）', () => {
  it('等我批 / 只看信；岗位下拉带件数，筛了出「去客服岗位 →」；最后一行「还没归岗位的信」', async () => {
    renderWithProviders(<InboxPage />, '/inbox')
    await screen.findAllByTestId('inbox-row')
    expect(screen.getByTestId('inbox-filter-card').textContent).toContain('4')
    fireEvent.click(screen.getByTestId('inbox-filter-card'))
    await waitFor(() => {
      expect(rows().every((r) => r.getAttribute('data-type') === 'card')).toBe(true)
    })
    fireEvent.click(screen.getByTestId('inbox-filter-mail'))
    await waitFor(() => {
      expect(rows()).toHaveLength(2)
    })
    fireEvent.click(screen.getByTestId('inbox-filter-all'))
    fireEvent.click(screen.getByTestId('inbox-filter-position'))
    const care = await screen.findByTestId('inbox-position-customer-care')
    expect(care.textContent).toContain('2')
    fireEvent.click(care)
    await waitFor(() => {
      expect(rows().map((r) => r.getAttribute('data-id'))).toEqual([
        'card:ap_reply',
        'card:ap_jordan',
      ])
    })
    expect(screen.getByTestId('inbox-go-position').getAttribute('href')).toBe('/positions/asg_1')
    fireEvent.click(screen.getByTestId('inbox-filter-position'))
    fireEvent.click(await screen.findByTestId('inbox-position-none'))
    await waitFor(() => {
      expect(rows().every((r) => r.getAttribute('data-type') === 'mail')).toBe(true)
    })
  })

  it('筛选跟着地址走（首页岗位卡「等你 N 件」点过来就是筛好的）', async () => {
    renderWithProviders(<InboxPage />, '/inbox?position=web-ops')
    await screen.findAllByTestId('inbox-row')
    expect(rows().map((r) => r.getAttribute('data-id'))).toEqual([
      'card:ap_price',
      'card:ap_choice',
    ])
  })
})

describe('收件箱：第三栏（决策 1502）', () => {
  it('回信卡：原信 + 草稿；「改」先直接改字，按钮变「改好了，通过」，带着改过的那一版批', async () => {
    renderWithProviders(<InboxPage />, '/inbox')
    await screen.findAllByTestId('inbox-row')
    fireEvent.click(row('card:ap_reply'))
    const pane = await screen.findByTestId('inbox-pane-inline')
    expect(within(pane).getByTestId('inbox-draft-original').textContent).toContain('3-port charger')
    expect(within(pane).getByTestId('inbox-draft-view').textContent).toContain('order number')
    expect(row('card:ap_reply').getAttribute('data-selected')).toBe('true')
    fireEvent.click(within(pane).getByTestId('inbox-draft-edit'))
    const box = within(pane).getByTestId('inbox-draft-text')
    fireEvent.change(box, { target: { value: 'Hi Tom, really sorry. Send me your order number?' } })
    expect(within(pane).getByTestId('inbox-draft-approve').textContent).toBe('改好了，通过')
    expect(within(pane).getByTestId('inbox-draft-note').textContent).toContain('客服')
    fireEvent.click(within(pane).getByTestId('inbox-draft-approve'))
    await waitFor(() => {
      expect(decide).toHaveBeenCalledTimes(1)
    })
    const body = decide.mock.calls[0]?.[1] as {
      action: string
      edited_payload: { body: { text: string; subject: string } }
    }
    expect(body.action).toBe('approve')
    expect(body.edited_payload.body).toEqual({
      subject: 'Re: order',
      text: 'Hi Tom, really sorry. Send me your order number?',
    })
    // 批完：第三栏收起、那一行没了
    await waitFor(() => {
      expect(screen.queryByTestId('inbox-pane-inline')).toBeNull()
    })
  })

  it('「或者跟 AI 说怎么改」：常用说法一点就是「改一下」', async () => {
    renderWithProviders(<InboxPage />, '/inbox')
    await screen.findAllByTestId('inbox-row')
    fireEvent.click(within(row('card:ap_reply')).getByTestId('inbox-row-more'))
    fireEvent.click(await screen.findByTestId('inbox-menu-edit'))
    const pane = await screen.findByTestId('inbox-pane-inline')
    fireEvent.click(within(pane).getByTestId('inbox-draft-chip-shorter'))
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith(
        'ap_reply',
        { action: 'instruct', version: 1, instruction: { scope: 'single_reply', text: '更短' } },
        'asg_1',
      )
    })
  })

  it('别的卡（改价）：就是岗位里那张卡', async () => {
    renderWithProviders(<InboxPage />, '/inbox')
    await screen.findAllByTestId('inbox-row')
    fireEvent.click(row('card:ap_price'))
    const pane = await screen.findByTestId('inbox-pane-inline')
    expect(within(pane).getByTestId('inbox-card')).toBeDefined()
    expect(within(pane).getByTestId('deck-card')).toBeDefined()
  })

  it('改判「AI 猜的」：列出交给了谁；改给公共关系，「以后都交给」默认不勾', async () => {
    renderWithProviders(<InboxPage />, '/inbox')
    await screen.findAllByTestId('inbox-row')
    fireEvent.click(within(row('card:ap_jordan')).getByTestId('inbox-row-guess'))
    const pane = await screen.findByTestId('inbox-pane-inline')
    const g = within(pane).getByTestId('inbox-guess-row')
    expect(g.textContent).toContain('Jordan Wells')
    expect(g.textContent).toContain('72%')
    const rehand = await within(pane).findByTestId('inbox-rehand')
    await waitFor(() => {
      expect(within(rehand).getByTestId('inbox-rehand-pr').getAttribute('data-on')).toBe('true')
    })
    expect((within(rehand).getByTestId('inbox-rehand-remember') as HTMLInputElement).checked).toBe(
      false,
    )
    expect(rehand.textContent).toContain('客服没批的卡会撤掉')
    fireEvent.click(within(rehand).getByTestId('inbox-rehand-submit'))
    await waitFor(() => {
      expect(rehandMessage).toHaveBeenCalledWith('msg_jordan', {
        to: 'position',
        position_id: 'pr',
      })
    })
    expect((await screen.findByTestId('inbox-notice')).textContent).toContain('撤了 1 张卡')
  })
})

describe('收件箱：一张一张（决策 1505 丁）', () => {
  it('第 N 张 / M；A 通过、→ 跳过（能撤回）、D 不要；打字时不响应', async () => {
    renderWithProviders(<InboxPage />, '/inbox?mode=focus')
    const focus = await screen.findByTestId('inbox-focus')
    expect(screen.getByTestId('inbox-focus-progress').textContent).toContain('第 1 张')
    expect(screen.getByTestId('inbox-focus-progress').textContent).toContain('/ 6')
    expect(screen.getByTestId('inbox-focus-card').getAttribute('data-id')).toBe('card:ap_reply')
    // → 跳过：第二张上来，「刚才：跳过了…」能撤回
    fireEvent.keyDown(focus, { key: 'ArrowRight' })
    expect(screen.getByTestId('inbox-focus-card').getAttribute('data-id')).toBe('mail:<t_shop@x>')
    expect(screen.getByTestId('inbox-focus-recent').textContent).toContain(
      '跳过了「回信 · Tom Becker」',
    )
    fireEvent.click(screen.getByTestId('inbox-focus-undo'))
    expect(screen.getByTestId('inbox-focus-card').getAttribute('data-id')).toBe('card:ap_reply')
    // A = 通过（这张卡上的那颗）
    fireEvent.keyDown(focus, { key: 'a' })
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith('ap_reply', { action: 'approve', version: 1 }, 'asg_1')
    })
    await waitFor(() => {
      expect(screen.getByTestId('inbox-focus-card').getAttribute('data-id')).toBe('mail:<t_shop@x>')
    })
    expect(screen.getByTestId('inbox-focus-progress').textContent).toContain('/ 5')
    // 跳到改价卡（岗位里那张卡）：D = 不要
    fireEvent.keyDown(focus, { key: 'ArrowRight' })
    expect(screen.getByTestId('inbox-focus-card').getAttribute('data-id')).toBe('card:ap_price')
    fireEvent.keyDown(focus, { key: 'd' })
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith(
        'ap_price',
        expect.objectContaining({ action: 'reject' }),
        'asg_2',
      )
    })
  })

  it('打字时（改草稿）按键不响应', async () => {
    renderWithProviders(<InboxPage />, '/inbox?mode=focus')
    await screen.findByTestId('inbox-focus')
    fireEvent.click(screen.getByTestId('inbox-draft-edit'))
    const box = screen.getByTestId('inbox-draft-text')
    fireEvent.keyDown(box, { key: 'a' })
    fireEvent.keyDown(box, { key: 'ArrowRight' })
    expect(decide).not.toHaveBeenCalled()
    expect(screen.getByTestId('inbox-focus-card').getAttribute('data-id')).toBe('card:ap_reply')
  })

  it('列表 / 一张一张是同一份数据：页头分段切换', async () => {
    renderWithProviders(<InboxPage />, '/inbox')
    await screen.findAllByTestId('inbox-row')
    fireEvent.click(screen.getByTestId('inbox-mode-focus'))
    expect(await screen.findByTestId('inbox-focus')).toBeDefined()
    fireEvent.click(screen.getByTestId('inbox-focus-all'))
    expect((await screen.findAllByTestId('inbox-row')).length).toBe(6)
  })
})

describe('收件箱：清空之后', () => {
  it('灰图标 + 「今天的都处理完了」+ 一个链接；简报收成一行', async () => {
    state.view = inboxView([])
    renderWithProviders(<InboxPage />, '/inbox')
    const empty = await screen.findByTestId('inbox-empty')
    expect(empty.textContent).toContain('今天的都处理完了')
    expect(within(empty).getByTestId('inbox-empty-link').textContent).toBe('看 AI 今天办了什么')
    expect(screen.getByTestId('inbox-brief').getAttribute('data-folded')).toBe('true')
    expect(screen.getByTestId('inbox-filter-all').textContent).toContain('0')
  })

  it('筛到一个岗位没有的：照实说这里没有', async () => {
    state.view = inboxView(inboxItems().filter((i) => i.position !== 'web-ops'))
    renderWithProviders(<InboxPage />, '/inbox?position=web-ops')
    expect((await screen.findByTestId('inbox-empty')).textContent).toContain('这里没有要你处理的')
  })
})

describe('左栏「收件箱」（决策 1499）', () => {
  it('品牌色件数；清空了不显示', async () => {
    const { AppShell } = await import('@/components/app-shell')
    const me = {
      person: { id: 'per_1', email: 'w@example.com', name: '王岚' },
      workspace: { id: 'ws_1', name: 'NordVolt Gear' },
      assignments: [],
    } as unknown as Me
    const view = renderWithProviders(
      <AppShell positions={[]} cards={[]} tileLibrary={[]} me={me} onAddTile={() => {}}>
        <div>主区</div>
      </AppShell>,
    )
    const nav = await screen.findByTestId('nav-messages')
    expect(nav.textContent).toContain('收件箱')
    expect((await within(nav).findByTestId('nav-inbox-count')).textContent).toBe('6')
    view.unmount()
    state.view = inboxView([])
    renderWithProviders(
      <AppShell positions={[]} cards={[]} tileLibrary={[]} me={me} onAddTile={() => {}}>
        <div>主区</div>
      </AppShell>,
    )
    const nav2 = await screen.findByTestId('nav-messages')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(within(nav2).queryByTestId('nav-inbox-count')).toBeNull()
  })
})
