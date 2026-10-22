/**
 * WP350（决策 900）「我的助理」一次拆成多份——工作台：
 * - 方案卡按岗位分组（品牌公共 / 你的习惯 / 归属待定各一组），归属待定一直带「交给谁？」；
 * - 「改一下」才逐条可勾 / 改归属 / 改文字；「就这样」带着改动发出去，之后卡只读、下面一张汇总；「不用了」；
 * - 同一批派出去的事回来报的几句聚在一起；
 * - 输入框能附资料（回形针）、粘贴一大段字收成附件，发出去带 files。
 */
import type { AssistantNotesPayload } from '@agentsws/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import type {
  AssistantState,
  FreeChatFanout,
  FreeChatFrame,
  FreeChatMessage,
  FreeChatModels,
} from '@/lib/free-chat'
import { FreeChatPage, segmentsOf } from '@/pages/free-chat'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const T0 = '2026-10-16T08:00:00.000Z'

const MODELS: FreeChatModels = {
  choices: [{ id: 'deepseek/deepseek-flash', label: 'DeepSeek', official: false, vision: 'ok' }],
  default: 'deepseek/deepseek-flash',
  web_search: { available: true, max_searches: 5 },
  knowledge: { available: true },
}

const PLAN: FreeChatFanout = {
  batch_id: 'fan_1',
  title: '10-16 周会',
  source: { name: '10-16 周会纪要.md', kind: 'meeting' },
  status: 'proposed',
  at: T0,
  positions: [
    { position_id: 'reddit-ops', name: 'Reddit 运营', duties: [] },
    { position_id: 'customer-care', name: '客服', duties: [] },
    { position_id: 'web-ops', name: '网站运营', duties: [] },
  ],
  items: [
    {
      id: 'i1',
      kind: 'task',
      text: '回复差评帖',
      position_id: 'reddit-ops',
      position_name: 'Reddit 运营',
      quote: 'Reddit 运营：回复差评帖',
    },
    {
      id: 'i2',
      kind: 'task',
      text: '整理退货话术',
      position_id: 'customer-care',
      position_name: '客服',
    },
    {
      id: 'i3',
      kind: 'task',
      text: '更新卖点',
      position_id: 'customer-care',
      position_name: '客服',
      due: '周五前',
    },
    { id: 'i4', kind: 'task', text: '这件事谁来跟', unsure: { reason: '没看出该归哪个岗位' } },
    {
      id: 'i5',
      kind: 'note',
      text: '退货期统一 30 天',
      position_id: 'customer-care',
      position_name: '客服',
    },
    { id: 'i6', kind: 'note', text: '品牌语气偏轻松', brand: true },
    { id: 'i7', kind: 'memory', text: '周报用表格' },
    { id: 'i8', kind: 'note', text: '后台密码：[已抹掉]', secret: true },
  ],
}

const state = vi.hoisted(() => ({
  messages: [] as FreeChatMessage[],
  confirms: [] as { session: string; batch: string; body: Record<string, unknown> }[],
  calls: [] as Record<string, unknown>[],
  undos: [] as { session: string; batch: string }[],
}))

