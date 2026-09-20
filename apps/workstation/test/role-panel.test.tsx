/**
 * WP120（69 §4）**第三栏「角色」面板**：看得到、改得动、还原得回来。
 *
 * 钉住的几条（每一条都是"少做一半就白做"的那种）：
 *
 * - 职责页开的是**这条职责**那一份，并且**同时给出它所属岗位**那一段
 *   （69 §3：运行时先装岗位再装职责，界面上也按这个顺序给人看）；
 * - 岗位页开的是岗位那一份 + 下属职责清单（点一条跳到它自己的定位）；
 * - 改写走 `PUT /v1/personas`，**只带改动的那一边语言**（另一边由服务端补齐）；
 * - 改过之后：标出「公司改写过」、**包里的原文折叠着仍在**、「还原」按钮才出现
 *   ——不显示原文，「还原」就是一个看不见结果的按钮；
 * - 非 owner 点保存 → `role="alert"` 一句人话（界面不自己预判能不能改，36 §10.1）；
 * - 反查不出唯一岗位时说清"所以运行时不带岗位那一段"，不画一个空框。
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError, type PersonaViewData, type PositionInstanceData } from '@/lib/api'
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
    {
      role_id: 'dtc.content',
      role_name: '内容与博客',
      default: true,
      assignment_ids: ['asg_content'],
      my_assignment_id: 'asg_content',
    },
  ],
  open_matters: 2,
  pending_cards: 3,
  memory_summary: '岗位层：2 段',
}

/** 包里自带的那一份（没被公司改写过）。 */
const BUNDLED_ROLE: PersonaViewData = {
  subject: { kind: 'role', id: 'dtc.store' },
  name: { zh: '店铺管理', en: 'Store ops' },
  effective: {
    zh: '你是谁：这家店的店铺管理。\n你不负责：客户退款→客服。',
    en: 'Who you are: store ops.\nNot yours: refunds → Customer Care.',
  },
  packaged: {
    zh: '你是谁：这家店的店铺管理。\n你不负责：客户退款→客服。',
    en: 'Who you are: store ops.\nNot yours: refunds → Customer Care.',
  },
  overridden: false,
}

/** 公司改写之后的那一份：生效的是新写的，原文仍在，标出改过。 */
const OVERRIDDEN_ROLE: PersonaViewData = {
  ...BUNDLED_ROLE,
  effective: {
    zh: '你是谁：我们公司自己的店铺管理打法。\n你不负责：客户退款→客服。',
    en: 'Who you are: store ops.\nNot yours: refunds → Customer Care.',
  },
  overridden: true,
  updated_at: '2026-09-19T08:00:00.000Z',
  updated_by: 'p_owner',
}

const POSITION_VIEW: PersonaViewData = {
  subject: { kind: 'position', id: 'web-ops' },
  name: { zh: '网站运营', en: 'Web Operations' },
  effective: {
    zh: '你是谁：网站运营岗位。\n你不负责：客户的退款→客服。',
    en: 'Who you are: web ops.',
  },
  packaged: {
    zh: '你是谁：网站运营岗位。\n你不负责：客户的退款→客服。',
    en: 'Who you are: web ops.',
  },
  overridden: false,
}

const getPersona = vi.fn(async (_kind: 'position' | 'role', id: string) =>
  id === 'web-ops' ? POSITION_VIEW : BUNDLED_ROLE,
)
const setPersona = vi.fn(async (_input: unknown) => OVERRIDDEN_ROLE)
const revertPersona = vi.fn(async (_input: unknown) => BUNDLED_ROLE)
const getPosition = vi.fn(async () => INSTANCE)

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPersona: (...a: [kind: 'position' | 'role', id: string]) => getPersona(...a),
    setPersona: (...a: Parameters<typeof setPersona>) => setPersona(...a),
    revertPersona: (...a: Parameters<typeof revertPersona>) => revertPersona(...a),
    getPosition: (...a: unknown[]) => getPosition(...(a as [])),
  }
})

const { RightRail } = await import('@/components/rail/right-rail')
const { RailStateProvider } = await import('@/components/rail/rail-state')

/** 第三栏的开合态住在 `RailStateProvider` 里（真应用里由 `AppShell` 提供）。 */
function renderRail(route = '/', position = 'asg_store'): void {
  renderWithProviders(
    <RailStateProvider>
      <RightRail instances={[INSTANCE]} />
    </RailStateProvider>,
    route,
    position,
  )
}

