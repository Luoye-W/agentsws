/**
 * WP71（36 §10）**职责页**：`/positions/:assignment/duties/:role_id`。
 *
 * 钉住：
 *
 * - 面包屑「岗位 › 职责」；
 * - 没有页签、没有「打开右栏」按钮——记忆 / 技能 / 知识 / 额度 / 记录在第三栏；
 * - WP412（真机 10-18 #12）：和岗位页同一个样子——页头（图标 + 名字 + 问号，右边「⋯ 这条职责能做什么」）、
 *   岗位页那个对话框（钉到这条职责）+ 快捷按钮、「要你拍板」；版本号 /「内置只读」不上屏，能力说明收进「⋯」。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiClientError,
  type OpenAtPositionData,
  type PositionInstanceData,
  type RoleDetailView,
} from '@/lib/api'
import { renderWithProviders } from './helpers'

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
  open_matters: 2,
  pending_cards: 3,
  memory_summary: '',
}

const ROLE: RoleDetailView = {
  id: 'dtc.store',
  name: '店铺管理',
  name_en: 'Store ops',
  description: '管商品、价格、库存',
  domain: 'store',
  version: '2.1.0',
  source: 'custom',
  editable: true,
  holders: 2,
  home_blocks: [],
  actions: [
    {
      id: 'price_change',
      kind: 'price_change',
      target: 'product',
      route_to: 'owner',
      review_cannot_be_disabled: false,
      caps: [{ key: 'max_pct', value: '20' }],
    },
  ],
  automation: [],
  connectors: [{ kind: 'shopify_admin', required: true }],
  scopes: [
    { domain: 'store', ops: ['read', 'stage'], range: 'assigned', max_sensitivity: 'internal' },
  ],
  skills: [{ name: 'customer-care', tier: 'package', load: 'always' }],
}

const getPosition = vi.fn(async () => INSTANCE)
const getRoleDefinition = vi.fn(async () => ROLE)
const getPositionRecords = vi.fn(async () => ({ payload: { rows: [] } }))
// 断言要看参数，所以这几个桩带上真实签名（`...(a as [])` 那种写法拿不到参数类型）
const openMatterAtPosition = vi.fn(
  async (
    _id: string,
    _input: { title: string; summary?: string; role_id?: string },
  ): Promise<OpenAtPositionData> => ({
    matter: { id: 'mat_9', title: 't', entry: 'position', role_id: 'dtc.store' },
    candidates: [],
    ambiguous: false,
    reason: '',
  }),
)
const createMatterWithRole = vi.fn(async () => ({ matter: { id: 'mat_x' } }))
const navigate = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPosition: (...a: unknown[]) => getPosition(...(a as [])),
    getRoleDefinition: (...a: unknown[]) => getRoleDefinition(...(a as [])),
    getPositionRecords: (...a: unknown[]) => getPositionRecords(...(a as [])),
    openMatterAtPosition: (...a: Parameters<typeof openMatterAtPosition>) =>
      openMatterAtPosition(...a),
    createMatterWithRole: (...a: unknown[]) => createMatterWithRole(...(a as [])),
  }
})

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => navigate,
    useParams: () => ({ assignment: 'asg_store', role_id: 'dtc.store' }),
  }
})

const { DutyPage } = await import('@/pages/duty')
const { resetQuickAnswer } = await import('@/components/position/quick-answer-store')

/** 岗位页那个对话框：写一句、点框里的发送箭头。 */
const send = (value: string): void => {
  fireEvent.change(screen.getByTestId('position-entry-input'), { target: { value } })
  fireEvent.click(screen.getByTestId('matter-send'))
}

beforeEach(() => {
  for (const m of [getPosition, getRoleDefinition, getPositionRecords, createMatterWithRole]) {
    m.mockClear()
  }
  openMatterAtPosition.mockClear()
  resetQuickAnswer()
  navigate.mockClear()
  getRoleDefinition.mockResolvedValue(ROLE)
})

