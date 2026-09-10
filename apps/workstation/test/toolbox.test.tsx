/**
 * 工具箱 Tab（WP37 交付 6）。
 *
 * 四组断言：
 * 1. 每条列出谁建的、哪些岗位在用、上次跑、跑了几次、在哪一层；
 * 2. 疑似重复成对高亮，"合并"是提交审批而不是立刻改；
 * 3. 搜索框打的是 `/v1/catalog?q=`（与 ⌘K 同源）；
 * 4. 建之前先查：查到像的 → 出选择题卡，"仍新建"没写够字按钮按不动，
 *    写够了才带着理由再发一次（40 §2.2 第 2 条 / §5 E4）。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolboxTab } from '@/components/org/toolbox-tab'
import { ApiClientError, type CatalogDuplicateView, type CatalogEntryView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const entry = (over: Partial<CatalogEntryView> & { id: string; title: string }): CatalogEntryView =>
  ({
    kind: 'schedule',
    summary: '',
    owner: 'p_li',
    layer: 'personal',
    used_by_positions: [],
    runs_30d: 0,
    ...over,
  }) as CatalogEntryView

const A = entry({
  id: 'schedule:s1',
  title: '每天早上汇总退款单',
  summary: '到点交给「report」做一次',
  owner: '李默',
  used_by_positions: ['asg_ops', 'asg_cs'],
  runs_30d: 28,
  last_run_at: '2026-09-09T01:00:00.000Z',
})
const B = entry({
  id: 'schedule:s2',
  title: '早上汇总退款单',
  owner: '王工',
  used_by_positions: ['asg_ops'],
  runs_30d: 4,
  reason_for_duplicate: '我这条只看退货窗口内的单',
})
const SKILL = entry({
  id: 'skill:aftersales',
  kind: 'skill',
  title: '售后客服',
  layer: 'company',
  owner: 'package',
})

const DUPE: CatalogDuplicateView = {
  a: A,
  b: B,
  similarity: 0.83,
  both_in_use: true,
  reasons: ['说的像是同一件事（词重合 83%）'],
}

const state = {
  entries: [A, B, SKILL] as CatalogEntryView[],
  duplicates: [DUPE] as CatalogDuplicateView[],
  queries: [] as (string | undefined)[],
  merges: [] as { keep: string; drop: string }[],
  creates: [] as { title: string; ack?: { reason: string; similar_to: string[] } }[],
  /** 下一次 createSchedule 要不要回 409 */
  blockNext: true,
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listCatalog: async (filter: { q?: string }) => {
      state.queries.push(filter.q)
      const q = filter.q?.trim() ?? ''
      return q === '' ? state.entries : state.entries.filter((e) => e.title.includes(q))
    },
    listCatalogDuplicates: async () => state.duplicates,
    mergeCatalogEntries: async (input: { keep: string; drop: string }) => {
      state.merges.push(input)
      return { approval_item_id: 'apr_merge_1' }
    },
    createSchedule: async (input: {
      title: string
      duplicate_ack?: { reason: string; similar_to: string[] }
    }) => {
      state.creates.push({
        title: input.title,
        ...(input.duplicate_ack === undefined ? {} : { ack: input.duplicate_ack }),
      })
      if (input.duplicate_ack === undefined && state.blockNext) {
        throw new ApiClientError(409, {
          code: 'similar_exists',
          message: '已有「每天早上汇总退款单」',
          details: {
            kind: 'schedule',
            candidates: [
              { entry: A, similarity: 0.9, keys: ['semantic'], reasons: ['说的像是同一件事'] },
            ],
            options: [
              { id: 'reuse', label: '复用它' },
              { id: 'merge', label: '合并进它' },
              { id: 'new', label: '我这个不一样，仍新建', requires_reason: true },
            ],
          },
        })
      }
      return { id: 'sch_new' }
    },
  }
})

beforeEach(() => {
  state.entries = [A, B, SKILL]
  state.duplicates = [DUPE]
  state.queries = []
  state.merges = []
  state.creates = []
  state.blockNext = true
})

describe('40 §2.2 第 1 条：工具箱看得见', () => {
  it('每条列出谁建的、几个岗位在用、上次跑、跑了几次、在哪一层', async () => {
    renderWithProviders(<ToolboxTab assignment="asg_owner" />)
    await screen.findByText('每天早上汇总退款单')
    expect(screen.getByText(/李默 建的/)).toBeTruthy()
    expect(screen.getByText(/2 个岗位在用/)).toBeTruthy()
    expect(screen.getByText(/累计跑了 28 次/)).toBeTruthy()
    expect(screen.getAllByText('个人').length).toBeGreaterThan(0)
    expect(screen.getByText('公司')).toBeTruthy()
    // 当初"仍新建"写的那句理由，下一个人看得到——WP43 ③ 之后它在问号 tooltip 上
    expect(
      screen
        .getAllByRole('button')
        .some((b) => (b.getAttribute('data-hint') ?? '').includes('我这条只看退货窗口内的单')),
    ).toBe(true)
  })

  it('按 kind 分组，点分组按钮只留那一类', async () => {
    const user = userEvent.setup()
    const { container } = renderWithProviders(<ToolboxTab assignment="asg_owner" />)
    await screen.findByText('每天早上汇总退款单')
    expect(container.querySelectorAll('[data-testid="toolbox-entry"]')).toHaveLength(3)
    await user.click(screen.getByTestId('toolbox-kind-skill'))
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="toolbox-entry"]')).toHaveLength(1)
    })
  })

  it('搜索框打的是 /v1/catalog?q=（与 ⌘K 同源）', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ToolboxTab assignment="asg_owner" />)
    await screen.findByText('每天早上汇总退款单')
    await user.type(screen.getByTestId('toolbox-search'), '退款')
    await waitFor(() => {
      expect(state.queries.at(-1)).toBe('退款')
    })
  })

  it('⌘K 跳过来时带的搜索词直接生效', async () => {
    renderWithProviders(<ToolboxTab assignment="asg_owner" initialQuery="售后" />)
    await waitFor(() => {
      expect(state.queries[0]).toBe('售后')
    })
  })
})

