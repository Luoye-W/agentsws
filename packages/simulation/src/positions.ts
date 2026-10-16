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
 *    确定性的替身照 mock 店铺的商品现写（带 ```dsh-ui 组件段），再按契约同一份 `splitAnswer` 取出来；
 *    任务那一件原话后面头一句「记成了任务，按「X」做」。
 *    WP336：替身写 ```dsh-ui（dsh-genui 写法；决策 823 起 ```answer 已删），而且**故意夹带**按钮 / 图片 / 3D / 外链 / 自定义配色
 *    （像一个不守规矩的模型），按契约同一份白名单过滤；事件里记过滤后的节点类型、表格行数、数字，
 *    以及 mock 店铺的真数，测试比两头相等、比夹带的一个都没漏过去。
 * 5. **「我的助理」派活**（WP343，决策 859）：按那句话挑岗位 / 职责——判据是 `@agentsws/roles` 的
 *    `pickDispatchTarget`（与服务进程同一份），只在这个人**配过的岗位**里挑；拿不准就不派。派了就走上面
 *    同一个 `open`（当任务开，职责点了名就钉那条）。助理自己没有任何写口：这一步里它名下的
 *    staged / applied 一笔都不该有（`assistant_writes`），改外部的事由那个岗位出审批。
 * 6. **「我的助理」一次拆成多份**（WP350，决策 900）：一份会议记录 → 替身拆法（`@agentsws/stand-ins` 的
 *    `stubFanoutDraft`，demo 云替身同一份）→ 认岗位（`@agentsws/roles` 的 `resolveFanout`，与服务进程同一份）
 *    → 场景里写的勾掉 / 改归属（`applyFanoutEdits`）→ 要做的事走上面同一个 `open` 各开一件（当任务开），
 *    要记的写进知识库**就生效**（`fanoutNoteCard`，出处 = 这份资料；WP357 决策 902：以点「就这样」的人的
 *    名义激活，不再出确认卡）。助理自己仍然零写。
 */
import type {
  AnswerComponent,
  ApprovalItem,
  Assignment,
  GenuiNodeLite,
  PersonId,
  RoleId,
} from '@agentsws/contracts'
import { splitAnswer } from '@agentsws/contracts'
import {
  applyFanoutEdits,
  type EntryKind,
  entryKindByRules,
  type FanoutEdit,
  fanoutNoteCard,
  loadBundledPosition,
  type PickPosition,
  type Position,
  pickDispatchTarget,
  type RouteCandidate,
  resolveFanout,
  roleRouteTerms,
  routeWithinPosition,
  settleAlways,
  settleCloseCall,
  settleNoHit,
} from '@agentsws/roles'
import { stubFanoutDraft } from '@agentsws/stand-ins'
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
    /** WP343：助理点了名的那条职责（本人名下才算；跳过岗位内路由，同服务进程的 `role_id`） */
    role_id?: RoleId
  }): Promise<PositionRouteRecord>
  /** WP343：「我的助理」交代一件事（挑岗位 → 开任务；拿不准不派）。 */
  dispatch(input: {
    who: PersonId
    text: string
    position?: string
    duty?: string
  }): Promise<PositionRouteRecord | undefined>
  /** WP350：「我的助理」把一份资料拆给几个岗位（场景里写好勾掉 / 改归属）。 */
  fanout(input: {
    who: PersonId
    source: string
    drop?: string[]
    move?: { item: string; position: string }[]
  }): Promise<void>
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

  /** WP343：这个人配过哪几个岗位（助理只在这里面挑）。 */
  const staffed = new Map<PersonId, string[]>()

  const staff: PositionsLoop['staff'] = (who, position_id) => {
    const template = templateOf(position_id)
    const list = staffed.get(who) ?? []
    if (!list.includes(position_id)) staffed.set(who, [...list, position_id])
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

  const open: PositionsLoop['open'] = async ({ who, position_id, text, judge, role_id }) => {
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
    // WP343：点了名的职责（本人名下）直接钉上，不再路由
    const named = role_id === undefined ? undefined : held.find((a) => a.role_id === role_id)
    const picked =
      named ??
      (verdict.picked === undefined ? undefined : held.find((a) => a.role_id === verdict.picked))

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
      // 当场回答：确定性的替身照 mock 店铺现写一段（带 ```dsh-ui），再按契约取「一句话 + 组件」
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
      const genui = answer.components.flatMap((c: AnswerComponent) =>
        c.kind === 'genui' ? c.spec.items : [],
      )
      const products = world.connect.state.products
      world.appendEvent('simulation.position_answered', {
        position_id: template.id,
        role_id: picked.role_id,
        // WP336：genui 块再列出里面的节点类型（`genui:table`…），场景按它断言
        components: answer.components.flatMap((c: AnswerComponent) =>
          c.kind === 'genui' ? ['genui', ...c.spec.items.map((n) => `genui:${n.type}`)] : [c.kind],
        ),
        lead: answer.lead !== '',
        ...(genui.length === 0
          ? {}
          : {
              genui: genuiDigest(genui),
              mock: {
                products: Math.min(products.length, 50),
                live: products.filter((p) => p.status === 'active').length,
              },
            }),
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

  /** 这个人配过的岗位（助理只在这里面挑；职责只算本人名下的）。 */
  const mineOf = (who: PersonId): PickPosition[] =>
    (staffed.get(who) ?? []).map((id) => {
      const template = templateOf(id)
      const held = activeOf(who)
      return {
        id: template.id,
        name: template.name.zh,
        aliases: [template.name.en],
        duties: template.roles
          .filter((r) => held.some((a) => a.role_id === r.role))
          .map((r) => ({
            role_id: r.role,
            name: world.roles.roles.get(r.role)?.name.zh ?? r.role,
          })),
      }
    })

  /** 助理名下的写（一笔都不该有）。 */
  const assistantWrites = (before: number): number =>
    world.kernel.eventLog
      .readSync({ workspace_id: world.workspace_id })
      .slice(before)
      .filter(
        (e) =>
          e.actor.id === 'assistant' &&
          (e.type === 'change.staged' ||
            e.type.endsWith('.applied') ||
            e.type === 'approval.created'),
      ).length

  const dispatch: PositionsLoop['dispatch'] = async ({ who, text, position, duty }) => {
    const before = world.kernel.eventLog.readSync({ workspace_id: world.workspace_id }).length
    const mine = mineOf(who)
    const pick = pickDispatchTarget(mine, {
      text,
      ...(position === undefined ? {} : { position }),
      ...(duty === undefined ? {} : { duty }),
    })
    const record = pick.ok
      ? await open({
          who,
          position_id: pick.position_id,
          text,
          judge: 'task',
          ...(pick.role_id === undefined ? {} : { role_id: pick.role_id }),
        })
      : undefined
    // 助理名下的写：一笔都不该有（它只挑岗位、开事项）
    const assistant_writes = assistantWrites(before)
    const timeline = record === undefined ? [] : world.work.store.listMatterEvents(record.matter_id)
    world.appendEvent('simulation.assistant_dispatched', {
      dispatched: pick.ok,
      ...(pick.ok
        ? {
            position_id: pick.position_id,
            by: pick.by,
            ...(record?.picked === undefined ? {} : { role_id: record.picked }),
          }
        : { candidates: pick.candidates }),
      assistant_writes,
      // 回报（服务进程里落进那段对话）：这件事这时候有没有结果
      ...(record === undefined
        ? {}
        : {
            reported: timeline.some((e) => e.failed !== undefined)
              ? 'failed'
              : timeline.some((e) => e.kind === 'card')
                ? 'decide'
                : timeline.some((e) => e.kind === 'agent_message')
                  ? 'done'
                  : 'pending',
          }),
    })
    return record
  }

  const fanout: PositionsLoop['fanout'] = async ({ who, source, drop, move }) => {
    const before = world.kernel.eventLog.readSync({ workspace_id: world.workspace_id }).length
    const mine = mineOf(who)
    const draft = stubFanoutDraft(
      source,
      mine.map((p) => p.name),
    )
    const items = resolveFanout(mine, draft.items)
    const edits: FanoutEdit[] = [
      ...(drop ?? []).map((id) => ({ id, drop: true })),
      ...(move ?? []).map((m) => ({ id: m.item, position_id: m.position })),
    ]
    const { send, skipped } = applyFanoutEdits(mine, items, edits)
    const batch_id = `fan_${before.toString(36)}`
    const title = draft.title ?? '会议记录'
    const tasks_to: string[] = []
    const matters: string[] = []
    for (const item of send.filter((i) => i.kind === 'task')) {
      const record = await open({
        who,
        position_id: item.position_id as string,
        text: item.text,
        judge: 'task',
        ...(item.role_id === undefined ? {} : { role_id: item.role_id as RoleId }),
      })
      tasks_to.push(item.position_id as string)
      matters.push(record.matter_id)
    }
    const notes_to: string[] = []
    const cards: string[] = []
    for (const item of send.filter((i) => i.kind === 'note')) {
      const card = await world.knowledge.store.propose(
        fanoutNoteCard(item, {
          workspace_id: world.workspace_id,
          owner: who,
          at: world.clock.now(),
          batch_id,
          source_name: title,
          source_kind: 'meeting',
        }),
      )
      // 决策 902：人点的「就这样」，写进去就生效
      await world.knowledge.store.activate(card.id, who)
      notes_to.push(item.brand === true ? 'brand' : (item.position_id as string))
      cards.push(card.id)
    }
    const active = cards.filter(
      (id) => world.knowledge.store.getUnchecked(id)?.status === 'active',
    ).length
    world.appendEvent('simulation.assistant_fanout', {
      batch_id,
      items: items.length,
      tasks_to,
      notes_to,
      matters,
      notes_active: active,
      memories: send.filter((i) => i.kind === 'memory').length,
      skipped: {
        dropped: skipped.filter((x) => x.why_skipped === 'dropped').length,
        unsure: skipped.filter((x) => x.why_skipped === 'unsure').length,
        secret: skipped.filter((x) => x.why_skipped === 'secret').length,
      },
      assistant_writes: assistantWrites(before),
    })
  }

  return { staff, open, routed, dispatch, fanout }
}

const PRODUCTS = /商品|产品|product/iu

/** 过滤后的 genui 节点 → 事件里记的那几样：类型、表格行数、数字（测试拿它比 mock 店铺）。 */
function genuiDigest(items: readonly GenuiNodeLite[]): {
  types: string[]
  table_rows: number[]
  stats: { label: string; value: string }[]
  text: string
} {
  return {
    types: items.map((n) => n.type),
    table_rows: items.flatMap((n) =>
      n.type === 'table' && Array.isArray(n.rows) ? [n.rows.length] : [],
    ),
    stats: items.flatMap((n) =>
      n.type === 'stat' ? [{ label: String(n.label), value: String(n.value) }] : [],
    ),
    text: JSON.stringify(items),
  }
}

/**
 * WP291：当场回答的确定性替身（模拟不调模型）。问商品 → mock 店铺里的商品列成表 + 在卖几件；
 * 别的 → 一句话（不读数据）。写法与真模型照规矩回的一样：正文 + 组件段。
 *
 * WP336：组件段改写 ```dsh-ui；并且像一个不守规矩的模型那样**夹带**东西，必须被契约里的白名单滤掉（红线）。
 * WP341（决策 847）：按钮 / 图片 / 链接放开了，夹带的换成仍是红线的那几样（不认识的组件、`javascript:` 图、带事件的 svg、
 * 完整 ECharts 配置、空 3D）和自定义配色。
 */
function quickAnswerStandIn(world: World, text: string): string {
  if (!PRODUCTS.test(text)) return '这一问不用读数据，直接答：照岗位的规矩来就行。'
  const products = world.connect.state.products
  const live = products.filter((p) => p.status === 'active').length
  const body = {
    items: [
      { type: 'stat', label: '在卖', value: String(live), accent: '#ff3366' },
      {
        type: 'table',
        columns: ['商品', '价格', '状态'],
        rows: products
          .slice(0, 50)
          .map((p) => [p.title, p.price, p.status === 'active' ? '在卖' : '草稿']),
      },
      // 以下是夹带（WP341 起按钮 / 图片 / 链接放开了；这几样仍是红线）：一个都不许过
      { type: 'iframe', src: 'https://admin.example.com' },
      { type: 'image', src: 'javascript:alert(1)' },
      { type: 'svg', code: '<svg onload="steal()"></svg>' },
      { type: 'echart', option: { series: [{ type: 'custom' }] } },
      { type: 'scene3d', meshes: [] },
      ...(products.length > 50
        ? [
            {
              type: 'text',
              content: `一共 ${products.length} 件`,
            },
          ]
        : []),
    ],
  }
  return [
    `店里有 ${products.length} 件商品，${live} 件在卖。`,
    '',
    '```dsh-ui',
    JSON.stringify(body),
    '```',
  ].join('\n')
}