describe('职责页（WP71 / 36 §10 → WP412 和岗位页同一个样子）', () => {
  it('面包屑「岗位 › 职责」；页头只有图标、名字与「⋯」（介绍在下拉第一行）——版本号、「内置只读」、几个人在做都不上屏', async () => {
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    // 名字要等两条查询回来（在那之前先显示 role_id——不留空白，也不假装知道）
    await waitFor(() => {
      expect(screen.getByTestId('duty-name').textContent).toBe('店铺管理')
    })
    // WP431：名字进了顶栏（照 Claude 一行截断），完整名字在悬停提示里
    expect(screen.getByTestId('duty-name').getAttribute('title')).toBe('店铺管理')
    expect(screen.getByTestId('duty-breadcrumb').textContent).toBe('网站运营')
    expect(screen.getByTestId('duty-breadcrumb').getAttribute('href')).toBe('/positions/asg_store')
    const header = screen.getByTestId('duty-header')
    expect(header.textContent).not.toContain('2.1.0')
    expect(header.textContent).not.toContain('内置只读')
    expect(header.textContent).not.toContain('从内置模板复制')
    expect(screen.queryByTestId('duty-source')).toBeNull()
    expect(screen.queryByTestId('duty-holders')).toBeNull()
    // WP456-T3（§3.2）：这条职责干什么不再是名字旁的问号（挤着下拉箭头）——进下拉菜单第一行
    expect(screen.queryByTestId('duty-description')).toBeNull()
    fireEvent.click(screen.getByTestId('duty-title-menu'))
    expect((await screen.findByTestId('duty-description')).textContent).toBe('管商品、价格、库存')
    // WP431：「职责设置」是顶栏右边那排里的一颗滑杆（字在读屏与悬停里）
    expect(screen.getByTestId('duty-about-link').textContent).toContain('职责设置')
    expect(screen.getByTestId('duty-about-link').getAttribute('title')).toBe('职责设置')
  })

  it('没有页签、没有「打开右栏」按钮；中间栏 = 对话框 +「要你拍板」', async () => {
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    await screen.findByTestId('duty-name')
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    const body = screen.getByTestId('duty-body')
    for (const panel of ['memory', 'skills', 'knowledge', 'caps'])
      expect(screen.queryByTestId(`duty-open-${panel}`)).toBeNull()
    expect(screen.queryByTestId('duty-records')).toBeNull()
    // WP412：旧的一行灰字输入框与「用这条职责开一件事」按钮没了，换成岗位页那个对话框
    expect(screen.queryByTestId('duty-open-text')).toBeNull()
    expect(screen.queryByTestId('duty-open-submit')).toBeNull()
    const handoff = await screen.findByTestId('position-handoff')
    expect(body.contains(handoff)).toBe(true)
    expect(handoff.getAttribute('data-role')).toBe('dtc.store')
    expect(screen.getByTestId('position-entry-input').getAttribute('aria-label')).toBe(
      '交给这条职责一件事',
    )
    // 「高级」不再折在中间栏
    expect(screen.queryByTestId('duty-advanced')).toBeNull()
  })

  it('「⋯ 这条职责能做什么」：介绍、几个人在做、四小组能力（翻成人话），「返回」回对话框', async () => {
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    const link = await screen.findByTestId('duty-about-link')
    expect(link.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(link)
    expect(screen.getByTestId('duty-page').getAttribute('data-view')).toBe('about')
    expect(screen.queryByTestId('duty-body')).toBeNull()
    expect((await screen.findByTestId('duty-line')).textContent).toBe('管商品、价格、库存')
    // WP421：「N 个人在做」不上屏
    expect(screen.queryByTestId('duty-holders')).toBeNull()
    const scope = await screen.findByTestId('duty-scope')
    // 认不出的数据域退回原名，ops 翻成人话
    expect(scope.textContent).toContain('看store · 可提议改动')
    // 动作：没有译文的拼「对象」；没写自动化档位 = 要人批
    expect(screen.getByTestId('duty-action').textContent).toContain('商品 · 要人批')
    expect(screen.getByTestId('duty-skill').textContent).toContain('技能：')
    expect(screen.getByTestId('duty-skill').textContent).toContain('（常驻）')
    expect(screen.getByTestId('duty-connector').textContent).toContain('（必需）')
    // 原始声明只在 tooltip（data-raw / data-hint）里
    expect(scope.getAttribute('data-raw')).toBe('store · read / stage · assigned · internal')
    expect(screen.getByTestId('duty-action').getAttribute('data-raw')).toBe(
      'price_change · price_change → product',
    )
    // 版本号、来源胶囊在这里也不出
    expect(screen.getByTestId('duty-about').textContent).not.toContain('2.1.0')
    fireEvent.click(screen.getByTestId('duty-about-link'))
    expect(await screen.findByTestId('duty-body')).toBeDefined()
  })

  it('WP238：社群职责的权限翻成人话，内部 id 不上屏', async () => {
    getRoleDefinition.mockResolvedValue({
      ...ROLE,
      scopes: [
        {
          domain: 'community_member',
          ops: ['read', 'stage'],
          range: 'assigned',
          max_sensitivity: 'internal',
        },
      ],
      actions: [
        {
          id: 'reply_thread',
          kind: 'outbound_message',
          target: 'community_thread',
          route_to: 'role_holder',
          review_cannot_be_disabled: false,
          caps: [],
        },
      ],
      automation: [
        { action_id: 'reply_thread', ceiling: 'L3', initial: 'L2', hard_ceiling: false },
      ],
      skills: [{ name: 'brand-voice', tier: 'open', load: 'always' }],
      connectors: [{ kind: 'reddit', required: false }],
    })
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    fireEvent.click(await screen.findByTestId('duty-about-link'))
    const body = await screen.findByTestId('duty-advanced-body')
    expect(screen.getByTestId('duty-scope').textContent).toContain('看社群成员 · 可提议改动')
    expect(screen.getByTestId('duty-action').textContent).toContain('回帖子与私信 · 额度内自己做')
    expect(screen.getByTestId('duty-skill').textContent).toContain('技能：品牌话术（常驻）')
    expect(screen.getByTestId('duty-connector').textContent).toContain('Reddit API（可选）')
    // 可见文字里没有 yml 的 id（sr-only 的 tooltip 副本除外）
    const visible = [...body.querySelectorAll('li')]
      .map((li) => li.firstElementChild?.firstChild?.textContent ?? '')
      .join(' ')
    for (const id of ['community_member', 'outbound_message', 'brand-voice', 'staged_change'])
      expect(visible).not.toContain(id)
  })

  it('WP412：对话框发出去钉到这条职责（岗位入口 + role_id，服务端照样三分），判成会话 / 任务就进线程', async () => {
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    await screen.findByTestId('position-entry-input')
    send('把 GB-12 降价 10%')
    await waitFor(() => {
      expect(openMatterAtPosition).toHaveBeenCalledTimes(1)
    })
    expect(openMatterAtPosition.mock.calls[0]?.[0]).toBe('asg_store')
    expect(openMatterAtPosition.mock.calls[0]?.[1]).toMatchObject({
      title: '把 GB-12 降价 10%',
      role_id: 'dtc.store',
    })
    // 旧那条「只建任务」的路不再走
    expect(createMatterWithRole).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/matters/mat_9')
    })
  })

  it('WP259：一大段也照收——拆成「第一句…」+ 完整原文', async () => {
    const text = `把 GB-12 降价 10%。${'同时把同系列的另外几款也按竞品价对一下，'.repeat(6)}改完给我看。`
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    await screen.findByTestId('position-entry-input')
    send(text)
    await waitFor(() => {
      expect(openMatterAtPosition.mock.calls[0]?.[1]).toMatchObject({
        title: '把 GB-12 降价 10%…',
        summary: text,
        role_id: 'dtc.store',
      })
    })
  })

  it('WP259：没交出去就在框下说一句人话（含服务端那句），字放回框里', async () => {
    openMatterAtPosition.mockRejectedValueOnce(
      new ApiClientError(403, { code: 'forbidden', message: '你名下没有这条职责，开不了' }),
    )
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    await screen.findByTestId('position-entry-input')
    send('把 GB-12 降价')
    await waitFor(() => {
      expect(screen.getByTestId('position-handoff').textContent).toContain(
        '没交出去：你名下没有这条职责，开不了',
      )
    })
    expect((screen.getByTestId('position-entry-input') as HTMLTextAreaElement).value).toBe(
      '把 GB-12 降价',
    )
    expect(navigate).not.toHaveBeenCalled()
  })

  it('WP412：快捷按钮只取这条职责的提示，点了直接发（钉到这条职责）', async () => {
    getPosition.mockResolvedValueOnce({
      ...INSTANCE,
      roles: [
        {
          ...(INSTANCE.roles[0] as PositionInstanceData['roles'][number]),
          quick_prompts: [
            {
              id: 'q1',
              label: { zh: '看今天的价格', en: 'Prices' },
              prompt: '看价格',
              kind: 'ask',
            },
          ],
        },
        {
          role_id: 'dtc.content',
          role_name: '内容',
          default: false,
          assignment_ids: ['asg_content'],
          my_assignment_id: 'asg_content',
          quick_prompts: [
            { id: 'q2', label: { zh: '写一篇博客', en: 'Blog' }, prompt: '写博客', kind: 'ask' },
          ],
        },
      ],
    })
    renderWithProviders(<DutyPage />, '/positions/asg_store/duties/dtc.store', 'asg_store')
    const mine = await screen.findByText('看今天的价格')
    expect(screen.queryByText('写一篇博客')).toBeNull()
    fireEvent.click(mine)
    await waitFor(() => {
      expect(openMatterAtPosition.mock.calls[0]?.[1]).toMatchObject({
        title: '看价格',
        role_id: 'dtc.store',
      })
    })
  })
})
