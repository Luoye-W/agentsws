/**
 * WP84（53 §3 / 54 §1 第 6 行）+ WP98（09-18 收口）：职责模板的快捷提示与示例任务。
 *
 * int/1024：WP438 首页重排（决策 1332）后首页岗位卡不再挂 `···` 快捷提示（快捷按钮在岗位页底部对话框上面），
 * 那一组用例随首页一起去掉，下面只剩指导抽屉的示例任务。以下是原说明：
 *
 * WP98 把快捷提示从首页第一屏**折进岗位卡右上角的 `···`**（数据与路由一个字没改），
 * 所以这一组用例钉的是新结构：
 * - 菜单收起时首页上一条快捷提示都没有（第一屏还给岗位卡）；
 * - 点开 `···` 才出，按**职责**分组，本人那条职责的全部都在（不再折一半）；
 * - 点一条 = 走 54 §2 的**岗位任务入口**，事项 `entry: 'position'` 且带那条职责
 *   （不是往一个聊天框里塞一句话——36 §3 首页仍然没有自由输入框）；
 * - 只用**本人**那条分配：别人在做的职责连按钮都不出（借岗位扩权的口子堵死）；
 * - 指导抽屉顶部出示例任务，点一条把说法填进指导框（选择题优先，不是第二个输入口）。
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { OpenAtPositionData, PositionInstanceData } from '@/lib/api'
import { draftCard, homeData } from './fixtures'
import { renderWithProviders } from './helpers'

const SUPPORT_PROMPTS = [
  {
    id: 'draft_return_reply',
    label: { zh: '起草退货回复', en: 'Draft a return reply' },
    prompt: '把这封退货来信按退货政策起草一封回复',
    kind: 'start_task' as const,
  },
  {
    id: 'where_is_order',
    label: { zh: '查这单到哪了', en: 'Where is this order' },
    prompt: '客户问包裹到哪了：查订单和物流轨迹',
    kind: 'start_task' as const,
  },
  {
    id: 'unanswered_mail',
    label: { zh: '超时没回的来信', en: 'Mail nobody answered' },
    prompt: '超过 8 小时还没回的客户来信有哪些',
    kind: 'ask' as const,
  },
  {
    id: 'refund_check',
    label: { zh: '退款算一算', en: 'Work out the refund' },
    prompt: '这一单要退款：按退货政策算能退多少',
    kind: 'review' as const,
  },
]

const SUPPORT_EXAMPLES = [
  {
    id: 'return_request',
    title: { zh: '一封退货来信', en: 'A return request' },
    description: '客户来信说尺码不合适想退货，东西还没寄回来。',
    expected_output: '一封写好的回信草稿，附上这单在不在退货期内的判断依据。',
  },
  {
    id: 'damaged_parcel',
    title: { zh: '破损或漏发', en: 'Damaged or missing item' },
    description: '客户说收到时盒子压坏了、还少了一件配件。',
    expected_output: '一张补发或退款的待批卡，带订单与签收记录。',
  },
]

const INSTANCE: PositionInstanceData = {
  position_id: 'customer-care',
  workspace_id: 'ws_1',
  name: { zh: '客服', en: 'Customer Care' },
  template_version: '1.0.0',
  holders: ['p_li'],
  roles: [
    {
      role_id: 'dtc.support',
      role_name: '网站客服',
      default: true,
      assignment_ids: ['asg_1'],
      my_assignment_id: 'asg_1',
      quick_prompts: SUPPORT_PROMPTS,
      task_examples: SUPPORT_EXAMPLES,
    },
    {
      role_id: 'dtc.live-chat',
      role_name: '网站在线客服',
      default: true,
      // 这条是**别人**在做的：没有 my_assignment_id
      assignment_ids: ['asg_someone_else'],
      quick_prompts: [
        {
          id: 'waiting_now',
          label: { zh: '现在等着回的', en: 'Chats waiting right now' },
          prompt: '聊天窗里现在还等着回复的对话有哪些',
          kind: 'ask' as const,
        },
      ],
    },
  ],
  open_matters: 2,
  pending_cards: 3,
  memory_summary: '',
}

/**
 * 只有一个岗位的人首页会直接跳到那个岗位页（54 §4），所以这里给两个——
 * 第二个没写快捷提示，顺带钉住"没写的职责一切照旧，卡上只是不出按钮"。
 */
const SECOND: PositionInstanceData = {
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
  memory_summary: '',
}

const OPENED: OpenAtPositionData = {
  matter: {
    id: 'mat_9',
    title: '把这封退货来信按退货政策起草一封回复',
    entry: 'position',
    role_id: 'dtc.support',
  },
  picked: { role_id: 'dtc.support', role_name: '网站客服', assignment_id: 'asg_1' },
  candidates: [],
  ambiguous: false,
  reason: '按「网站客服」这条职责的快捷提示开的，没走岗位内路由',
  run_id: 'run_9',
}

const home = homeData()
const getHome = vi.fn(async () => home)
const getPositions = vi.fn(async () => ({
  positions: [],
  instances: [INSTANCE, SECOND],
  tile_library: [],
  max_tiles: 4,
}))
const openMatterAtPosition = vi.fn(async () => OPENED)
const navigate = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getHome: (...a: unknown[]) => getHome(...(a as [])),
    getPositions: (...a: unknown[]) => getPositions(...(a as [])),
    openMatterAtPosition: (...a: unknown[]) => openMatterAtPosition(...(a as [])),
    decide: async () => ({}),
  }
})

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigate }
})

const { DeckCardView } = await import('@/components/deck/deck-card')

describe('指导抽屉顶部的示例任务（WP84）', () => {
  it('点开指导才出；点一条把说法填进指导框，不直接提交', async () => {
    const user = userEvent.setup()
    const onDecide = vi.fn()
    renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={onDecide} onOpen={() => {}} />,
    )
    // 37 §1 第 7 行：点开之前折叠区根本不在 DOM 里，示例任务也一样
    expect(screen.queryByTestId('task-examples')).toBeNull()

    await user.click(screen.getByRole('button', { name: '修改' }))
    const examples = await screen.findByTestId('task-examples')
    expect(examples).toBeDefined()
    expect(screen.getAllByTestId('task-example')).toHaveLength(2)

    await user.click(screen.getByText('一封退货来信'))
    const box = screen.getByLabelText('一句话说清楚要怎么改') as HTMLTextAreaElement
    expect(box.value).toBe('客户来信说尺码不合适想退货，东西还没寄回来。')
    // 填进去 ≠ 发出去：还要人自己点一下
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('WP141：已经写了指导再点示例，接在后面，不把写好的整段换掉', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <DeckCardView card={draftCard()} mode="zh_summary" onDecide={vi.fn()} onOpen={() => {}} />,
    )
    await user.click(screen.getByRole('button', { name: '修改' }))
    const box = screen.getByLabelText('一句话说清楚要怎么改') as HTMLTextAreaElement
    await user.type(box, '先道歉')
    await user.click(await screen.findByText('一封退货来信'))
    expect(box.value).toBe('先道歉\n客户来信说尺码不合适想退货，东西还没寄回来。')
  })
})
