/**
 * 「我的秘书」与别人的 profile 页（41 §1，WP39）。
 *
 * 四件事：
 * - 问他的秘书：答案照实显示；被拒的那一句也照实显示（不粉饰成"暂无数据"）
 * - 公开级别表就是 41 §1.3 那张表；"日程明细"那一行没有"全工作区"这一格
 * - 别人的 profile 页：藏起来的字段写"这个要问本人"，而不是当它不存在
 * - 约时间撞上了：出替代时段，点一下就换过去
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import {
  ApiClientError,
  type MeetProposalView,
  type MyProfile,
  type PersonCard,
  type SecretaryAnswer,
  type VisibleProfile,
} from '@/lib/api'
import { renderWithProviders } from './helpers'

const PEOPLE: PersonCard[] = [
  {
    person_id: 'p_wang',
    name: '王岚',
    positions: [{ role_id: 'common.owner', role_name: '店主' }],
  },
  {
    person_id: 'p_li',
    name: '李默',
    positions: [{ role_id: 'dtc.ops', role_name: '独立站运营' }],
    in_progress: 2,
  },
]

const MY_PROFILE: MyProfile = {
  person_id: 'p_wang',
  name: '王岚',
  positions: [{ position_id: 'a1', role_id: 'common.owner', role_name: '店主', ranges: [] }],
  ranges: [],
  skills: [{ name: '定价', source: 'self' }],
  contact_policy: { prefer: 'secretary' },
  availability: {
    rules: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }],
    default_minutes: 30,
  },
  disclosure: {
    positions: 'colleagues',
    ranges: 'colleagues',
    in_progress: 'colleagues',
    availability: 'colleagues',
    agenda_detail: 'self',
    skills: 'colleagues',
    contact: 'colleagues',
  },
  updated_at: '2026-09-10T00:00:00.000Z',
}

/** 李默把忙闲与日程明细都设成了只有自己看得到。 */
const LI_PROFILE: VisibleProfile = {
  person_id: 'p_li',
  name: '李默',
  relation: 'colleague',
  positions: [{ position_id: 'a2', role_id: 'dtc.ops', role_name: '独立站运营', ranges: [] }],
  ranges: [{ kind: 'store', id: 'store_main' }],
  skills: [{ name: '退款政策', source: 'skill' }],
  contact_policy: { prefer: 'secretary' },
  hidden_fields: ['availability', 'agenda_detail'],
}

const DOING: SecretaryAnswer = {
  answer: '李默手上有 2 件在进行：「核对昨天的退款单」、「德国站补货」。',
  kind: 'doing',
  fields: ['in_progress'],
  refused: false,
  run_id: 'run_1',
}

const REFUSED: SecretaryAnswer = {
  answer: '这个秘书不能说——私有待办只有李默本人看得到。这个要问李默本人。',
  kind: 'private',
  fields: [],
  refused: true,
  run_id: 'run_2',
}

const PROPOSAL: MeetProposalView = {
  id: 'meet_1',
  from: 'p_wang',
  from_label: '王岚',
  to: 'p_li',
  to_label: '李默',
  title: '聊定价',
  duration_minutes: 30,
  candidates: [{ start: '2026-09-14T06:00:00.000Z', end: '2026-09-14T06:30:00.000Z' }],
  state: 'proposed',
  alternatives: [],
  created_at: '2026-09-10T00:00:00.000Z',
}

const conflictError = (): ApiClientError =>
  new ApiClientError(409, {
    code: 'conflict',
    message: '这几个时段都约不上',
    details: {
      reason: 'slot_conflict',
      alternatives: [{ start: '2026-09-14T07:00:00.000Z', end: '2026-09-14T07:30:00.000Z' }],
    },
  })