/** 开出「角色」面板，回它那个框。 */
async function openRolePanel(route = '/', position = 'asg_store'): Promise<HTMLElement> {
  renderRail(route, position)
  fireEvent.click(screen.getByTestId('rail-icon-role'))
  // 面板体是 `lazy()` 的：第一次要现加载那个 chunk，机器忙的时候 1 秒不够
  const panel = await screen.findByTestId('role-panel', undefined, { timeout: 8000 })
  await screen.findAllByTestId('role-persona', undefined, { timeout: 8000 })
  return panel
}

/**
 * 保存过没有。改写成功后面板会 invalidate 查询、重新 `getPersona`——
 * 桩得跟着翻成"公司改写过"那一份，否则测的是"保存按钮按下去了"而不是"改完之后长什么样"。
 */
let saved = false

beforeEach(() => {
  for (const m of [getPersona, setPersona, revertPersona, getPosition]) m.mockClear()
  saved = false
  getPersona.mockImplementation(async (_kind, id) => {
    if (id === 'web-ops') return POSITION_VIEW
    return saved ? OVERRIDDEN_ROLE : BUNDLED_ROLE
  })
  setPersona.mockImplementation(async (input: unknown) => {
    saved = true
    void input
    return OVERRIDDEN_ROLE
  })
  revertPersona.mockImplementation(async (_input: unknown) => {
    saved = false
    return BUNDLED_ROLE
  })
})

describe('角色面板：看（69 §4）', () => {
  it('职责页 → 这条职责那一段，并且同时给出它所属的岗位那一段', async () => {
    const panel = await openRolePanel('/positions/asg_store/duties/dtc.store')
    expect(panel.dataset.scope).toBe('dtc.store')
    // 两段都在：职责在前、岗位在后（与运行时装配同一个顺序）
    const blocks = within(panel).getAllByTestId('role-persona')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.dataset.subject).toBe('dtc.store')
    expect(blocks[1]?.dataset.subject).toBe('web-ops')
    expect(within(panel).getByText('这条职责所属的岗位')).toBeDefined()
    // 包里自带的那一份：没有「还原」，也没有"公司改写过"那个标
    expect(within(panel).getAllByText('包里自带').length).toBeGreaterThan(0)
    expect(within(panel).queryByTestId('role-revert')).toBeNull()
  })

  it('岗位页 → 岗位那一段 + 下属职责清单（点一条看它自己的定位）', async () => {
    const panel = await openRolePanel('/')
    expect(panel.dataset.scope).toBe('web-ops')
    const links = within(panel).getAllByTestId('role-duty-link')
    expect(links.map((l) => l.getAttribute('data-duty'))).toEqual(['dtc.store', 'dtc.content'])
    expect(links[0]?.getAttribute('href')).toBe('/positions/asg_store/duties/dtc.store')
  })

  it('说清这段话会进系统提示（用户要知道改下去的后果）', async () => {
    const panel = await openRolePanel('/positions/asg_store/duties/dtc.store')
    // 职责与岗位两段各带一句提示，所以是"至少一句"而不是"正好一句"
    expect(
      within(panel).getAllByText('这段话会进 Agent 的系统提示，改了下一次运行就生效。').length,
    ).toBeGreaterThan(0)
  })

  it('反查不出唯一岗位：说清"所以运行时不带岗位那一段"，不画一个空框', async () => {
    /*
     * `common.owner` / `common.member` 那类：这条职责不挂在唯一一个岗位下，
     * 运行时就不装岗位那一段（54 §3「不猜一个」），界面上要说清为什么。
     * 这一路 `railContextOf` 算不出来（它只在岗位面里找得到 owner 时才给 role），
     * 所以直接把面板挂上一个没有 `parent` 的作用域。
     */
    const { RolePanel } = await import('@/components/rail/panels/role-panel')
    renderWithProviders(
      <RolePanel scope={{ tier: 'role', scope_id: 'common.owner', name: '店主 / 负责人' }} />,
      '/',
      'asg_store',
    )
    const panel = await screen.findByTestId('role-panel')
    expect(await within(panel).findByTestId('role-no-position')).toBeDefined()
    // 职责自己那一段照旧出——少了岗位段不等于什么都没有
    expect(within(panel).getAllByTestId('role-persona')).toHaveLength(1)
  })
})

