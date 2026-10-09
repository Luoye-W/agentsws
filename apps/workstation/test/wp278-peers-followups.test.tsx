/**
 * WP278（决策 276 / 277 / 278 / 284）：② 同事互联收尾的界面。
 *
 * - 「同事」tab：发起人自己那一行「把发起人交给…」→ 挑一位同事；还在等的时候是「等 X 接 · 撤回」；
 *   没接的一行结果；不是发起人没有这个入口；
 * - 「退出」先问一句：框里列出会断开的个人连接，确认了才退；
 * - 开公司时那张卡上的「我要退出」同样先问；
 * - 「把发起人交给你」那张卡：一个「接下」+「不接」，键盘提示与按钮一致，那一句只说一遍；
 * - 连接页：自己接的那条有「个人」开关，别人接的没有；
 * - 只有一个岗位的人：岗位页牌堆第一条职责带 `base`，同一张卡只出一次。
 */
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectedRow } from '@/components/connections/connected-row'
import { DeckCardView } from '@/components/deck/deck-card'
import { ColleaguesTab } from '@/components/org/colleagues-tab'
import type { CardsData, ConnectionView, OrgMemberView } from '@/lib/api'
import type { PeerOfferView } from '@/lib/api-peers'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const T0 = '2026-10-09T09:00:00.000Z'

const state: { personal: { id: string; label: string }[] } = { personal: [] }
const getPositionCards = vi.fn(
  async (..._args: unknown[]): Promise<CardsData> => ({
    position: {
      position_id: 'asg_1',
      role_id: 'b2b.sales',
      role_name: '外贸业务',
      ranges: [],
      ready: true,
      missing_connectors: [],
      tile_ids: [],
      range: 'yesterday',
      show_tiles: false,
    },
    cards: [],
    filters: {},
    counts: { total: 0, customer_waiting: 0, nobody_waiting: 0, matched: 0 },
    pinned_p0: [],
  }),
)

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    ensureSession: async () => ({
      person: { id: 'per_li', email: 'li@ex.com', name: '李默' },
      workspace: { id: 'ws_1', name: 'NordVolt' },
      assignments: [],
    }),
    getPositions: async () => ({ positions: [], instances: [], tile_library: [], max_tiles: 6 }),
    getPositionCards: (...args: unknown[]) => getPositionCards(...args),
  }
})