const listPeople = vi.fn(async () => PEOPLE)
const getMyProfile = vi.fn(async () => MY_PROFILE)
const getPersonProfile = vi.fn(async () => LI_PROFILE)
const askSecretary = vi.fn(async () => DOING)
const listAskedMe = vi.fn(async () => [])
const listMyMeets = vi.fn(async () => [] as MeetProposalView[])
const proposeMeet = vi.fn(async () => PROPOSAL)
const updateMyProfile = vi.fn(async () => MY_PROFILE)
const routeToDesk = vi.fn()
const decideMeet = vi.fn(async () => ({ ...PROPOSAL, state: 'accepted' as const }))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listPeople: (...a: unknown[]) => listPeople(...(a as [])),
    getMyProfile: (...a: unknown[]) => getMyProfile(...(a as [])),
    getPersonProfile: (...a: unknown[]) => getPersonProfile(...(a as [])),
    askSecretary: (...a: unknown[]) => askSecretary(...(a as [])),
    listAskedMe: (...a: unknown[]) => listAskedMe(...(a as [])),
    listMyMeets: (...a: unknown[]) => listMyMeets(...(a as [])),
    proposeMeet: (...a: unknown[]) => proposeMeet(...(a as [])),
    updateMyProfile: (...a: unknown[]) => updateMyProfile(...(a as [])),
    routeToDesk: (...a: unknown[]) => routeToDesk(...(a as [])),
    decideMeet: (...a: unknown[]) => decideMeet(...(a as [])),
  }
})

const { SecretaryPage } = await import('@/pages/profile')
const { PersonPage } = await import('@/pages/people')
const { AskSecretary } = await import('@/components/secretary/ask-secretary')
const { MeetDialog } = await import('@/components/secretary/meet-dialog')
const { ProfileForm } = await import('@/components/secretary/profile-form')

describe('问他的秘书（41 §1.2）', () => {
  it('答案照实显示', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AskSecretary people={PEOPLE} />)
    await user.type(screen.getByTestId('ask-question'), '李默在忙什么')
    await user.click(screen.getByTestId('ask-submit'))
    const answer = await screen.findByTestId('ask-answer')
    expect(answer.textContent).toContain('核对昨天的退款单')
    expect(answer.dataset.refused).toBe('false')
  })

  it('被拒的那一句也照实显示，不粉饰成"暂无数据"', async () => {
    askSecretary.mockResolvedValueOnce(REFUSED)
    const user = userEvent.setup()
    renderWithProviders(<AskSecretary fixedPerson={{ person_id: 'p_li', name: '李默' }} />)
    await user.type(screen.getByTestId('ask-question'), '他的私有待办有哪些')
    await user.click(screen.getByTestId('ask-submit'))
    const answer = await screen.findByTestId('ask-answer')
    expect(answer.dataset.refused).toBe('true')
    expect(answer.textContent).toContain('要问李默本人')
  })

  it('指定了人就不出选择框（别人的 profile 页上那一个）', () => {
    renderWithProviders(<AskSecretary fixedPerson={{ person_id: 'p_li', name: '李默' }} />)
    expect(screen.queryByTestId('ask-who')).toBeNull()
  })
})

describe('公开级别就是 41 §1.3 那张表', () => {
  it('七行都在；"日程明细"那一行没有"全工作区"这一格', () => {
    renderWithProviders(<ProfileForm profile={MY_PROFILE} />)
    const rows = screen.getAllByTestId('disclosure-row')
    expect(rows).toHaveLength(7)
    expect(screen.getByLabelText('日程明细（和谁开会） 仅本人')).toBeDefined()
    expect(screen.queryByLabelText('日程明细（和谁开会） 全工作区')).toBeNull()
    expect(screen.getByLabelText('岗位 全工作区')).toBeDefined()
  })

  it('改一格再保存，带着整张表发上去', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ProfileForm profile={MY_PROFILE} />)
    await user.click(screen.getByLabelText('忙闲（时段级） 仅本人'))
    await user.click(screen.getByTestId('profile-save'))
    await waitFor(() => {
      expect(updateMyProfile).toHaveBeenCalled()
    })
    const patch = (
      updateMyProfile.mock.calls as unknown as { disclosure: Record<string, string> }[][]
    )[0]?.[0]
    expect(patch?.disclosure.availability).toBe('self')
    expect(patch?.disclosure.positions).toBe('colleagues')
    expect(await screen.findByTestId('profile-saved')).toBeDefined()
  })
})