describe('角色面板：改与还原（69 §4）', () => {
  it('改写 → 文本框预填现在生效的那一份 → 保存只带改动的那一边语言', async () => {
    const panel = await openRolePanel('/positions/asg_store/duties/dtc.store')
    fireEvent.click(within(panel).getAllByTestId('role-edit')[0] as HTMLElement)
    const editor = (await within(panel).findByTestId('role-editor')) as HTMLTextAreaElement
    expect(editor.value).toContain('这家店的店铺管理')

    fireEvent.change(editor, { target: { value: '你是谁：我们公司自己的店铺管理打法。' } })
    fireEvent.click(within(panel).getAllByTestId('role-save')[0] as HTMLElement)

    await waitFor(() => {
      expect(setPersona).toHaveBeenCalledTimes(1)
    })
    // 只带中文那一边——英文由服务端从现在生效的那一份补齐（不留空）
    expect(setPersona.mock.calls[0]?.[0]).toEqual({
      kind: 'role',
      id: 'dtc.store',
      zh: '你是谁：我们公司自己的店铺管理打法。',
    })
  })

  it('改过之后：标「公司改写过」、原文折叠着仍在、「还原」按钮才出现', async () => {
    const panel = await openRolePanel('/positions/asg_store/duties/dtc.store')
    fireEvent.click(within(panel).getAllByTestId('role-edit')[0] as HTMLElement)
    fireEvent.change(await within(panel).findByTestId('role-editor'), {
      target: { value: '你是谁：我们公司自己的店铺管理打法。' },
    })
    fireEvent.click(within(panel).getAllByTestId('role-save')[0] as HTMLElement)

    await waitFor(() => {
      expect(within(panel).getAllByText('公司改写过').length).toBeGreaterThan(0)
    })
    // 69 §4：包里的原文永远看得见——不显示出来，「还原」就是一个看不见结果的按钮
    expect(within(panel).getAllByTestId('role-packaged').length).toBeGreaterThan(0)
    expect(within(panel).getAllByText('包里的原文').length).toBeGreaterThan(0)
    expect(within(panel).getAllByTestId('role-revert').length).toBeGreaterThan(0)
    expect(within(panel).getAllByText('p_owner 于 2026-09-19 改的').length).toBeGreaterThan(0)
  })

  it('还原 → 走 POST /v1/personas/revert，回到包里自带', async () => {
    saved = true // 进来就是"公司改写过"那一份，「还原」按钮才在
    const panel = await openRolePanel('/positions/asg_store/duties/dtc.store')
    fireEvent.click(within(panel).getAllByTestId('role-revert')[0] as HTMLElement)
    await waitFor(() => {
      expect(revertPersona).toHaveBeenCalledWith({ kind: 'role', id: 'dtc.store' })
    })
    // 还原之后回到"包里自带"，「还原」按钮跟着消失
    await waitFor(() => {
      expect(within(panel).queryAllByTestId('role-revert')).toHaveLength(0)
    })
  })

  it('非 owner 点保存：403 的那句人话出现在 role="alert" 里，不是静默失败', async () => {
    setPersona.mockRejectedValue(
      new ApiClientError(403, {
        code: 'forbidden',
        message: '角色定位是公司对外的口径，只有 owner 改得动',
      }),
    )
    const panel = await openRolePanel('/positions/asg_store/duties/dtc.store')
    fireEvent.click(within(panel).getAllByTestId('role-edit')[0] as HTMLElement)
    fireEvent.change(await within(panel).findByTestId('role-editor'), {
      target: { value: '你是谁：我想自己改一句。' },
    })
    fireEvent.click(within(panel).getAllByTestId('role-save')[0] as HTMLElement)

    const alert = await within(panel).findByRole('alert')
    expect(alert.textContent).toContain('只有 owner 改得动')
  })

  it('正文清空了就不给保存（要恢复原文请用「还原」）', async () => {
    const panel = await openRolePanel('/positions/asg_store/duties/dtc.store')
    fireEvent.click(within(panel).getAllByTestId('role-edit')[0] as HTMLElement)
    fireEvent.change(await within(panel).findByTestId('role-editor'), { target: { value: '   ' } })
    const save = within(panel).getAllByTestId('role-save')[0] as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(setPersona).not.toHaveBeenCalled()
  })
})
