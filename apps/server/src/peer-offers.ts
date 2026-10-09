/**
 * WP278（docs/95 §4 / §7 C 收尾，决策 276 / 277）：② 里**要对方接下才算**的两件事。
 *
 * 1. **把发起人交给同事**（决策 276）：发起人在「同事」tab 自己那一行点「把发起人交给…」，选一位同事。
 *    对方收一张与 WP276 交给对方同一张的「交给你」卡（`claim`、`form: 'handoff'`、`object: 'initiator'`），
 *    **接下才换**：所有者身份走 WP277 老板转所有者那一条路（`transferOwnership`），原发起人变普通同事
 *    （之后他可以自己退出）。③ 里不走这里（③ 是老板 / 管理员那一套）。
 * 2. **请同事一起做一个岗位**（决策 277）：发起人在岗位卡上「请同事一起做」→ 对方收同一张卡
 *    （`object: 'position'`），**接下前分配不生效**；接下那一刻才按岗位分给他（② 里不挑范围 = 整个品牌）。
 *
 * 没有另起一张表：卡就是记录（`payload` 里记着交给谁、交什么），状态读卡的状态——还在等 = `offered`、
 * 通过 = `accepted`、不接 = `declined`、到点 = `returned`（卡过期，审批总线本来的 `expire`）、撤回 = `withdrawn`。
 * 到点退回与 WP276 一样是懒扫：读「我发出去的」时顺手让过期的卡过期，不起定时器。
 */