describe('40 §2.2 第 4 条：疑似重复与一键合并', () => {
  it('成对列出并高亮；合并是提交审批，不是立刻改', async () => {
    const user = userEvent.setup()
    const { container } = renderWithProviders(<ToolboxTab assignment="asg_owner" />)
    await screen.findByTestId('toolbox-duplicates')
    expect(screen.getByText(/像 83%/)).toBeTruthy()
    // 两条都打了角标
    expect(
      container.querySelectorAll('[data-testid="toolbox-entry"].border-amber-400\\/60'),
    ).toHaveLength(2)
    await user.click(screen.getByTestId('toolbox-merge'))
    await waitFor(() => {
      expect(state.merges).toEqual([{ keep: 'schedule:s1', drop: 'schedule:s2' }])
    })
    expect(await screen.findByText('已提交审批，批了才合')).toBeTruthy()
  })
})

describe('40 §2.2 第 2 条：建之前先查', () => {
  it('查到像的 → 出选择题卡，不直接建', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ToolboxTab assignment="asg_owner" />)
    await screen.findByTestId('toolbox-new')
    await user.click(screen.getByTestId('toolbox-new'))
    await user.type(screen.getByTestId('toolbox-new-title'), '早上把退款单汇总一下')
    await user.click(screen.getByTestId('toolbox-new-save'))
    const card = await screen.findByTestId('similar-choice')
    expect(card.textContent).toContain('已经有人做过像的了')
    expect(card.textContent).toContain('每天早上汇总退款单')
    // 服务端没建成，界面上三个选项都在
    expect(screen.getByTestId('similar-reuse')).toBeTruthy()
    expect(screen.getByTestId('similar-merge')).toBeTruthy()
    expect(screen.getByTestId('similar-new')).toBeTruthy()
  })

  it('"仍新建"写够了字才让按，按下去带着理由再发一次', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ToolboxTab assignment="asg_owner" />)
    await screen.findByTestId('toolbox-new')
    await user.click(screen.getByTestId('toolbox-new'))
    await user.type(screen.getByTestId('toolbox-new-title'), '早上把退款单汇总一下')
    await user.click(screen.getByTestId('toolbox-new-save'))
    await screen.findByTestId('similar-choice')
    await user.click(screen.getByTestId('similar-new'))

    const confirm = screen.getByTestId('similar-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    await user.type(screen.getByTestId('similar-reason'), '短')
    expect((screen.getByTestId('similar-confirm') as HTMLButtonElement).disabled).toBe(true)
    await user.clear(screen.getByTestId('similar-reason'))
    await user.type(screen.getByTestId('similar-reason'), '我这条只看退货窗口内的单，口径不一样')
    await user.click(screen.getByTestId('similar-confirm'))

    await waitFor(() => {
      expect(state.creates).toHaveLength(2)
    })
    expect(state.creates[1]?.ack?.reason).toBe('我这条只看退货窗口内的单，口径不一样')
    expect(state.creates[1]?.ack?.similar_to).toEqual(['schedule:s1'])
  })

  it('"复用它" 什么都不建，只把那条搜出来', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ToolboxTab assignment="asg_owner" />)
    await screen.findByTestId('toolbox-new')
    await user.click(screen.getByTestId('toolbox-new'))
    await user.type(screen.getByTestId('toolbox-new-title'), '早上把退款单汇总一下')
    await user.click(screen.getByTestId('toolbox-new-save'))
    await screen.findByTestId('similar-choice')
    await user.click(screen.getByTestId('similar-reuse'))
    await waitFor(() => {
      expect(state.queries.at(-1)).toBe('每天早上汇总退款单')
    })
    expect(state.creates).toHaveLength(1)
  })

  it('查不到像的就直接建', async () => {
    state.blockNext = false
    const user = userEvent.setup()
    renderWithProviders(<ToolboxTab assignment="asg_owner" />)
    await screen.findByTestId('toolbox-new')
    await user.click(screen.getByTestId('toolbox-new'))
    await user.type(screen.getByTestId('toolbox-new-title'), '没人做过的事')
    await user.click(screen.getByTestId('toolbox-new-save'))
    await waitFor(() => {
      expect(screen.queryByTestId('similar-choice')).toBeNull()
    })
    expect(state.creates).toEqual([{ title: '没人做过的事' }])
  })
})
