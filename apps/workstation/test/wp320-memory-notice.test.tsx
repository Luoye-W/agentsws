/**
 * WP320 工作台：「记住了：……」小提醒 + 点了跳到那条记忆并高亮 + 记忆面板的来源 / 删 + 「自动记忆」开关。
 *
 * 钉住的几条：
 * - 一批一句：一条是「记住了：…」，好几条合成「记住了 N 件事」；打开工作台时已有的不弹；
 * - 人在输入框里打字时先压着，停手了再出；
 * - 点它 → 去那一层的页面（`?memory=<id>`）并开第三栏「记忆」，那一条高亮；
 * - AI 记的那条写着「AI 记的」、带回到那件事的链接，删 / 改照常；
 * - 「自动记忆」开关走 `PUT /v1/settings/auto-memory`。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayerMemoryData, MemoryChangeData, PositionInstanceData } from '@/lib/api'
import { AppProvider } from '@/lib/app-context'
import { openSettingsTab } from './helpers'

const INSTANCE: PositionInstanceData = {
  position_id: 'web-ops',
  workspace_id: 'ws_1',
  name: { zh: '网站运营', en: 'Web Operations' },
  template_version: '1.1.0',
  holders: ['p_li'],
  roles: [
    {
      role_id: 'dtc.store',
      role_name: '店铺管理',
      default: true,
      assignment_ids: ['asg_store'],
      my_assignment_id: 'asg_store',
    },
  ],
  open_matters: 0,
  pending_cards: 0,
  memory_summary: '岗位层：1 段',
}

const AI_ID = 'm:position:web-ops:customer-care:sec_ai'

const change = (id: string, text: string, kind: MemoryChangeData['kind'] = 'added') =>
  ({
    id,
    at: `2026-10-14T01:00:0${id.slice(-1)}.000Z`,
    kind,
    entry_id: id === 'c2' ? AI_ID : `m:position:web-ops:customer-care:${id}`,
    tier: 'position',
    scope_id: 'web-ops',
    text,
    by: 'p_li',
    written_by: 'ai',
    run_id: 'run_1',
  }) as MemoryChangeData

const MEMORY: LayerMemoryData = {
  tier: 'position',
  scope_id: 'web-ops',
  summary: '岗位层：1 段',
  can_edit: true,
  entries: [
    {
      id: AI_ID,
      skill: 'customer-care',
      section_id: 'sec_ai',
      heading: '回复美国客户',
      body: '回复美国客户一律用英文',
      origin: 'authored',
      source: 'manual',
      added_by: 'p_li',
      added_at: '2026-10-14T01:00:00.000Z',
      written_by: 'ai',
      run_id: 'run_1',
      matter_id: 'mat_9',
    },
  ],
}

let batches: MemoryChangeData[][] = []
const getMemoryChanges = vi.fn(async () => batches.shift() ?? [])
const getLayerMemory = vi.fn(async () => MEMORY)
const deleteMemoryEntry = vi.fn(async (id: string) => ({ id, deleted: true }))
const getAutoMemory = vi.fn(async () => ({ enabled: true }))
const setAutoMemory = vi.fn(async (enabled: boolean) => ({ enabled }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getMemoryChanges: () => getMemoryChanges(),
    getLayerMemory: () => getLayerMemory(),
    deleteMemoryEntry: (id: string) => deleteMemoryEntry(id),
    getAutoMemory: () => getAutoMemory(),
    setAutoMemory: (v: boolean) => setAutoMemory(v),
    getPosition: async () => INSTANCE,
    getSkills: async () => [],
    listKnowledgeCards: async () => [],
  }
})

const { MemoryNotice, memoryNoticePath, memoryNoticeText } = await import(
  '@/components/work/memory-notice'
)
const { isTypingNow } = await import('@/components/design')
const { RightRail } = await import('@/components/rail/right-rail')
const { RailStateProvider } = await import('@/components/rail/rail-state')
const { AutoMemorySetting } = await import('@/components/settings/auto-memory-setting')
const { translate } = await import('@/lib/i18n')

const t = (k: string, v?: Record<string, string | number>) => translate('zh', k, v)

function Where(): ReactNode {
  const loc = useLocation()
  return <p data-testid="where">{`${loc.pathname}${loc.search}`}</p>
}

function mount(ui: ReactNode, route = '/'): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={client}>
      <AppProvider initialTheme="light" initialLang="zh" initialPosition="asg_store">
        <MemoryRouter initialEntries={[route]}>
          <RailStateProvider>
            {ui}
            <Where />
          </RailStateProvider>
        </MemoryRouter>
      </AppProvider>
    </QueryClientProvider>,
  )
  return client
}

const poll = async (client: QueryClient): Promise<void> => {
  await act(async () => {
    await client.refetchQueries({ queryKey: ['memory-changes'] })
  })
}

/** 第一次拿到的那批（打开之前的事）真的落进了组件，再往下走。 */
const firstLoad = async (client: QueryClient): Promise<void> => {
  await waitFor(() => {
    expect(client.getQueryData(['memory-changes'])).toBeDefined()
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  batches = []
  for (const m of [getMemoryChanges, getLayerMemory, deleteMemoryEntry, setAutoMemory])
    m.mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('WP320 纯函数', () => {
  it('一条说内容，好几条合成一句；并进去的说「更新了」', () => {
    expect(memoryNoticeText([change('c1', '退货先查物流')], t)).toBe('记住了：退货先查物流')
    expect(memoryNoticeText([change('c1', 'a'), change('c2', 'b'), change('c3', 'c')], t)).toBe(
      '记住了 3 件事',
    )
    expect(memoryNoticeText([change('c1', '报价用美元', 'merged')], t)).toBe(
      '记忆更新了：报价用美元',
    )
  })

  it('点了去哪：岗位层 → 岗位页，职责层 → 职责页，品牌层 → 当前岗位页', () => {
    expect(memoryNoticePath([change('c2', 'x')], [INSTANCE], 'asg_store')).toBe(
      `/positions/asg_store?memory=${encodeURIComponent(AI_ID)}`,
    )
    const role = { ...change('c1', 'x'), tier: 'role' as const, scope_id: 'dtc.store' }
    expect(memoryNoticePath([role], [INSTANCE], null)).toMatch(
      /^\/positions\/asg_store\/duties\/dtc\.store\?memory=/,
    )
    const brand = { ...change('c1', 'x'), tier: 'company' as const, scope_id: 'ws_1' }
    expect(memoryNoticePath([brand], [INSTANCE], 'asg_store')).toMatch(/^\/positions\/asg_store\?/)
  })

  it('打字判定：焦点在输入框、两秒内按过键才算', () => {
    const area = document.createElement('textarea')
    const button = document.createElement('button')
    expect(isTypingNow(area, 1000, 2000)).toBe(true)
    expect(isTypingNow(area, 1000, 4000)).toBe(false)
    expect(isTypingNow(button, 1000, 1500)).toBe(false)
    expect(isTypingNow(area, undefined, 1500)).toBe(false)
  })
})

describe('WP320 小提醒', () => {
  it('打开时已有的不弹；新来两条合成「记住了 2 件事」；点了跳到岗位页并高亮那一条', async () => {
    batches = [
      [change('c0', '旧的')],
      [change('c1', '退货先查物流'), change('c2', '回复美国客户一律用英文')],
    ]
    const client = mount(
      <>
        <MemoryNotice instances={[INSTANCE]} />
        <RightRail instances={[INSTANCE]} />
      </>,
    )
    await firstLoad(client)
    expect(screen.queryByTestId('memory-notice')).toBeNull()
    await poll(client)
    expect((await screen.findByTestId('memory-notice-open')).textContent).toBe('记住了 2 件事')
    fireEvent.click(screen.getByTestId('memory-notice-open'))
    expect(screen.getByTestId('where').textContent).toContain('/positions/asg_store?memory=')
    expect(screen.queryByTestId('memory-notice')).toBeNull()
    const entry = await screen.findByTestId('memory-entry')
    expect(entry.getAttribute('data-highlight')).toBe('true')
    expect(entry.getAttribute('data-written-by')).toBe('ai')
  })

  it('人在打字时先压着，停手了再出', async () => {
    batches = [[], [change('c1', '退货先查物流')]]
    const client = mount(
      <>
        <textarea data-testid="composer" />
        <MemoryNotice instances={[INSTANCE]} />
      </>,
    )
    await firstLoad(client)
    const composer = screen.getByTestId('composer')
    composer.focus()
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    fireEvent.keyDown(composer, { key: 'a' })
    await poll(client)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(screen.queryByTestId('memory-notice')).toBeNull()
    now += 3000
    expect(
      (await screen.findByTestId('memory-notice-open', {}, { timeout: 3000 })).textContent,
    ).toBe('记住了：退货先查物流')
  })
})

describe('WP320 记忆面板与开关', () => {
  it('AI 记的那条：写着「AI 记的」、能回到那件事、能删', async () => {
    mount(<RightRail instances={[INSTANCE]} />, '/positions/asg_store')
    await openSettingsTab('memory')
    expect((await screen.findByTestId('memory-origin')).textContent).toBe('AI 记的')
    expect(screen.getByTestId('memory-source-link').getAttribute('href')).toBe('/matters/mat_9')
    fireEvent.click(screen.getByTestId('memory-delete'))
    await waitFor(() => {
      expect(deleteMemoryEntry).toHaveBeenCalledWith(AI_ID)
    })
  })

  it('「自动记忆」开关：关掉走 PUT', async () => {
    mount(<AutoMemorySetting />)
    const sw = await screen.findByTestId('settings-auto-memory-switch')
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    await waitFor(() => {
      expect(setAutoMemory).toHaveBeenCalledWith(false)
    })
  })
})
