/**
 * WP69（54）：把**岗位入口**接进模拟世界。
 *
 * 与 `secretary` / `chat` / `learning` 一样是**惰性**的：场景里没有 `position.*` 事件
 * 就一个都不装，原有场景的事件序列与指标一个字节不变。
 *
 * 这一份只做三件事，别的都不做：
 *
 * 1. **配岗**（`staff`）：把一个岗位模板的默认职责一次挂给一个人——46 §1 ③「勾岗位 =
 *    它包含的职责全勾上」。路由要在**多条职责之间**做才有意义，所以场景得先有这一步。
 * 2. **路由**（`open`）：判据一个字都不在这里，全在 `@agentsws/roles` 的
 *    `routeWithinPosition`（与服务进程、与秘书是同一份）。这里只负责把"这个人在这个
 *    岗位下持有哪几条职责"递进去。
 * 3. **起 Run 或出选择卡**：判准了就用**被路由到的那条职责的分配**起 Run（05 §4 不并集——
 *    不是岗位的权限，是那一条的）；拿不准就出一张选择卡，不猜。
 */
import type { ApprovalItem, Assignment, PersonId, RoleId } from '@agentsws/contracts'
import {
  loadBundledPosition,
  type Position,
  type RouteCandidate,
  roleRouteTerms,
  routeWithinPosition,
} from '@agentsws/roles'
import type { World } from './world.js'

export interface PositionRouteRecord {
  position_id: string
  who: PersonId
  picked?: RoleId
  assignment_id?: string
  ambiguous: boolean
  candidates: RouteCandidate[]
  matter_id: string
  approval_item_id?: string
  run_id?: string
}

export interface PositionsLoop {
  /** 把一个岗位模板的默认职责一次挂给一个人（已经有的那条不重复挂）。 */
  staff(who: PersonId, position_id: string): { role_id: RoleId; assignment_id: string }[]
  /** 交给这个岗位一件事。 */
  open(input: { who: PersonId; position_id: string; text: string }): Promise<PositionRouteRecord>
  /** 路由记录（场景的 `position_routed_to` 断言读它）。 */
  routed: PositionRouteRecord[]
}

