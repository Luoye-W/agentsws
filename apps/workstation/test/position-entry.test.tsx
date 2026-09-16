/**
 * WP69（54）工作台那一侧：**岗位是任务主入口**。
 *
 * 钉住 54 §4 的四条认知成本硬规矩，外加 §2 的两个入口：
 * - 岗位页顶部只有一句话的入口；职责是第二层，**默认折叠**；
 * - 判准了直接进事项页；拿不准就把候选摆出来，界面不替人选；
 * - 「用这条职责开」走的是那条职责的分配（职责入口，跳过路由）；
 * - 事项页上那一行「路由到 X · 换」，换到的是**这个岗位下**的职责。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenAtPositionData, PositionInstanceData } from '@/lib/api'
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
      assignment_ids: ['asg_store', 'asg_store_someone_else'],
      my_assignment_id: 'asg_store',
    },
    {
      role_id: 'dtc.content',
      role_name: '内容与博客',
      default: true,
      // 这条职责别人也在做——界面上的入口只能用**本人**那一条（借岗位扩权的口子堵死）
      assignment_ids: ['asg_content_someone_else', 'asg_content'],
      my_assignment_id: 'asg_content',
    },
  ],
  open_matters: 2,
  pending_cards: 3,
  memory_summary: '岗位层：2 段',
}

const PICKED: OpenAtPositionData = {
  matter: { id: 'mat_1', title: '把 A 商品降价 10%', entry: 'position', role_id: 'dtc.store' },
  picked: { role_id: 'dtc.store', role_name: '店铺管理', assignment_id: 'asg_store' },
  candidates: [{ role_id: 'dtc.store', role_name: '店铺管理', score: 0.4, why: ['商品'] }],
  ambiguous: false,
  reason: '路由到「店铺管理」，因为你说了「商品」',
  run_id: 'run_1',
}

const AMBIGUOUS: OpenAtPositionData = {
  matter: { id: 'mat_2', title: '客户问退货', entry: 'position' },
  candidates: [
    { role_id: 'dtc.content', role_name: '内容与博客', score: 0.5, why: ['客户'] },
    { role_id: 'dtc.store', role_name: '店铺管理', score: 0.5, why: ['客户'] },
  ],
  ambiguous: true,
  reason: '这件事像「内容与博客」也像「店铺管理」，你定',
  approval_item_id: 'apr_1',
}

const getPosition = vi.fn(async () => INSTANCE)
const openMatterAtPosition = vi.fn(async () => PICKED)
const createMatterWithRole = vi.fn(async () => ({ matter: { id: 'mat_3' } }))
const rerouteMatter = vi.fn(async () => ({
  matter: { id: 'mat_2', role_id: 'dtc.store' },
  assignment_id: 'asg_store',
}))
const navigate = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPosition: (...args: unknown[]) => getPosition(...(args as [])),
    openMatterAtPosition: (...args: unknown[]) => openMatterAtPosition(...(args as [])),
    createMatterWithRole: (...args: unknown[]) => createMatterWithRole(...(args as [])),
    rerouteMatter: (...args: unknown[]) => rerouteMatter(...(args as [])),
  }
})

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigate }
})

const { PositionEntry } = await import('@/components/work/position-entry')

const type = (value: string): void => {
  fireEvent.change(screen.getByTestId('position-entry-input'), { target: { value } })
}

describe('54 §2 / §4 岗位页顶部：交给这个岗位一件事', () => {
  beforeEach(() => {
    getPosition.mockClear()
    openMatterAtPosition.mockClear()
    createMatterWithRole.mockClear()
    rerouteMatter.mockClear()
    navigate.mockClear()
    openMatterAtPosition.mockResolvedValue(PICKED)
  })

  it('显示的是**岗位名**，计数按岗位聚合；职责默认折叠（54 §4）', async () => {
    renderWithProviders(<PositionEntry id="asg_store" />)
    expect(await screen.findByTestId('position-entry')).toBeDefined()
    expect(screen.getByText('网站运营')).toBeDefined()
    expect(screen.getByTestId('position-counts').textContent).toContain('3')
    // 职责没展开之前一条都看不见
    expect(screen.queryByTestId('position-roles')).toBeNull()
    expect(screen.queryByText('店铺管理')).toBeNull()
    expect(screen.getByTestId('position-roles-toggle').getAttribute('aria-expanded')).toBe('false')
  })

  it('一句话 → 判准了 → 直接进事项页', async () => {
    renderWithProviders(<PositionEntry id="asg_store" />)
    await screen.findByTestId('position-entry')
    type('把 A 商品降价 10%')
    fireEvent.click(screen.getByTestId('position-entry-submit'))
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/matters/mat_1')
    })
    expect(openMatterAtPosition).toHaveBeenCalledWith('asg_store', { title: '把 A 商品降价 10%' })
    // 判准了就没有选择题
    expect(screen.queryByTestId('route-choice')).toBeNull()
  })

  it('拿不准：界面不替人选，把候选摆出来；点一条才定下来', async () => {
    openMatterAtPosition.mockResolvedValue(AMBIGUOUS)
    renderWithProviders(<PositionEntry id="asg_store" />)
    await screen.findByTestId('position-entry')
    type('客户问退货')
    fireEvent.click(screen.getByTestId('position-entry-submit'))
    const choice = await screen.findByTestId('route-choice')
    expect(choice.textContent).toContain('你定')
    // 没进事项页：这一步还没定
    expect(navigate).not.toHaveBeenCalled()
    const options = screen.getAllByTestId('route-choice-option')
    expect(options).toHaveLength(2)
    fireEvent.click(options[1] as HTMLElement)
    await waitFor(() => {
      expect(rerouteMatter).toHaveBeenCalledWith('mat_2', 'dtc.store')
    })
    expect(navigate).toHaveBeenCalledWith('/matters/mat_2')
  })

  it('只有一条职责的岗位不出第二层：那一条的名字直接摆在岗位下面（WP70）', async () => {
    getPosition.mockResolvedValueOnce({
      ...INSTANCE,
      roles: [INSTANCE.roles[0] as (typeof INSTANCE.roles)[number]],
    })
    renderWithProviders(<PositionEntry id="asg_store" />)
    await screen.findByTestId('position-entry')
    // 没有折叠条（点开一层去看一条，白花认知成本），那一条直接看得见
    expect(screen.queryByTestId('position-roles-toggle')).toBeNull()
    expect(screen.getByTestId('position-roles-single')).toBeDefined()
    expect(screen.getByText('店铺管理')).toBeDefined()
    // 入口照样在：一句话之后「用这条职责开」走的还是本人那条分配
    type('把 A 商品降价 10%')
    fireEvent.click(screen.getByTestId('open-with-role'))
    await waitFor(() => {
      expect(createMatterWithRole).toHaveBeenCalledWith('asg_store', {
        title: '把 A 商品降价 10%',
      })
    })
  })

  it('展开第二层：每条职责旁一个「用这条职责开」，走的是那条职责的分配', async () => {
    renderWithProviders(<PositionEntry id="asg_store" />)
    await screen.findByTestId('position-entry')
    fireEvent.click(screen.getByTestId('position-roles-toggle'))
    expect(screen.getByTestId('position-roles')).toBeDefined()
    expect(screen.getByText('店铺管理')).toBeDefined()
    // 没写要办什么之前按钮是灰的——职责入口同样需要一句话
    expect((screen.getAllByTestId('open-with-role')[0] as HTMLButtonElement).disabled).toBe(true)
    type('把这篇文章发出去')
    fireEvent.click(screen.getAllByTestId('open-with-role')[1] as HTMLElement)
    await waitFor(() => {
      expect(createMatterWithRole).toHaveBeenCalledWith('asg_content', {
        title: '把这篇文章发出去',
      })
    })
    expect(navigate).toHaveBeenCalledWith('/matters/mat_3')
  })
})
