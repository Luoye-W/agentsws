/**
 * WP277（docs/95 §3.4–§3.6 / §7 D 单，决策 222 / 239 / 240 / 241）：**开公司模式、降回同事互联**。
 *
 * 公司模式只能由人主动开，人多了也不会自己变过去（WP271 的「模式」存的就是这个意图）。这一层做四件事：
 *
 * 1. **开**（只有发起人 = 组织所有者）：公司全称（必填）、谁是老板（默认发起人）、管理员（可不选）。
 *    品牌里的同事进组织名单（身份从「同事」变「成员」，手上的岗位、事项、待办一样不变）；之后新出的卡
 *    按规矩路由（WP275 的 `hasApprovalFlow`），之前已出的卡不改派。
 * 2. **同事收卡**（决策 239）：每位同事一张「知道了 / 我要退出」。退出 = ② 的退出（个人渠道跟人走、
 *    共享品牌里的东西留下、手上的事退回原处），不是 ③ 的离职；退之前可以导出自己建的那份副本。
 * 3. **降回 ②**（决策 240，只有老板）：上级、范围、额度、管理员这些**一行不删**（收起，再开原样回来）；
 *    还没定、正等主管 / 老板的卡退回给「这件事是谁的」那个人（`returnOnDowngrade`，模拟世界同一份）；
 *    同事收一行通知（不是卡：组织视图上的 `mode_changed_by`）。离职交接没做完的时候不让降。
 * 4. 事件 `organization.mode_changed`：只记模式、谁、几个数，不记任何名字。
 */
import type {
  CompanyModeView,
  LocalIdentityService,
  OrganizationActor,
  SetOrganizationModeInput,
} from '@agentsws/api'
import { ApiError, organizationRoleOf } from '@agentsws/api'
import type {
  ApprovalBus,
  ApprovalItem,
  Clock,
  EventEnvelope,
  Organization,
  OrganizationMode,
  PersonId,
  WorkspaceId,
} from '@agentsws/contracts'
import { type RoleStore, returnOnDowngrade } from '@agentsws/roles'

/** 同事收的那张卡（`policy_change` 类，选项直接是两个按钮）。 */
export const COMPANY_NOTICE_FORM = 'company_notice'
/** 卡上两个选项的 id。 */
export const COMPANY_NOTICE_ACK = 'ack'
export const COMPANY_NOTICE_LEAVE = 'leave'

/** 降回 ② 时退回的卡上那一句（界面上是卡头下面一行灰字）。 */
export const RETURNED_REASON = '改回同事互联，退回给你'

export interface CompanyModeOptions {
  clock: Clock
  identity: LocalIdentityService
  roles: RoleStore
  approvals: ApprovalBus
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 这个组织现在是哪种用法（`organizations.modeOf` 那一个口）。 */
  modeOf(workspace_id: WorkspaceId): Promise<OrganizationMode>
  /**
   * 同事点了「我要退出」：按 ② 的退出走（`org.optOut`）。只管装配的那个品牌；别的品牌的成员关系
   * 在这里跟着收。
   */
  optOut(person_id: PersonId): Promise<unknown>
}

export interface CompanyMode {
  setup(actor: OrganizationActor, org_id: string): Promise<CompanyModeView>
  set(actor: OrganizationActor, org_id: string, input: SetOrganizationModeInput): Promise<void>
  /** 点掉「X 把这里改回了同事互联」那一行。 */
  seen(actor: OrganizationActor, org_id: string): Promise<{ ok: true }>
  /** 这张卡是不是「X 把这里改成了公司模式」。 */
  isNotice(item: ApprovalItem): boolean
  /** 同事在那张卡上点了（审批总线 decide 之后调）。 */
  onNoticeDecided(item: ApprovalItem): Promise<void>
}

const OPEN: ApprovalItem['state'][] = ['pending', 'in_review']

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

/** 这张卡是不是开公司模式时同事收的那张「知道了 / 我要退出」。 */
export function isCompanyNotice(item: ApprovalItem): boolean {
  return item.kind === 'policy_change' && asRecord(item.payload).form === COMPANY_NOTICE_FORM
}

/** 离职交接（40 E2 的那几张、B2B 客户交接）还没做完：降回 ② 之前要先做完。 */
function isOffboarding(item: ApprovalItem): boolean {
  const p = asRecord(item.payload)
  if (p.target === 'offboard') return true
  return item.kind === 'staged_change' && p.kind === 'b2b_account_transfer'
}