vi.mock('@/lib/free-chat', async () => {
  const actual = await vi.importActual<typeof import('@/lib/free-chat')>('@/lib/free-chat')
  return {
    ...actual,
    getFreeChatModels: async () => MODELS,
    getAssistantState: async (): Promise<AssistantState> => ({ suggestions: [], targets: [] }),
    listAssistantMemory: async () => [],
    listFreeChatSessions: async () => [],
    // WP352：只有一条长对话
    getAssistantThread: async () => ({
      session: { id: 'fchat_1', title: '助理', created_at: T0, updated_at: T0 },
      segments: [],
    }),
    listFreeChatMessages: async () => state.messages,
    createFreeChatSession: async () => ({
      id: 'fchat_1',
      title: '新对话',
      created_at: T0,
      updated_at: T0,
    }),
    confirmFanout: async (session: string, batch: string, body: Record<string, unknown>) => {
      state.confirms.push({ session, batch, body })
      const plan = state.messages.find((m) => m.fanout?.batch_id === batch) as FreeChatMessage
      const next: FreeChatMessage = {
        ...plan,
        fanout: {
          ...(plan.fanout as FreeChatFanout),
          status: body.dismiss === true ? 'dismissed' : 'sent',
        },
      }
      const summary: FreeChatMessage | undefined =
        body.dismiss === true
          ? undefined
          : {
              id: 'sum',
              session_id: session,
              role: 'assistant',
              text: '按「10-16 周会」派好了。',
              at: T0,
              fanout_summary: {
                batch_id: batch,
                title: '10-16 周会',
                groups: [
                  {
                    position_id: 'reddit-ops',
                    name: 'Reddit 运营',
                    tasks: [{ matter_id: 'm1', title: '回复差评帖' }],
                    notes: 0,
                  },
                  {
                    position_id: 'customer-care',
                    name: '客服',
                    tasks: [{ matter_id: 'm2', title: '整理退货话术' }],
                    notes: 1,
                  },
                  {
                    position_id: 'web-ops',
                    name: '网站运营',
                    tasks: [{ matter_id: 'm3', title: '更新卖点' }],
                    notes: 0,
                  },
                ],
                brand_notes: 1,
                memories: 1,
                skipped: { dropped: 0, unsure: 0, secret: 1 },
                // WP357（决策 902）：写进去就生效，不再有确认卡
                note_card_ids: ['fc_1', 'fc_2'],
                at: T0,
              },
            }
      state.messages = state.messages.map((m) => (m.id === next.id ? next : m))
      if (summary !== undefined) state.messages = [...state.messages, summary]
      return { plan: next, ...(summary === undefined ? {} : { summary }) }
    },
    undoFanoutNotes: async (session: string, batch: string) => {
      state.undos.push({ session, batch })
      const sum = state.messages.find(
        (m) => m.fanout_summary?.batch_id === batch,
      ) as FreeChatMessage
      const summary: FreeChatMessage = {
        ...sum,
        fanout_summary: {
          ...(sum.fanout_summary as NonNullable<FreeChatMessage['fanout_summary']>),
          notes_undone_at: T0,
          notes_undone: 2,
        },
      }
      state.messages = state.messages.map((m) => (m.id === summary.id ? summary : m))
      return { summary }
    },
    streamFreeChat: async (
      session_id: string,
      input: Record<string, unknown>,
      onFrame: (f: FreeChatFrame) => void,
    ) => {
      state.calls.push(input)
      const user: FreeChatMessage = {
        id: 'u2',
        session_id,
        role: 'user',
        text: String(input.text ?? ''),
        at: T0,
      }
      onFrame({ type: 'start', user, message_id: 'a2' })
      const message: FreeChatMessage = {
        id: 'a2',
        session_id,
        role: 'assistant',
        text: '好的',
        at: T0,
      }
      onFrame({
        type: 'done',
        message,
        session: { id: session_id, title: 't', created_at: T0, updated_at: T0 },
      })
    },
  }
})

function renderPage(route = '/assistant/fchat_1'): void {
  renderWithProviders(
    <Routes>
      <Route path="/assistant/:id?" element={<FreeChatPage />} />
    </Routes>,
    route,
  )
}

beforeEach(() => {
  state.confirms = []
  state.calls = []
  state.undos = []
  state.messages = [
    {
      id: 'u1',
      session_id: 'fchat_1',
      role: 'user',
      text: '分一下',
      at: T0,
      attachments: [{ name: '10-16 周会纪要.md', chars: 320 }],
    },
    {
      id: 'a1',
      session_id: 'fchat_1',
      role: 'assistant',
      text: '按岗位拆好了。',
      at: T0,
      fanout: PLAN,
    },
  ]
})

