/**
 * WP419（主会话 Mac 自测 / 自查 S10、U7）：岗位要插件、插件没配上时，右栏「连接」不再写「都连好了」；
 * 新建岗位 / 加职责的芯片上 Reddit 那两条带「Reddit」字样。
 */
import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useConnectionsStatus } from '@/components/rail/card-status'
import type { RailScope } from '@/components/rail/rail-scope'
import type { ExtensionNeedsView } from '@/lib/api'
import { dutyChipLabel } from '@/lib/duty-chip'
import { renderWithProviders } from './helpers'

const state: { needs: ExtensionNeedsView } = {
  needs: {
    needed: true,
    uses: ['reddit'],
    roles: [{ role_id: 'pr.reddit', name: { zh: '外部版块', en: 'Other Subreddits' } }],
    paired: false,
    steps: [{ step: 'reddit', done: false }],
    plans: [],
    snoozed: false,
  },
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getExtensionNeeds: async () => state.needs,
    // 连接清单里的那几条都连着（以前就因为这样写「都连好了」）
    getPositionConnections: async () => ({
      items: [
        { kind: 'llm', name: 'AI', required: true, connected: true, role_ids: ['pr.reddit'] },
      ],
    }),
    getCompetitorWatch: async () => undefined,
  }
})

const scope: RailScope = {
  tier: 'position',
  scope_id: 'pos_pr',
  name: '公共关系',
  assignment: 'asg_pr',
  roles: [{ role_id: 'pr.reddit', assignment: 'asg_pr' }],
}

function Probe(): React.ReactNode {
  const st = useConnectionsStatus({ scope } as never)
  return (
    <span data-testid="conn" data-dot={st?.dot ?? ''}>
      {st?.summary ?? ''}
    </span>
  )
}

describe('WP419 右栏「连接」照实说插件', () => {
  it('插件没配上 → 「插件还没装好」红点；配上了还差连 Reddit → 「插件还差一步」', async () => {
    const { unmount } = renderWithProviders(<Probe />)
    await waitFor(() => expect(screen.getByTestId('conn').textContent).toBe('插件还没装好'))
    expect(screen.getByTestId('conn').getAttribute('data-dot')).toBe('alert')
    unmount()
    state.needs = { ...state.needs, paired: true }
    renderWithProviders(<Probe />)
    await waitFor(() => expect(screen.getByTestId('conn').textContent).toBe('插件还差一步'))
  })
  it('芯片上带「Reddit」；别的职责不动', () => {
    expect(dutyChipLabel('social.reddit', '官方版块')).toBe('Reddit · 官方版块')
    expect(dutyChipLabel('pr.reddit', 'Other Subreddits')).toBe('Reddit · Other Subreddits')
    expect(dutyChipLabel('pr.reddit', 'Reddit 外部版块')).toBe('Reddit 外部版块')
    expect(dutyChipLabel('dtc.store', '店铺管理')).toBe('店铺管理')
  })
})