export function createCompanyMode(options: CompanyModeOptions): CompanyMode {
  const { identity, roles, approvals, clock } = options

  const nameOf = async (id: PersonId): Promise<string> =>
    (await identity.getPerson(id))?.name || '同事'

  const needOrg = (id: string): Organization => {
    const org = identity.getOrganization(id)
    if (org === undefined) throw new ApiError('not_found', `公司不存在：${id}`)
    return org
  }

  /** 这家里还在的人：组织名单 + 各品牌成员（贴邀请码进来的只在品牌里）。 */
  const peopleOf = async (org: Organization): Promise<PersonId[]> => {
    const people = new Set<PersonId>(
      org.members.filter((m) => m.left_at === undefined).map((m) => m.person_id),
    )
    for (const w of identity.brandsOf(org.id))
      for (const m of await identity.members(w.id))
        if (m.left_at === undefined) people.add(m.person_id)
    return [...people]
  }

  /** 看这家要在里面（组织名单或某个品牌），不在一律 not_found。 */
  const needInside = async (org: Organization, person: PersonId): Promise<void> => {
    if ((await peopleOf(org)).includes(person)) return
    throw new ApiError('not_found', `公司不存在：${org.id}`)
  }

  const brandOf = (org: Organization): WorkspaceId | undefined => identity.brandsOf(org.id)[0]?.id

  const modeNow = async (org: Organization): Promise<OrganizationMode> => {
    const ws = brandOf(org)
    return ws === undefined ? 'solo' : options.modeOf(ws)
  }

  /** 这个人在哪个品牌里（卡发到他在的第一个品牌）。 */
  const homeOf = async (org: Organization, person: PersonId): Promise<WorkspaceId | undefined> => {
    for (const w of identity.brandsOf(org.id))
      if ((await identity.members(w.id)).some((m) => m.person_id === person && !m.left_at))
        return w.id
    return brandOf(org)
  }

  /** 每个品牌里还开着的卡（按人取「我的」那一栏，去重）。 */
  const openCards = async (org: Organization): Promise<ApprovalItem[]> => {
    const seen = new Map<string, ApprovalItem>()
    const people = await peopleOf(org)
    for (const w of identity.brandsOf(org.id))
      for (const person of people)
        for (const item of (await approvals.queue({
          workspace_id: w.id,
          person_id: person,
          lane: 'mine',
          state: OPEN,
        })) as ApprovalItem[])
          seen.set(item.id, item)
    return [...seen.values()]
  }

  const emit = (org: Organization, by: PersonId, payload: Record<string, unknown>): void => {
    const ws = brandOf(org)
    if (ws === undefined) return
    options.appendEvent({
      schema_version: 1,
      workspace_id: ws,
      type: 'organization.mode_changed',
      actor: { kind: 'person', id: by },
      correlation: { trace_id: `tr_mode_${clock.now()}` },
      payload: { organization_id: org.id, ...payload },
    })
  }

  /** 决策 239：每位同事一张「知道了 / 我要退出」（老板换了人：他那张只有「知道了」）。 */
  const notify = async (
    org: Organization,
    by: PersonId,
    to: readonly PersonId[],
    boss: PersonId,
  ): Promise<number> => {
    const byName = await nameOf(by)
    const at = clock.now()
    let sent = 0
    for (const person of to) {
      if (person === by) continue
      const ws = await homeOf(org, person)
      if (ws === undefined) continue
      const isBoss = person === boss
      const summary = isBoss
        ? `${byName}定了你是老板：以后超了授权的事、没设上级的岗位，都转给你批。`
        : '以后报价超限这类事要主管或老板批。'
      const item = (await approvals.create({
        workspace_id: ws,
        schema_version: 1,
        kind: 'policy_change',
        /*
         * 挂在他自己做的一条职责上：只有一个岗位的人首页就是那个岗位页，那里的「要你处理」按岗位里的
         * 职责筛卡——挂在底座职责上的卡他看不到。一条都没做（刚进来）才挂底座。
         */
        role_id:
          roles.assignments
            .listByPerson(person, { workspace_id: ws })
            .find((a) => a.revoked_at === undefined && !a.role_id.startsWith('common.'))?.role_id ??
          'common.member',
        subject: { object: { type: 'organization', id: org.id } },
        dedupe_key: `${ws}:company_notice:${org.id}:${person}:${at}`,
        title: `${byName}把这里改成了公司模式`,
        summary,
        payload: {
          target: 'organization_mode',
          form: COMPANY_NOTICE_FORM,
          organization_id: org.id,
          changed_by: by,
          options: isBoss
            ? [{ id: COMPANY_NOTICE_ACK, label: '知道了' }]
            : [
                { id: COMPANY_NOTICE_ACK, label: '知道了' },
                { id: COMPANY_NOTICE_LEAVE, label: '我要退出' },
              ],
        },
        evidence: {
          source_events: [],
          diff: { before: { mode: 'peers' }, after: { mode: 'company' }, summary },
          provenance: { seen: [] },
          precheck: { permission_diff: 'ok', semantic_diff: 'ok' },
        },
        proposer: { kind: 'person', id: by },
        automation: {
          level_at_creation: 'L1',
          auto_approved: false,
          mandate_check: { within: true, caps_hit: [] },
          sampling: { selected: false },
        },
        routing: {
          recipients: [{ person, via: 'explicit' }],
          explicit: person,
          rule: 'explicit',
          // 不升级：这是告诉他一声、让他选走不走，没人替他定
          escalation: { after_hours: 48, business_hours: true, chain: [], escalated_at: [] },
          separation_of_duties: false,
        },
        priority: 'queue',
      })) as ApprovalItem
      if (item.state !== 'blocked') sent += 1
    }
    return sent
  }

  const open = async (
    actor: OrganizationActor,
    org: Organization,
    input: SetOrganizationModeInput,
    from: OrganizationMode,
  ): Promise<void> => {
    if (org.owner_id !== actor.person_id) throw new ApiError('forbidden', '只有发起人能开公司模式')
    if (from === 'company') throw new ApiError('conflict', '已经是公司模式了')
    const legal_name = (input.legal_name ?? '').trim()
    if (legal_name === '') throw new ApiError('invalid_input', '公司全称要填')
    const people = await peopleOf(org)
    const boss = input.boss ?? actor.person_id
    if (!people.includes(boss)) throw new ApiError('invalid_input', '老板要是这里已经在的人')
    const admins = [...new Set(input.admins ?? [])].filter((p) => p !== boss)
    for (const p of admins)
      if (!people.includes(p)) throw new ApiError('invalid_input', '管理员要是这里已经在的人')

    // 身份从「同事」变「成员」：品牌里的人都进组织名单（已经在的一个字节不动）
    for (const p of people)
      if (p !== org.owner_id && organizationRoleOf(needOrg(org.id), p) === undefined)
        await identity.addOrganizationMember({ org_id: org.id, person_id: p })
    // 管理员：选了的设 admin；以前是管理员、这次没选的回 member（向导里带出的就是以前那几位）
    for (const p of people) {
      if (p === org.owner_id || p === boss) continue
      const role = organizationRoleOf(needOrg(org.id), p)
      const want = admins.includes(p) ? 'admin' : 'member'
      if (role !== want) await identity.setOrganizationMemberRole?.(org.id, p, want)
    }
    await identity.updateOrganization(org.id, {
      legal_name,
      mode: 'company',
      mode_changed_by: actor.person_id,
    })
    // 老板换了人：组织与各品牌的所有者一起换，新老板在各品牌里也有「负责人」那条
    const bossChanged = boss !== org.owner_id
    if (bossChanged) {
      await identity.transferOrganizationOwner?.(org.id, boss)
      for (const w of identity.brandsOf(org.id)) {
        const inside = (await identity.members(w.id)).some(
          (m) => m.person_id === boss && m.left_at === undefined,
        )
        if (!inside) continue
        const has = roles.assignments
          .listByPerson(boss, { workspace_id: w.id, role_id: 'common.owner' })
          .some((a) => a.revoked_at === undefined)
        if (!has)
          roles.assignments.create({
            person_id: boss,
            workspace_id: w.id,
            role_id: 'common.owner',
            granted_by: actor.person_id,
            ranges: [],
          })
      }
    }
    const notified = await notify(needOrg(org.id), actor.person_id, people, boss)
    emit(org, actor.person_id, {
      mode: 'company',
      from,
      admins: admins.length,
      ...(bossChanged ? { boss_changed: true } : {}),
      notified,
    })
  }

  const close = async (actor: OrganizationActor, org: Organization): Promise<void> => {
    if (org.owner_id !== actor.person_id) throw new ApiError('forbidden', '只有老板能改回同事互联')
    const cards = await openCards(org)
    const pendingOffboard = cards.filter(isOffboarding).length
    if (pendingOffboard > 0)
      throw new ApiError('conflict', `还有 ${pendingOffboard} 张离职交接没做完，先做完再改`)
    await identity.updateOrganization(org.id, { mode: 'peers', mode_changed_by: actor.person_id })
    // 决策 240：还没定、正等主管 / 老板的卡退回给「这件事是谁的」那个人
    const brandOfCard = new Map<string, Set<PersonId>>()
    for (const w of identity.brandsOf(org.id))
      brandOfCard.set(
        w.id,
        new Set((await identity.members(w.id)).filter((m) => !m.left_at).map((m) => m.person_id)),
      )
    let returned = 0
    let withdrawn = 0
    for (const card of cards) {
      // 开公司模式时发的「知道了 / 我要退出」：已经不是公司模式了，收掉
      if (isNoticeItem(card)) {
        try {
          await approvals.withdraw(card.id, actor.person_id)
          withdrawn += 1
        } catch {
          // 收不掉不影响降级本身
        }
        continue
      }
      const members = brandOfCard.get(card.workspace_id) ?? new Set<PersonId>()
      const back = returnOnDowngrade(card, {
        personOfAssignment: (id) => roles.assignments.get(id)?.person_id,
        isMember: (p) => members.has(p),
      })
      if (back === undefined || approvals.reroute === undefined) continue
      for (const from of back.from)
        await approvals.reroute(card.id, {
          from,
          to: back.self,
          via: 'role_holder',
          reason: RETURNED_REASON,
        })
      returned += 1
    }
    emit(org, actor.person_id, { mode: 'peers', from: 'company', returned, withdrawn })
  }

  const isNoticeItem = isCompanyNotice

  return {
    async setup(actor, org_id): Promise<CompanyModeView> {
      const org = needOrg(org_id)
      await needInside(org, actor.person_id)
      const mode = await modeNow(org)
      const people = await peopleOf(org)
      const cards = mode === 'company' ? await openCards(org) : []
      const offboarding = cards.filter(isOffboarding).length
      const isOwner = org.owner_id === actor.person_id
      return {
        mode,
        can_open: isOwner && mode !== 'company',
        can_close: isOwner && mode === 'company' && offboarding === 0,
        ...(mode === 'company' && offboarding > 0
          ? { close_blocked: `还有 ${offboarding} 张离职交接没做完` }
          : {}),
        legal_name: org.legal_name,
        owner_id: org.owner_id,
        people: await Promise.all(
          people.map(async (person_id) => ({
            person_id,
            name: await nameOf(person_id),
            role: organizationRoleOf(org, person_id) ?? 'member',
          })),
        ),
      }
    },

    async set(actor, org_id, input): Promise<void> {
      const org = needOrg(org_id)
      await needInside(org, actor.person_id)
      const from = await modeNow(org)
      if (input.mode === 'company') return open(actor, org, input, from)
      if (from !== 'company') throw new ApiError('conflict', '现在不是公司模式')
      return close(actor, org)
    },

    async seen(actor, org_id): Promise<{ ok: true }> {
      const org = needOrg(org_id)
      await needInside(org, actor.person_id)
      await identity.updateOrganization(org.id, { mode_seen: actor.person_id })
      return { ok: true }
    },

    isNotice: isNoticeItem,

    async onNoticeDecided(item): Promise<void> {
      if (!isNoticeItem(item)) return
      const by = item.decision?.by
      if (by === undefined || by === 'mandate') return
      const edited = asRecord(item.decision?.edited_payload)
      const picked = item.decision?.selected_option_id ?? edited.selected_option_id
      if (picked !== COMPANY_NOTICE_LEAVE) return
      const org = identity.getOrganization(String(asRecord(item.payload).organization_id))
      if (org === undefined || org.owner_id === by) return
      // 决策 239：按 ② 的退出走——手上的事退回原处、共享品牌里的东西留下
      await options.optOut(by)
      if (organizationRoleOf(needOrg(org.id), by) !== undefined)
        await identity.removeOrganizationMember(org.id, by)
      for (const w of identity.brandsOf(org.id))
        for (const a of roles.assignments.listByPerson(by, { workspace_id: w.id }))
          if (a.revoked_at === undefined) roles.assignments.revoke(a.id)
    },
  }
}