describe('WP350 方案卡', () => {
  it('按岗位分组；归属待定一直带「交给谁？」；口令那条划掉；附件显示名字与字数', async () => {
    renderPage()
    const card = await screen.findByTestId('fanout-card')
    const groups = within(card)
      .getAllByTestId('fanout-group')
      .map((g) => g.getAttribute('data-owner'))
    expect(groups).toEqual(['p:reddit-ops', 'p:customer-care', 'brand', 'mine', 'unsure', 'secret'])
    // 不点「改一下」时只有待定那条有下拉，没有勾选框
    expect(within(card).getAllByTestId('fanout-item-owner').length).toBe(1)
    expect(within(card).queryAllByTestId('fanout-item-keep')).toEqual([])
    expect(within(card).getByTestId('fanout-count').textContent).toBe('3 件事 · 2 条知识')
    expect(screen.getByTestId('free-chat-user-doc').textContent).toContain('320 字')
  })

  it('改一下：勾掉一条、改一条归属、改文字、挑待定的 → 就这样带着改动发；之后只读、出汇总', async () => {
    renderPage()
    const card = await screen.findByTestId('fanout-card')
    await userEvent.click(within(card).getByTestId('fanout-edit'))
    const rows = within(card).getAllByTestId('fanout-item')
    const row = (text: string) =>
      rows.find(
        (r) =>
          r.textContent?.includes(text) ||
          (r.querySelector('input[type=text], input:not([type])') as HTMLInputElement | null)
            ?.value === text,
      ) as HTMLElement
    await userEvent.click(within(row('回复差评帖')).getByTestId('fanout-item-keep'))
    fireEvent.change(within(row('更新卖点')).getByTestId('fanout-item-owner'), {
      target: { value: 'p:web-ops' },
    })
    const text = within(row('整理退货话术')).getByTestId('fanout-item-text')
    await userEvent.clear(text)
    await userEvent.type(text, '写一版退货话术')
    fireEvent.change(within(row('这件事谁来跟')).getByTestId('fanout-item-owner'), {
      target: { value: 'p:reddit-ops' },
    })
    await userEvent.click(within(card).getByTestId('fanout-accept'))
    await waitFor(() => expect(state.confirms.length).toBe(1))
    const items = (state.confirms[0]?.body.items ?? []) as Record<string, unknown>[]
    expect(items).toEqual(
      expect.arrayContaining([
        { id: 'i1', drop: true },
        { id: 'i3', position_id: 'web-ops' },
        { id: 'i2', text: '写一版退货话术' },
        { id: 'i4', position_id: 'reddit-ops' },
      ]),
    )
    const summary = await screen.findByTestId('fanout-summary')
    expect(within(summary).getAllByTestId('fanout-summary-group').length).toBe(3)
    // WP357（决策 902）：不再「去确认知识」，知识已生效——给「撤销」与「去知识库」
    expect(within(summary).queryByTestId('fanout-summary-confirm')).toBeNull()
    expect(summary.textContent).not.toContain('待确认')
    expect(within(summary).getByTestId('fanout-summary-knowledge').getAttribute('href')).toBe(
      '/knowledge',
    )
    // 撤销要点两下：第一下只变「确定撤销」
    const undo = within(summary).getByTestId('fanout-summary-undo')
    expect(undo.textContent).toBe('撤销这 2 条知识')
    await userEvent.click(undo)
    expect(state.undos).toEqual([])
    expect(undo.textContent).toBe('确定撤销')
    await userEvent.click(undo)
    await waitFor(() => expect(state.undos).toEqual([{ session: 'fchat_1', batch: 'fan_1' }]))
    expect((await screen.findByTestId('fanout-summary-undone')).textContent).toBe('已撤销 2 条知识')
    expect(screen.queryByTestId('fanout-summary-undo')).toBeNull()
    expect(screen.getByTestId('fanout-card').getAttribute('data-status')).toBe('sent')
    expect(screen.queryByTestId('fanout-accept')).toBeNull()
  })

  it('不用了：只发 dismiss，卡变「没派」', async () => {
    renderPage()
    await userEvent.click(await screen.findByTestId('fanout-dismiss'))
    await waitFor(() => expect(state.confirms[0]?.body).toEqual({ dismiss: true }))
    await waitFor(() =>
      expect(screen.getByTestId('fanout-card').getAttribute('data-status')).toBe('dismissed'),
    )
    expect(screen.queryByTestId('fanout-summary')).toBeNull()
  })
})

