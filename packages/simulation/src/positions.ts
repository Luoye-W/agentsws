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
 * 3. **起 Run**：用**被路由到的那条职责的分配**起 Run（05 §4 不并集——不是岗位的权限，是那一条的）。
 *    WP237：同一个人的几条职责打平按分取（`settleCloseCall`）；WP287：谁都不像也按分 / 先后取
 *    （`settleAlways`），岗位入口不再出选择卡（只剩一条能参赛的职责都没有时才出）。
 * 4. **三分**（WP291，决策 356）：这句话是当场问答、会话还是任务。服务进程先问便宜模型；模拟里那一次是
 *    **固定替身**（场景写 `judge`），不写就按 WP287 的规则判（与服务进程退回规则时同一份）。
 *    当场问答落在一件**隐身**的事项里（默认列表找不到它），回答是「一句话 + 组件」——模拟里那段回答由
 *    确定性的替身照 mock 店铺的商品现写（带 ```answer 组件段），再按契约同一份 `splitAnswer` 取出来；
 *    任务那一件原话后面头一句「记成了任务，按「X」做」。
 */
import type {
  AnswerComponent,
  ApprovalItem,
  Assignment,
  PersonId,
  RoleId,
} from '@agentsws/contracts'
import { splitAnswer } from '@agentsws/contracts'
import {
  type EntryKind,
  entryKindByRules,
  loadBundledPosition,
  type Position,
  type RouteCandidate,
  roleRouteTerms,
  routeWithinPosition,
  settleAlways,
  settleCloseCall,
  settleNoHit,
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
  open(input: {
    who: PersonId
    position_id: string
    text: string
    /** WP291：判断那一次的固定替身；不给按规则判 */
    judge?: EntryKind
  }): Promise<PositionRouteRecord>
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

  const open: PositionsLoop['open'] = async ({ who, position_id, text, judge }) => {
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
    // WP237：参赛的全是这个人自己的职责——打平（前两名都够像、只是分不开）按分取，不问人；
    // 谁都不太像 / 一个都没命中才出选择卡（与服务进程同一个判据，`@agentsws/roles`）
    // WP237（Fable 代定）：一个都没命中也按岗位里职责的先后取第一条
    const ordered = template.roles
      .map((r) => profiles.find((p) => p.role_id === r.role))
      .filter((p) => p !== undefined)
    // WP287（Luoye 10-09 真机）：岗位入口**永远不出选择卡**——几条都沾一点、谁都不像也按分 / 先后取
    // （`settleAlways`，与服务进程同一份）。选择卡那条路只剩「一条能参赛的职责都没有」
    const verdict = settleAlways(
      settleNoHit(
        settleCloseCall(
          routeWithinPosition(text, profiles),
          template.roles.map((r) => r.role),
        ),
        ordered,
      ),
      ordered,
    )
    const picked =
      verdict.picked === undefined ? undefined : held.find((a) => a.role_id === verdict.picked)

    // WP291：三分（固定替身 / 规则）。拿不准职责（出选择卡）的那条路照旧当任务
    const decided: { kind: EntryKind; by: 'stand_in' | 'rules' } =
      judge !== undefined
        ? { kind: judge, by: 'stand_in' }
        : { kind: entryKindByRules(text).kind, by: 'rules' }
    const kind: EntryKind = picked === undefined ? 'task' : decided.kind
    const ask = kind !== 'task'
    const matter = world.work.createMatter({
      kind: 'adhoc',
      title: text,
      entry: 'position',
      position_template_id: template.id,
      participants: [who],
      ...(ask ? { ask: true, quick: kind === 'quick' } : {}),
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
    if (kind === 'task')
      world.work.appendEvent(matter.id, {
        kind: 'status',
        text: `记成了任务，按「${world.roles.roles.get(picked.role_id)?.name.zh ?? picked.role_id}」做`,
        actor: { kind: 'agent', id: 'position_router' },
        ref: { type: 'position', id: template.id },
        route: { picked: picked.role_id, options: [], task: true },
      })
    if (kind === 'quick') {
      // 当场回答：确定性的替身照 mock 店铺现写一段（带 ```answer），再按契约取「一句话 + 组件」
      world.work.appendEvent(matter.id, {
        kind: 'agent_message',
        text: quickAnswerStandIn(world, text),
        actor: { kind: 'agent', id: picked.id },
      })
      const answer = splitAnswer(
        world.work.store
          .listMatterEvents(matter.id)
          .filter((e) => e.kind === 'agent_message')
          .map((e) => e.text)
          .join('\n\n'),
      )
      world.appendEvent('simulation.position_answered', {
        position_id: template.id,
        role_id: picked.role_id,
        components: answer.components.map((c: AnswerComponent) => c.kind),
        lead: answer.lead !== '',
      })
    }
    world.appendEvent('simulation.position_entry', {
      position_id: template.id,
      kind,
      by: decided.by,
      // 当场问答不进任何列表（默认事项列表里找不到它）
      ...(kind === 'quick'
        ? { hidden: !world.work.listMatters().some((m) => m.id === matter.id) }
        : {}),
    })
    world.appendEvent('simulation.position_routed', {
      position_id: template.id,
      role_id: picked.role_id,
      assignment_id: picked.id,
      candidates: verdict.candidates.length,
      // WP287：没问人、自己定的（打平按分 / 一个都没命中 / 谁都不像按先后）
      ...('settled' in verdict && verdict.settled === true ? { settled: true } : {}),
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
        options: input.verdict.candidates.map((c) => ({
          id: c.role_id,
          label: `走「${c.role_name}」`,
        })),
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
      options: input.verdict.candidates.map((c) => ({
        id: c.role_id,
        label: `走「${c.role_name}」`,
      })),
    })
    return item.state === 'blocked' ? undefined : item
  }

  return { staff, open, routed }
}

const PRODUCTS = /商品|产品|product/iu

/**
 * WP291：当场回答的确定性替身（模拟不调模型）。问商品 → mock 店铺里的商品列成表 + 在卖几件；
 * 别的 → 一句话（不读数据）。写法与真模型照 `QUICK_ANSWER_RULE` 回的一样：正文 + ```answer 段。
 */
function quickAnswerStandIn(world: World, text: string): string {
  if (!PRODUCTS.test(text)) return '这一问不用读数据，直接答：照岗位的规矩来就行。'
  const products = world.connect.state.products
  const live = products.filter((p) => p.status === 'active').length
  const body = {
    components: [
      {
        kind: 'table',
        columns: ['商品', '价格', '状态'],
        rows: products
          .slice(0, 50)
          .map((p) => [p.title, p.price, p.status === 'active' ? '在卖' : '草稿']),
        ...(products.length > 50 ? { total: products.length } : {}),
      },
      { kind: 'metric', items: [{ label: '在卖', value: live, unit: '件' }] },
    ],
  }
  return [
    `店里有 ${products.length} 件商品，${live} 件在卖。`,
    '',
    '```answer',
    JSON.stringify(body),
    '```',
  ].join('\n')
}
