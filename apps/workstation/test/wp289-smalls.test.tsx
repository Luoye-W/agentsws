/**
 * WP289（决策 293 / 307 / 313 / 318）几件小收尾的界面。
 *
 * - 293：「请他离开」先问一句（同一个框），列出他会一起断开的个人连接，确认了才移出；
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ColleaguesTab } from '@/components/org/colleagues-tab'
import type { OrgMemberView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const T0 = '2026-10-09T09:00:00.000Z'

const state: { personal: { id: string; label: string }[]; asked: string[] } = {
  personal: [],
  asked: [],
}

vi.mock('@/lib/api-peers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-peers')>('@/lib/api-peers')
  return {
    ...actual,
    listColleagues: async () => ({
      colleagues: [{ person_id: 'per_li', name: '李默', in_progress: 0, load: '空着' }],
    }),
    previewLeave: async () => ({ personal_connections: [] }),
    previewRemoveMember: async (_ws: string, person_id: string) => {
      state.asked.push(person_id)
      return { personal_connections: state.personal }
    },
  }
})

const member = (person_id: string, name: string): OrgMemberView => ({
  person_id,
  name,
  email: `${person_id}@ex.com`,
  role: person_id === 'per_wang' ? 'owner' : 'member',
  joined_at: T0,
  positions: [],
  assignments: [],
})

function tab(): ReturnType<typeof vi.fn> {
  const onRemove = vi.fn()
  renderWithProviders(
    <ColleaguesTab
      me="per_wang"
      initiator="per_wang"
      members={[member('per_wang', '王岚'), member('per_li', '李默')]}
      invites={[]}
      requests={[]}
      busy={false}
      onCreateInvite={() => undefined}
      onDecide={() => undefined}
      onRemove={onRemove}
      onLeave={() => undefined}
      onExport={() => undefined}
      workspaceId="ws_1"
    />,
  )
  return onRemove
}

beforeEach(() => {
  state.personal = []
  state.asked = []
})

describe('WP289 请他离开先问一句（决策 293）', () => {
  it('框里是「请 李默 离开？」+ 他的个人连接；取消不移出，确认才移出', async () => {
    state.personal = [{ id: 'conn_1', label: 'lin@private.cn' }]
    const onRemove = tab()
    fireEvent.click(await screen.findByTestId('colleague-remove'))
    const dialog = await screen.findByTestId('leave-confirm')
    expect(dialog.textContent).toContain('请 李默 离开？')
    const items = await within(dialog).findAllByTestId('leave-personal-item')
    expect(items.map((x) => x.textContent)).toEqual(['lin@private.cn'])
    expect(dialog.textContent).toContain('他接的这几条个人连接会一起断开')
    expect(state.asked).toEqual(['per_li'])
    fireEvent.click(within(dialog).getByText('取消'))
    expect(onRemove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('colleague-remove'))
    const ok = (await screen.findByTestId('leave-confirm-ok')) as HTMLButtonElement
    expect(ok.textContent).toBe('请他离开')
    await waitFor(() => {
      expect(ok.disabled).toBe(false)
    })
    fireEvent.click(ok)
    expect(onRemove).toHaveBeenCalledWith('per_li', '李默')
  })

  it('他没有个人连接：框里不出那一段', async () => {
    tab()
    fireEvent.click(await screen.findByTestId('colleague-remove'))
    const dialog = await screen.findByTestId('leave-confirm')
    await waitFor(() => {
      expect((within(dialog).getByTestId('leave-confirm-ok') as HTMLButtonElement).disabled).toBe(
        false,
      )
    })
    expect(within(dialog).queryByTestId('leave-personal')).toBeNull()
  })
})