describe('WP350 回报按批次聚在一起', () => {
  const report = (id: string, batch?: string): FreeChatMessage => ({
    id,
    session_id: 's',
    role: 'assistant',
    text: `**客服** 做完了：${id}`,
    at: T0,
    report: {
      matter_id: `m_${id}`,
      kind: 'done',
      position_name: '客服',
      ...(batch === undefined ? {} : { batch_id: batch, batch_title: '10-16 周会' }),
    },
  })

  it('连着的同一批收成一段，别的一条一段', () => {
    const segs = segmentsOf([
      report('a', 'fan_1'),
      report('b', 'fan_1'),
      report('c'),
      report('d', 'fan_1'),
    ])
    expect(segs.map((s) => [s.batch?.id ?? '-', s.rows.length])).toEqual([
      ['fan_1', 2],
      ['-', 1],
      ['fan_1', 1],
    ])
  })

  it('页面上那一段标「来自「…」」', async () => {
    state.messages = [report('a', 'fan_1'), report('b', 'fan_1')]
    renderPage()
    const seg = await screen.findByTestId('assistant-report-batch')
    expect(seg.textContent).toContain('来自「10-16 周会」')
    expect(within(seg).getAllByTestId('assistant-report').length).toBe(2)
  })
})

describe('WP350 输入框附资料', () => {
  it('回形针选一份 .md、粘贴一大段字 → 两个小签；发出去带 files', async () => {
    state.messages = []
    renderPage('/assistant')
    const input = (await screen.findByTestId('free-chat-doc-input')) as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File(['# 周会\n- 客服：回信'], '周会.md', { type: 'text/markdown' })] },
    })
    await waitFor(() => expect(screen.getAllByTestId('matter-doc').length).toBe(1))
    const area = screen.getByTestId('free-chat-input')
    fireEvent.paste(area, {
      clipboardData: { files: [], getData: () => '会议记录'.repeat(500) },
    })
    await waitFor(() => expect(screen.getAllByTestId('matter-doc').length).toBe(2))
    expect(screen.getAllByTestId('matter-doc')[1]?.textContent).toContain('粘贴的文字 2.txt')
    await userEvent.click(screen.getByTestId('matter-send'))
    await waitFor(() => expect(state.calls.length).toBe(1))
    const files = state.calls[0]?.files as { name: string; data: string }[]
    expect(files.map((f) => f.name)).toEqual(['周会.md', '粘贴的文字 2.txt'])
    expect(Buffer.from(files[0]?.data ?? '', 'base64').toString('utf8')).toContain('客服')
  })
})

describe('WP350「要记的 N 条」确认卡', () => {
  it('按岗位列正文与原文出处，不出改之前 / 改之后双格', () => {
    const payload: AssistantNotesPayload = {
      form: 'assistant_notes',
      batch_id: 'fan_1',
      source: '10-16 周会',
      card_ids: ['fc_1', 'fc_2'],
      groups: [
        {
          name: '客服',
          notes: [{ text: '退货期统一 30 天', quote: '客服记住：退货期统一 30 天' }],
        },
        { name: '品牌公共', notes: [{ text: '品牌语气偏轻松' }] },
      ],
      before: null,
      after: '客服 1 条 · 品牌公共 1 条',
    }
    const base = draftCard()
    renderWithProviders(
      <DeckCardView
        card={draftCard({
          id: 'ap_notes',
          kind: 'knowledge_update',
          layout: 'change',
          title: '「10-16 周会」里要记的 2 条',
          detail: { ...base.detail, payload },
        })}
        mode="zh_summary"
        onDecide={() => {}}
        onOpen={() => {}}
      />,
    )
    const groups = screen.getAllByTestId('assistant-notes-group')
    expect(groups.map((g) => g.textContent)).toEqual([
      '客服退货期统一 30 天“客服记住：退货期统一 30 天”',
      '品牌公共品牌语气偏轻松',
    ])
    expect(screen.queryByTestId('deck-before-after')).toBeNull()
  })
})