export function installPositions(world: World): PositionsLoop {
  const routed: PositionRouteRecord[] = []

  /**
   * 岗位模板从 `packages/roles/positions/*.yml` 读——**模板是制度层的真源**，
   * 模拟层不复制一份（复制一份就会漂移，而这条场景要证的正是"改了模板路由跟着变"）。
   */
  const cache = new Map<string, Position>()
  const templateOf = (position_id: string): Position => {
    const hit = cache.get(position_id)
    if (hit !== undefined) return hit
    const made = loadBundledPosition(position_id)
    cache.set(position_id, made)
    return made
  }

  const activeOf = (who: PersonId): Assignment[] =>
    world.roles.assignments
      .listByPerson(who, { workspace_id: world.workspace_id })
      .filter((a) => a.revoked_at === undefined)

  const staff: PositionsLoop['staff'] = (who, position_id) => {
    const template = templateOf(position_id)
    const out: { role_id: RoleId; assignment_id: string }[] = []
    for (const entry of template.roles) {
      if (!entry.default) continue
      // 这台机器上没有这条职责的定义就跳过（与 `org.ts` 种岗位时同一条规则）
      if (world.roles.roles.get(entry.role) === undefined) continue
      const existing = activeOf(who).find((a) => a.role_id === entry.role)
      if (existing !== undefined) {
        out.push({ role_id: entry.role, assignment_id: existing.id })
        continue
      }
      const made = world.roles.assignments.create({
        person_id: who,
        workspace_id: world.workspace_id,
        role_id: entry.role,
        granted_by: who,
        ranges: [...world.assignment.ranges],
      })
      // 05 §4 的"不做并集"断言数的是世界建出来的分配，现配的这条也要登记进去
      world.registerAssignment(made)
      out.push({ role_id: entry.role, assignment_id: made.id })
    }
    return out
  }

  const open: PositionsLoop['open'] = async ({ who, position_id, text }) => {
    const template = templateOf(position_id)
    const held = activeOf(who).filter((a) => template.roles.some((r) => r.role === a.role_id))
    const profiles = held
      .map((a) => {
        const def = world.roles.roles.get(a.role_id)
        return def === undefined
          ? undefined
          : {
              role_id: def.id,
              role_name: def.name.zh,
              terms: roleRouteTerms(def),
              positions: [{ position_id: a.id, person_id: who }],
            }
      })
      .filter((p) => p !== undefined)
    const verdict = routeWithinPosition(text, profiles)
    const picked =
      verdict.picked === undefined ? undefined : held.find((a) => a.role_id === verdict.picked)

    const matter = world.work.createMatter({
      kind: 'adhoc',
      title: text,
      entry: 'position',
      position_template_id: template.id,
      participants: [who],
      ...(picked === undefined ? {} : { position_id: picked.id, role_id: picked.role_id }),
    })
    world.work.appendEvent(matter.id, {
      kind: 'status',
      text: verdict.reason,
      actor: { kind: 'agent', id: 'position_router' },
      ref: { type: 'position', id: template.id },
    })

    const record: PositionRouteRecord = {
      position_id: template.id,
      who,
      ambiguous: verdict.ambiguous,
      candidates: verdict.candidates,
      matter_id: matter.id,
      ...(picked === undefined ? {} : { picked: picked.role_id, assignment_id: picked.id }),
    }

    if (picked === undefined) {
      // 拿不准就问一句：一张选择卡，选项就是候选职责（54 §2）
      const item = await choiceCard({ who, position: template.id, matter_id: matter.id, verdict })
      if (item !== undefined) record.approval_item_id = item.id
      world.appendEvent('simulation.position_ambiguous', {
        position_id: template.id,
        candidates: verdict.candidates.map((c) => ({ role_id: c.role_id, score: c.score })),
        ...(item === undefined ? {} : { approval_item_id: item.id }),
      })
      routed.push(record)
      return record
    }

    // 起 Run：用的是**被路由到的那条职责**的分配（权限 / 额度 / 技能全是它的）
    const said = await world.work.say(matter.id, {
      person_id: who,
      assignment_id: picked.id,
      text,
    })
    if (said.run_id !== undefined) record.run_id = said.run_id
    world.appendEvent('simulation.position_routed', {
      position_id: template.id,
      role_id: picked.role_id,
      assignment_id: picked.id,
      candidates: verdict.candidates.length,
    })
    routed.push(record)
    return record
  }

  const choiceCard = async (input: {
    who: PersonId
    position: string
    matter_id: string
    verdict: ReturnType<typeof routeWithinPosition>
  }): Promise<ApprovalItem | undefined> => {
    const first = input.verdict.candidates[0]
    const item = await world.txn.approvals.create({
      workspace_id: world.workspace_id,
      schema_version: 1,
      kind: 'claim',
      role_id: first?.role_id ?? 'common.member',
      subject: {
        object: { type: 'position', id: input.position },
        matter_id: input.matter_id,
        work_item_id: input.matter_id,
      },
      dedupe_key: `${world.workspace_id}:route_choice:${input.matter_id}`,
      title: `这件事该走哪条职责`,
      summary: input.verdict.reason,
      payload: {
        form: 'route_choice',
        matter_id: input.matter_id,
        position_id: input.position,
        candidates: input.verdict.candidates,
      },
      evidence: {
        source_events: [],
        provenance: { seen: [{ type: 'position', id: input.position }] },
        precheck: { fencing: 'ok' },
      },
      proposer: { kind: 'agent', id: 'position_router' },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: input.who, via: 'explicit' }],
        explicit: input.who,
        rule: 'explicit',
        escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
      options: input.verdict.candidates.map((c) => ({ id: c.role_id, label: c.role_name })),
    })
    return item.state === 'blocked' ? undefined : item
  }

  return { staff, open, routed }
}