vi.mock('@/lib/api-peers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-peers')>('@/lib/api-peers')
  return {
    ...actual,
    listColleagues: async () => ({
      colleagues: [{ person_id: 'per_li', name: '李默', in_progress: 0, load: '空着' }],
    }),
    previewLeave: async () => ({ personal_connections: state.personal }),
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
const MEMBERS = [member('per_wang', '王岚'), member('per_li', '李默')]

const offer = (over: Partial<PeerOfferView>): PeerOfferView => ({
  id: 'ap_offer',
  kind: 'initiator',
  from: 'per_wang',
  from_name: '王岚',
  to: 'per_li',
  to_name: '李默',
  state: 'offered',
  at: T0,
  ...over,
})

function tab(
  me: string,
  extra: Partial<Parameters<typeof ColleaguesTab>[0]> = {},
): ReturnType<typeof vi.fn>[] {
  const onLeave = vi.fn()
  const onOfferInitiator = vi.fn()
  const onWithdrawOffer = vi.fn()
  renderWithProviders(
    <ColleaguesTab
      me={me}
      initiator="per_wang"
      members={MEMBERS}
      invites={[]}
      requests={[]}
      busy={false}
      onCreateInvite={() => undefined}
      onDecide={() => undefined}
      onRemove={() => undefined}
      onLeave={onLeave}
      onExport={() => undefined}
      workspaceId="ws_1"
      onOfferInitiator={onOfferInitiator}
      onWithdrawOffer={onWithdrawOffer}
      {...extra}
    />,
  )
  return [onLeave, onOfferInitiator, onWithdrawOffer]
}

beforeEach(() => {
  state.personal = []
  getPositionCards.mockClear()
})

describe('WP278 交出发起人（决策 276）', () => {
  it('发起人自己那一行「把发起人交给…」→ 挑一位同事；对方接下才换（问号里说）', async () => {
    const [, onOfferInitiator] = tab('per_wang')
    const give = await screen.findByTestId('initiator-give')
    expect(give.textContent).toBe('把发起人交给…')
    const row = give.closest('[data-testid="colleague-row"]') as HTMLElement
    expect(row.getAttribute('data-person')).toBe('per_wang')
    fireEvent.click(give)
    const pick = screen.getByTestId('initiator-pick')
    // 只列别人
    expect(within(pick).queryByText('王岚')).toBeNull()
    fireEvent.click(within(pick).getByText('李默'))
    expect(onOfferInitiator).toHaveBeenCalledWith('per_li')
  })

  it('还在等：那一行是「等 李默 接 · 撤回」；没接的一行结果；不是发起人没有入口', async () => {
    const [, , onWithdrawOffer] = tab('per_wang', { offers: [offer({})] })
    const waiting = await screen.findByTestId('initiator-waiting')
    expect(waiting.textContent).toContain('等 李默 接')
    expect(screen.queryByTestId('initiator-give')).toBeNull()
    fireEvent.click(screen.getByTestId('initiator-withdraw'))
    expect(onWithdrawOffer).toHaveBeenCalledWith('ap_offer')
  })

  it('没接：一行「李默 没接：太忙」，入口还在', async () => {
    tab('per_wang', { offers: [offer({ state: 'declined', reason: '太忙' })] })
    expect((await screen.findByTestId('initiator-ended')).textContent).toBe('李默 没接：太忙')
    expect(screen.getByTestId('initiator-give')).toBeDefined()
  })

  it('不是发起人：没有「把发起人交给…」', async () => {
    tab('per_li')
    await screen.findAllByTestId('colleague-row')
    expect(screen.queryByTestId('initiator-give')).toBeNull()
  })
})

describe('WP278 退出先问一句（决策 278）', () => {
  it('列出会断开的个人连接；确认了才退，取消不退', async () => {
    state.personal = [{ id: 'conn_1', label: '任意邮箱（IMAP / SMTP） · lin@private.cn' }]
    const [onLeave] = tab('per_li')
    fireEvent.click(await screen.findByTestId('team-leave'))
    const dialog = await screen.findByTestId('leave-confirm')
    const items = await within(dialog).findAllByTestId('leave-personal-item')
    expect(items.map((x) => x.textContent)).toEqual(['任意邮箱（IMAP / SMTP） · lin@private.cn'])
    expect(dialog.textContent).toContain('共用的留下')
    fireEvent.click(within(dialog).getByText('取消'))
    expect(onLeave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('team-leave'))
    const ok = (await screen.findByTestId('leave-confirm-ok')) as HTMLButtonElement
    // 列表读回来之前按钮不能点（先看清楚再退）
    await waitFor(() => {
      expect(ok.disabled).toBe(false)
    })
    fireEvent.click(ok)
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('没有个人连接：框里不出那一段', async () => {
    tab('per_li')
    fireEvent.click(await screen.findByTestId('team-leave'))
    const dialog = await screen.findByTestId('leave-confirm')
    await waitFor(() => {
      expect((within(dialog).getByTestId('leave-confirm-ok') as HTMLButtonElement).disabled).toBe(
        false,
      )
    })
    expect(within(dialog).queryByTestId('leave-personal')).toBeNull()
  })
})

function initiatorOfferCard(): DeckCard {
  const options = [{ id: 'accept', label: '接下' }]
  const base = draftCard()
  return draftCard({
    id: 'ap_init',
    kind: 'claim',
    layout: 'handoff',
    title: '王岚想把发起人交给你',
    summary: '接下后请人离开、删品牌、搬数据这些家务归你管。',
    content_variants: { zh_summary: '接下后请人离开、删品牌、搬数据这些家务归你管。' },
    options,
    available_actions: ['approve', 'reject', 'open'],
    detail: {
      ...base.detail,
      payload: {
        form: 'handoff',
        object: 'initiator',
        id: 'org_1',
        title: '发起人',
        from_label: '王岚',
        what: '接下后请人离开、删品牌、搬数据这些家务归你管。',
        expires_at: '2026-10-12T09:00:00.000Z',
        options,
        takes: [],
      },
      proposer: { kind: 'person', id: 'per_wang' },
    },
  })
}

describe('WP278 「把发起人交给你」那张卡', () => {
  it('一个「接下」+「不接」；类别「交给你的」；那一句只说一遍；点接下选的是 accept', () => {
    const onDecide = vi.fn()
    renderWithProviders(
      <DeckCardView
        card={initiatorOfferCard()}
        mode="zh_summary"
        onDecide={onDecide}
        onOpen={() => undefined}
      />,
    )
    const card = screen.getByTestId('deck-card')
    expect(card.textContent).toContain('交给你的')
    expect(card.textContent?.split('家务归你管').length).toBe(2)
    const decide = screen.getByTestId('deck-handoff')
    expect(
      within(decide)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['接下', '不接'])
    fireEvent.click(within(decide).getByText('接下'))
    expect(onDecide).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'approve', selected_option_id: 'accept' }),
    )
  })
})