describe('别人的 profile 页', () => {
  it('藏起来的字段写"这个要问本人"，而不是当它不存在', async () => {
    // PersonPage 从路由参数取人，所以这里得真挂一条路由
    renderWithProviders(
      <Routes>
        <Route path="/people/:id" element={<PersonPage />} />
      </Routes>,
      '/people/p_li',
    )
    await screen.findByTestId('person-page')
    expect(screen.getByText('独立站运营')).toBeDefined()
    // 忙闲被藏了 → 页面上有一条"要问本人"
    expect(screen.getAllByTestId('person-hidden').length).toBeGreaterThan(0)
  })
})

describe('约时间（41 §1.2 第二行）', () => {
  it('撞上了给替代时段，点一下就换过去', async () => {
    proposeMeet.mockRejectedValueOnce(conflictError())
    const user = userEvent.setup()
    renderWithProviders(<MeetDialog fixedPerson={{ person_id: 'p_li', name: '李默' }} />)
    await user.click(screen.getByTestId('meet-submit'))
    const conflict = await screen.findByTestId('meet-conflict')
    expect(conflict.textContent).toContain('约不上')
    const alt = screen.getAllByTestId('meet-alternative')[0]
    expect(alt).toBeDefined()
    await user.click(alt as HTMLElement)
    expect(screen.queryByTestId('meet-conflict')).toBeNull()
  })

  it('发出去只是一张卡：界面照实说"对方点头才进双方日历"', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MeetDialog fixedPerson={{ person_id: 'p_li', name: '李默' }} />)
    await user.click(screen.getByTestId('meet-submit'))
    expect((await screen.findByTestId('meet-sent')).textContent).toContain('点头')
  })
})

describe('我的秘书页', () => {
  it('四个 Tab；"把一件事丢给秘书"在问秘书那一页', async () => {
    renderWithProviders(<SecretaryPage />)
    await screen.findByTestId('secretary-page')
    expect(screen.getByRole('tab', { name: /问秘书/ })).toBeDefined()
    expect(screen.getByRole('tab', { name: /我的 profile/ })).toBeDefined()
    expect(screen.getByRole('tab', { name: /谁问过我/ })).toBeDefined()
    expect(await screen.findByTestId('route-panel')).toBeDefined()
  })

  it('丢一件事给秘书 → 界面写清楚判给了哪个岗位、为什么', async () => {
    routeToDesk.mockResolvedValueOnce({
      kind: 'task',
      role_id: 'dtc.aftersales',
      role_name: '独立站售后客服',
      owner: 'p_chen',
      owner_label: '陈晓',
      confidence: 0.8,
      reason: '秘书判断：独立站售后客服，因为你说了「退款」',
      existing_tools: [],
      similar_in_progress: [],
      claim_item_id: 'item_1',
      todo_id: 'td_1',
      run_id: 'run_3',
    })
    const user = userEvent.setup()
    renderWithProviders(<SecretaryPage />)
    await screen.findByTestId('route-panel')
    await user.type(screen.getByTestId('route-text'), '客户投诉包裹破损要退款')
    await user.click(screen.getByTestId('route-submit'))
    const result = await screen.findByTestId('route-result')
    expect(result.dataset.kind).toBe('task')
    expect(result.textContent).toContain('独立站售后客服')
    expect(result.textContent).toContain('因为你说了')
  })

  it('专业问题：界面说清"秘书不答，转给岗位"', async () => {
    routeToDesk.mockResolvedValueOnce({
      kind: 'question',
      role_id: 'dtc.aftersales',
      role_name: '独立站售后客服',
      confidence: 0.7,
      reason: '秘书判断：这是独立站售后客服的专业问题，秘书不答，转给岗位',
      existing_tools: [],
      similar_in_progress: [],
      run_id: 'run_4',
    })
    const user = userEvent.setup()
    renderWithProviders(<SecretaryPage />)
    await screen.findByTestId('route-panel')
    await user.type(screen.getByTestId('route-text'), '退货窗口外能不能退？')
    await user.click(screen.getByTestId('route-submit'))
    const result = await screen.findByTestId('route-result')
    expect(result.dataset.kind).toBe('question')
    expect(result.textContent).toContain('专业问题')
  })
})