import type { AssignInput, OrgActor, PeerOfferKind, PeerOfferView } from '@agentsws/api'
import { ApiError, type LocalIdentityService } from '@agentsws/api'
import type {
  ApprovalBus,
  ApprovalItem,
  ApprovalState,
  Clock,
  EventEnvelope,
  Organization,
  OrganizationMode,
  PersonId,
  Position,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import { HANDOFF_DECLINE_NO_REASON } from '@agentsws/deck'
import type { RoleStore } from '@agentsws/roles'
import { transferOwnership } from './company-mode.js'
import { OWNER_POSITION_ID } from './position-placements.js'

/** 卡上唯一的那个「接下」。 */
export const PEER_OFFER_ACCEPT = 'accept'
/** 没接 / 退回之后，在「我发出去的」里还留几天（让发的人看得到结果）。 */
const ENDED_VISIBLE_DAYS = 3

const OPEN: ApprovalState[] = ['pending', 'in_review']
const ALL: ApprovalState[] = [
  'pending',
  'in_review',
  'approved',
  'approved_edited',
  'auto_approved',
  'applying',
  'applied',
  'apply_failed',
  'rejected',
  'expired',
  'withdrawn',
  'superseded',
  'deferred',
]

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

/** 这张卡是不是「把发起人交给你 / 请你一起做」。 */
export function isPeerOffer(item: Pick<ApprovalItem, 'kind' | 'payload'>): boolean {
  const p = asRecord(item.payload)
  return (
    item.kind === 'claim' &&
    p.form === 'handoff' &&
    (p.object === 'initiator' || p.object === 'position')
  )
}

const stateOf = (item: ApprovalItem): PeerOfferView['state'] => {
  switch (item.state) {
    case 'pending':
    case 'in_review':
      return 'offered'
    case 'rejected':
      return 'declined'
    case 'expired':
      return 'returned'
    case 'withdrawn':
    case 'superseded':
      return 'withdrawn'
    default:
      return 'accepted'
  }
}

export interface PeerOffersOptions {
  workspace_id: WorkspaceId
  clock: Clock
  identity: LocalIdentityService
  roles: RoleStore
  approvals: ApprovalBus
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 这个品牌现在是哪种用法。 */
  mode(): Promise<OrganizationMode>
  /** 这个品牌挂在哪一家下面（发起人 = 它的所有者）。 */
  organization(): Organization | undefined
  /** 交出去几天没人理退回（与交给对方同一格：「设置 → 通用」）。 */
  days(): number
  /** 岗位模板（名字、在不在）。 */
  positions(): Position[]
  /** 这个岗位现在谁在做（已经在做 = 不用再请）。 */
  holders(position_id: string): Promise<PersonId[]>
  /** 真分岗位（接下那一刻才调；就是岗位卡上原来那条「分给他」）。 */
  assign(actor: OrgActor, input: AssignInput): Promise<unknown>
}

export interface PeerOffers {
  offerInitiator(actor: OrgActor, input: { person_id: string }): Promise<PeerOfferView>
  offerPosition(
    actor: OrgActor,
    position_id: string,
    input: { person_id: string },
  ): Promise<PeerOfferView>
  list(actor: OrgActor): Promise<{ offers: PeerOfferView[] }>
  withdraw(actor: OrgActor, id: string): Promise<PeerOfferView>
  /** 对方在卡上点了（审批总线 decide 之后调）。 */
  onDecided(item: ApprovalItem): Promise<void>
}

export function createPeerOffers(options: PeerOffersOptions): PeerOffers {
  const { identity, roles, approvals, clock, workspace_id } = options

  const nameOf = async (id: string): Promise<string> =>
    (await identity.getPerson(id as PersonId))?.name || '同事'

  const members = async (): Promise<PersonId[]> =>
    (await identity.members(workspace_id))
      .filter((m) => m.left_at === undefined)
      .map((m) => m.person_id)

  const orgOf = (): Organization | undefined => options.organization()
  const initiatorOf = (): PersonId | undefined => orgOf()?.owner_id

  const emit = (
    type: EventEnvelope['type'],
    subject: { type: string; id: string },
    by: string,
    payload: Record<string, unknown>,
  ): void =>
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'person', id: by },
      subject,
      correlation: { trace_id: `tr_offer_${clock.now()}` },
      payload,
    } as Omit<EventEnvelope, 'id' | 'at'>)

  /** 卡挂在他自己做的一条职责上（只有一个岗位的人那个岗位页筛得到）；一条都没做就挂底座。 */
  const roleFor = (person: PersonId): RoleId =>
    roles.assignments
      .listByPerson(person, { workspace_id })
      .find((a) => a.revoked_at === undefined && !a.role_id.startsWith('common.'))?.role_id ??
    'common.member'

  /** 我发出去的这两种（每个人的队列里找，去重）。 */
  const cardsFrom = async (from: PersonId, states: ApprovalState[]): Promise<ApprovalItem[]> => {
    const seen = new Map<string, ApprovalItem>()
    const people = new Set([...(await members()), from])
    for (const person of people)
      for (const item of (await approvals.queue({
        workspace_id,
        person_id: person,
        lane: 'mine',
        state: states,
      })) as ApprovalItem[])
        if (isPeerOffer(item) && item.proposer.id === from) seen.set(item.id, item)
    return [...seen.values()]
  }

  /** 到点没人理的：让审批总线按它本来的办法过期（懒扫，同 WP276）。 */
  const sweep = async (cards: ApprovalItem[]): Promise<boolean> => {
    const now = clock.now()
    const due = cards.some(
      (c) => OPEN.includes(c.state) && c.expires_at !== undefined && c.expires_at <= now,
    )
    if (!due) return false
    for (const item of await approvals.expire(now))
      if (isPeerOffer(item)) {
        const p = asRecord(item.payload)
        emit('handoff.returned', { type: String(p.object), id: String(p.id) }, item.proposer.id, {
          object: p.object,
          from: item.proposer.id,
          to: p.to,
        })
      }
    return true
  }

  const viewOf = async (item: ApprovalItem): Promise<PeerOfferView> => {
    const p = asRecord(item.payload)
    const to = String(p.to ?? '')
    const reason = item.state === 'rejected' ? item.decision?.reason : undefined
    return {
      id: item.id,
      kind: p.object === 'initiator' ? 'initiator' : 'position',
      from: item.proposer.id,
      from_name: await nameOf(item.proposer.id),
      to,
      to_name: await nameOf(to),
      ...(p.object === 'position'
        ? { position_id: String(p.id), position_name: String(p.position_name ?? '') }
        : {}),
      state: stateOf(item),
      ...(reason === undefined || reason === '' || reason === HANDOFF_DECLINE_NO_REASON
        ? {}
        : { reason }),
      ...(item.expires_at === undefined ? {} : { expires_at: item.expires_at }),
      at: item.updated_at ?? item.created_at,
    }
  }

  /** 只有 ②、只有发起人；对方要是这个品牌里还在的别人。 */
  const guard = async (actor: OrgActor, to: string): Promise<void> => {
    if ((await options.mode()) !== 'peers')
      throw new ApiError('conflict', '只有和同事一起用的时候才这样交')
    if (initiatorOf() !== actor.person_id) throw new ApiError('forbidden', '只有发起人能这样交')
    if (to === actor.person_id) throw new ApiError('invalid_input', '不能交给自己')
    if (!(await members()).includes(to as PersonId))
      throw new ApiError('invalid_input', '只能交给这个品牌里的同事')
  }

  const issue = async (
    actor: OrgActor,
    kind: PeerOfferKind,
    to: PersonId,
    target: { id: string; name?: string },
  ): Promise<ApprovalItem> => {
    const from = actor.person_id as PersonId
    const fromName = await nameOf(from)
    const days = Math.max(1, options.days())
    const expires_at = new Date(Date.parse(clock.now()) + days * 86_400_000).toISOString()
    const title =
      kind === 'initiator'
        ? `${fromName}想把发起人交给你`
        : `${fromName}请你一起做「${target.name ?? target.id}」`
    // 卡上只说接下以后会怎样，一句（不重复标题）
    const summary =
      kind === 'initiator'
        ? '接下后请人离开、删品牌、搬数据这些家务归你管。'
        : '接下后这个岗位的活也会派给你。'
    const item = (await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'claim',
      role_id: roleFor(to),
      subject: {
        object: { type: kind === 'initiator' ? 'organization' : 'position', id: target.id },
      },
      dedupe_key: `${workspace_id}:peer_offer:${kind}:${target.id}:${to}:${clock.now()}`,
      title,
      summary,
      payload: {
        form: 'handoff',
        object: kind,
        id: target.id,
        to,
        title: kind === 'initiator' ? '发起人' : (target.name ?? target.id),
        from_label: fromName,
        // 卡面上那一句（接下以后会怎样）
        what: summary,
        ...(target.name === undefined ? {} : { position_name: target.name }),
        expires_at,
        options: [{ id: PEER_OFFER_ACCEPT, label: '接下' }],
        takes: [],
      },
      evidence: {
        source_events: [],
        provenance: { seen: [] },
        precheck: { fencing: 'ok' },
      },
      proposer: { kind: 'person', id: from },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: to, via: 'explicit' }],
        explicit: to,
        rule: 'explicit',
        // ② 没有升级链：没人理到点退回
        escalation: { after_hours: 24, business_hours: true, chain: [], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
      expires_at,
    })) as ApprovalItem
    if (item.state === 'blocked') throw new ApiError('conflict', '这张卡没发出去，稍后再试')
    emit('handoff.offered', { type: kind, id: target.id }, from, {
      object: kind,
      from,
      to,
      expires_at,
    })
    return item
  }

  return {
    async offerInitiator(actor, input) {
      await guard(actor, input.person_id)
      const org = orgOf()
      if (org === undefined) throw new ApiError('not_found', '这个品牌还没挂在哪一家下面')
      const waiting = (await cardsFrom(actor.person_id as PersonId, OPEN)).find(
        (c) => asRecord(c.payload).object === 'initiator',
      )
      if (waiting !== undefined)
        throw new ApiError(
          'conflict',
          `已经在等${await nameOf(String(asRecord(waiting.payload).to))}接了`,
        )
      return viewOf(await issue(actor, 'initiator', input.person_id as PersonId, { id: org.id }))
    },

    async offerPosition(actor, position_id, input) {
      await guard(actor, input.person_id)
      // 「负责人」那一行是身份（docs/54 §6.5），不是一个能请人一起做的岗位——交它走「把发起人交给…」
      if (position_id === OWNER_POSITION_ID)
        throw new ApiError('invalid_input', '负责人不是岗位，要交请用「把发起人交给…」')
      const position = options.positions().find((p) => p.id === position_id)
      if (position === undefined) throw new ApiError('not_found', `没有这个岗位：${position_id}`)
      if ((await options.holders(position_id)).includes(input.person_id as PersonId))
        throw new ApiError('conflict', '他已经在做这个岗位了')
      const waiting = (await cardsFrom(actor.person_id as PersonId, OPEN)).some((c) => {
        const p = asRecord(c.payload)
        return p.object === 'position' && p.id === position_id && p.to === input.person_id
      })
      if (waiting) throw new ApiError('conflict', '已经在等他接了')
      return viewOf(
        await issue(actor, 'position', input.person_id as PersonId, {
          id: position_id,
          name: position.name.zh,
        }),
      )
    },

    async list(actor) {
      const from = actor.person_id as PersonId
      let cards = await cardsFrom(from, ALL)
      if (await sweep(cards)) cards = await cardsFrom(from, ALL)
      const since = Date.parse(clock.now()) - ENDED_VISIBLE_DAYS * 86_400_000
      const shown = cards.filter((c) => {
        const s = stateOf(c)
        if (s === 'offered') return true
        if (s !== 'declined' && s !== 'returned') return false
        return Date.parse(c.updated_at ?? c.created_at) >= since
      })
      const offers = await Promise.all(shown.map(viewOf))
      return { offers: offers.sort((a, b) => b.at.localeCompare(a.at)) }
    },

    async withdraw(actor, id) {
      const card = await approvals.get(id)
      if (card === undefined || !isPeerOffer(card) || card.workspace_id !== workspace_id)
        throw new ApiError('not_found', '没有这一条')
      if (card.proposer.id !== actor.person_id) throw new ApiError('forbidden', '只有发的人能撤回')
      if (!OPEN.includes(card.state)) throw new ApiError('conflict', '对方已经定了')
      const out = (await approvals.withdraw(id, actor.person_id as PersonId)) as ApprovalItem
      const p = asRecord(card.payload)
      emit('handoff.withdrawn', { type: String(p.object), id: String(p.id) }, actor.person_id, {
        object: p.object,
        from: actor.person_id,
        to: p.to,
      })
      return viewOf(out)
    },

    async onDecided(item) {
      if (!isPeerOffer(item) || item.workspace_id !== workspace_id) return
      const by = item.decision?.by
      if (by === undefined || by === 'mandate') return
      const p = asRecord(item.payload)
      const from = item.proposer.id as PersonId
      const subject = { type: String(p.object), id: String(p.id) }
      if (item.state === 'rejected') {
        // 不接的理由只在卡上，不进事件日志（同 WP276）
        emit('handoff.declined', subject, by, { object: p.object, from, to: by })
        return
      }
      if (stateOf(item) !== 'accepted' || p.to !== by) return
      if ((await options.mode()) !== 'peers') return
      if (!(await members()).includes(by)) return
      if (p.object === 'initiator') {
        const org = orgOf()
        // 交的那一刻之后发起人已经换过了（或这家已经不在）：这张卡作废，什么都不动
        if (org === undefined || org.id !== p.id || org.owner_id !== from) return
        await transferOwnership({ identity, roles }, org, by, from, { demote: true })
      } else {
        const position_id = String(p.id)
        if (!options.positions().some((x) => x.id === position_id)) return
        if (!(await options.holders(position_id)).includes(by))
          await options.assign(
            { workspace_id, person_id: from, assignment_id: '', role_id: 'common.owner' },
            { person_id: by, position_id, ranges: [], range_groups: [] },
          )
      }
      emit('handoff.accepted', subject, by, { object: p.object, from, to: by })
    },
  }
}