const conn = (over: Partial<ConnectionView>): ConnectionView => ({
  id: 'conn_1',
  service: 'imap_smtp',
  service_label: '任意邮箱（IMAP / SMTP）',
  alias: 'lin@private.cn',
  ownership: 'workspace',
  status: 'active',
  credential_store: 'local_vault',
  data_sources: [],
  ...over,
})

describe('WP278 连接页「个人」开关', () => {
  it('自己接的那条有开关，拨一下标「个人」；别人接的没有', () => {
    const onPersonal = vi.fn()
    const { unmount } = renderWithProviders(
      <ul>
        <ConnectedRow
          connection={conn({ mine: true, service: 'shopify_admin', service_label: 'Shopify' })}
          busy={undefined}
          onTest={() => undefined}
          onDisconnect={() => undefined}
          onPersonal={onPersonal}
        />
      </ul>,
    )
    const box = screen.getByTestId('connection-personal')
    expect(box.textContent).toContain('个人')
    fireEvent.click(within(box).getByRole('switch'))
    expect(onPersonal).toHaveBeenCalledWith(true)
    unmount()
    renderWithProviders(
      <ul>
        <ConnectedRow
          connection={conn({ mine: false, service: 'shopify_admin', service_label: 'Shopify' })}
          busy={undefined}
          onTest={() => undefined}
          onDisconnect={() => undefined}
          onPersonal={onPersonal}
        />
      </ul>,
    )
    expect(screen.queryByTestId('connection-personal')).toBeNull()
  })
})

describe('WP278 只有一个岗位的人看得到底座卡（决策 284）', () => {
  it('第一条职责带 base，其余不带；同一张卡只出一次', async () => {
    const { DeckSection } = await import('@/components/deck')
    const shared = draftCard({ id: 'ap_base', title: '陈一想和你们一起用' })
    getPositionCards.mockImplementation(async (...args: unknown[]) => {
      const id = args[0] as string
      // 两条职责的请求都带回同一张底座卡（服务端按人收）：合牌时只留一份
      return {
        position: {
          position_id: id,
          role_id: 'b2b.sales',
          role_name: '外贸业务',
          ranges: [],
          ready: true,
          missing_connectors: [],
          tile_ids: [],
          range: 'yesterday',
          show_tiles: false,
        },
        cards: [draftCard({ id: `ap_${id}`, position_id: id }), shared],
        filters: {},
        counts: { total: 2, customer_waiting: 0, nobody_waiting: 0, matched: 2 },
        pinned_p0: [],
      }
    })
    renderWithProviders(
      <DeckSection
        positionId="asg_1"
        positionIds={['asg_1', 'asg_2']}
        withBase
        onOpen={() => undefined}
      />,
    )
    expect((await screen.findByTestId('deck-progress')).textContent).toBe('第 1 / 3 张')
    expect(getPositionCards).toHaveBeenCalledWith('asg_1', {}, true)
    expect(getPositionCards).toHaveBeenCalledWith('asg_2', {})
  })
})

describe('WP278 键盘提示与按钮一致', () => {
  it('「把发起人交给你」那张卡：→ 接下 · ← 不接', async () => {
    const { DeckSection } = await import('@/components/deck')
    getPositionCards.mockImplementation(async () => ({
      position: {
        position_id: 'asg_1',
        role_id: 'b2b.sales',
        role_name: '外贸业务',
        ranges: [],
        ready: true,
        missing_connectors: [],
        tile_ids: [],
        range: 'yesterday',
        show_tiles: false,
      },
      cards: [initiatorOfferCard()],
      filters: {},
      counts: { total: 1, customer_waiting: 0, nobody_waiting: 0, matched: 1 },
      pinned_p0: [],
    }))
    renderWithProviders(<DeckSection positionId="asg_1" onOpen={() => undefined} />)
    expect((await screen.findByTestId('deck-keyboard')).textContent).toBe('→ 接下 · ← 不接')
  })
})
