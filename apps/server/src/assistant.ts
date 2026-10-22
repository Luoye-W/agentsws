/**
 * WP343（决策 334 / 859）：「我的助理」——随便聊改名合并之后的那一层能力。
 *
 * 随便聊那条模型回合（`free-chat.ts`）照旧，这里补三样：
 *
 * 1. **问全局（只读）**：四个工具（定义在 `@agentsws/stand-ins` 的 `runtime/assistant.ts`，全仓一份）——
 *    各岗位在做什么、今天要我处理的卡、最近发出去的、某件事进展。数据全部来自现有装配
 *    （岗位面的「工作」视图、审批队列、发出记录、事项），不新造存储，出参是白名单。
 * 2. **派活**：`hand_to_position` 按用户的话挑岗位 / 职责（`@agentsws/roles` 的 `pickDispatchTarget`，
 *    与模拟世界同一份判据；拿不准就不派，回候选），走岗位的交办入口开一件事（`mode: task`、不等跑完）。
 *    助理自己没有任何对外写口；改外部的事由那个岗位照旧出审批。
 * 3. **回报**：交出去的事有结果 / 要拍板 / 没做成时，在这段对话里报一句（`progressOf` 只读地看那件事的
 *    时间线，`free-chat.ts` 负责什么时候落进对话）。
 *
 * 另有快捷问题（按状态生成，最多 4 个）与 `@` 能选的岗位。
 */
import type {
  AssistantStateView,
  AssistantSuggestionView,
  AssistantTargetView,
  FreeChatActor,
  FreeChatDispatchView,
  FreeChatFanoutView,
  FreeChatReportView,
} from '@agentsws/api'
import type {
  ApprovalItem,
  Clock,
  Matter,
  MatterEvent,
  MessageRuleList,
  MessageRuleProposal,
  MessageRuleProposeInput,
  OutboundRecord,
  PositionInstance,
  PositionWorkView,
  ToolDef,
} from '@agentsws/contracts'
import { mentionedPositions, type PickPosition, pickDispatchTarget } from '@agentsws/roles'
import {
  ASSISTANT_CARDS_TOOL,
  ASSISTANT_DISPATCH_TOOL,
  ASSISTANT_FANOUT_TOOL,
  ASSISTANT_OVERVIEW_TOOL,
  ASSISTANT_PROGRESS_TOOL,
  ASSISTANT_SENT_TOOL,
  ASSISTANT_TOOL_DEFS,
  type AssistantCardRow,
  type AssistantDispatchResult,
  type AssistantMatterRow,
  type AssistantPositionRow,
  type AssistantSentRow,
  isAssistantTool,
  LIST_MESSAGE_RULES_TOOL,
  MESSAGE_RULE_TOOL_DEFS,
  MESSAGE_RULE_TOOL_NAMES,
  PROPOSE_MESSAGE_RULE_TOOL,
} from '@agentsws/stand-ins'
import {
  createFanout,
  type Fanout,
  type FanoutDeps,
  type FanoutSource,
} from './assistant-fanout.js'
import type { AssistantDispatchRow } from './free-chat-store.js'

/** 快捷问题最多几个。 */
export const MAX_SUGGESTIONS = 4
/** 交出去的事回报多久（之后就不再看那件事了）。 */
export const REPORT_WINDOW_MS = 3 * 24 * 3600 * 1000

export interface AssistantDeps {
  clock: Clock
  /** 本人在做的岗位（岗位面 `mine`）。 */
  positions(actor: FreeChatActor): Promise<readonly PositionInstance[]>
  /** 岗位「工作」视图（WP241）。不给 = 只回岗位与职责名。 */
  work?(actor: FreeChatActor, position_id: string): Promise<PositionWorkView>
  /** 本人还没定的卡。 */
  cards(actor: FreeChatActor): Promise<readonly ApprovalItem[]>
  /** 最近发出去的（发出记录 WP323）。不给 = 没有这一项。 */
  sent?(actor: FreeChatActor, query: { channel?: string; limit: number }): readonly OutboundRecord[]
  /** 本人能看到的事项（含归档）。 */
  matters(actor: FreeChatActor): readonly Matter[]
  /** 一件事的时间线（时间正序，最近的 `limit` 条）。 */
  timeline(matter_id: string, limit: number): readonly MatterEvent[]
  /** 这张卡还在等人定吗。 */
  cardPending(actor: FreeChatActor, id: string): Promise<boolean>
  /** 走岗位的交办入口开一件事（`mode: task`、不等跑完）。WP350：`summary` = 事项描述（来源原文）。 */
  open(
    actor: FreeChatActor,
    input: { position_id: string; role_id?: string; text: string; summary?: string },
  ): Promise<{ matter_id: string; title: string; role_id?: string; role_name?: string }>
  /** WP350：来源批次的 id。不给 = 按时钟现编一个。 */
  newId?(prefix: string): string
  /** WP350 / WP357（决策 902）：要记的那几条写进知识库就生效。不给 = 这里写不了知识。 */
  writeNotes?: FanoutDeps['writeNotes']
  /** WP357：汇总卡上「撤销」那一批。不给 = 撤不了。 */
  retireNotes?: FanoutDeps['retireNotes']
  /**
   * WP441（docs/108 §5.1.2）：一句话写消息规则。给了才挂那两个工具。**转规则用的是人这一轮说的原话**
   * （`ctx.user_text`），不是模型转述的——规则只能由人的话建。
   */
  messageRules?: {
    propose(actor: FreeChatActor, input: MessageRuleProposeInput): Promise<MessageRuleProposal>
    list(actor: FreeChatActor): Promise<MessageRuleList>
  }
}

export interface AssistantCallResult {
  /** 还给模型的那一段（JSON）。 */
  content: string
  /** 真交出去了才有。 */
  dispatch?: FreeChatDispatchView
  /** WP350：拆成多份的方案卡（人点「就这样」才派）。 */
  fanout?: FreeChatFanoutView
}

export interface Assistant {
  /** 挂给模型的工具（全仓一份的定义）。 */
  tools(): readonly ToolDef[]
  /** WP441：这个工具归助理接吗（六个助理工具之外，接了消息规则还有那两个）。 */
  handles?(name: string): boolean
  /** 系统提示里「你的岗位」那几行（模型据此知道有哪些岗位可派、拿什么名字点）。 */
  promptLines(actor: FreeChatActor): Promise<string[]>
  call(
    actor: FreeChatActor,
    call: { name: string; input: unknown },
    ctx: { user_text: string; source?: FanoutSource },
  ): Promise<AssistantCallResult>
  /** WP350：拆成多份（方案卡）与确认后扇出。 */
  fanout: Fanout
  /** `@` 选了岗位 / 职责：不经模型，直接交给它。 */
  direct(
    actor: FreeChatActor,
    target: { position_id: string; role_id?: string },
    text: string,
  ): Promise<{ dispatch?: FreeChatDispatchView; reason?: string }>
  state(actor: FreeChatActor): Promise<AssistantStateView>
  /** 一件交出去的事现在该报哪几句（还没报过的）。只读。 */
  progressOf(
    actor: FreeChatActor,
    row: AssistantDispatchRow,
  ): Promise<{ key: string; text: string; report: FreeChatReportView }[]>
}

const json = (v: unknown): string => JSON.stringify(v)
const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…` : one
}

/** 「等了多久」的人话。 */
export function waitedText(from: string, now: string): string {
  const ms = Math.max(0, Date.parse(now) - Date.parse(from))
  const h = Math.floor(ms / 3600_000)
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))} 分钟`
  if (h < 48) return `${h} 小时`
  return `${Math.floor(h / 24)} 天`
}

const nameOf = (p: PositionInstance): string => p.name.zh
/** 本人在这个岗位里持有的职责。 */
export const myDuties = (p: PositionInstance): { role_id: string; name: string }[] =>
  p.roles
    .filter((r) => r.my_assignment_id !== undefined)
    .map((r) => ({ role_id: r.role_id, name: r.role_name }))

export const toPick = (p: PositionInstance): PickPosition => ({
  id: p.position_id,
  name: nameOf(p),
  aliases: [p.name.en],
  duties: myDuties(p),
})

/** 只有负责人 / 普通成员这类通用职责的岗位（不当成干活的岗位举例）。 */
const isGeneral = (p: PositionInstance): boolean => {
  const duties = myDuties(p)
  return duties.length > 0 && duties.every((d) => d.role_id.startsWith('common.'))
}

export function createAssistant(deps: AssistantDeps): Assistant {
  const { clock } = deps
  let seq = 0
  const fanout = createFanout({
    clock,
    newId:
      deps.newId ??
      ((prefix) => {
        seq += 1
        return `${prefix}_${Date.parse(clock.now()).toString(36)}${seq.toString(36)}`
      }),
    mine: async (actor) => mine(actor),
    toPick,
    open: (actor, input) => deps.open(actor, input),
    ...(deps.writeNotes === undefined ? {} : { writeNotes: deps.writeNotes }),
    ...(deps.retireNotes === undefined ? {} : { retireNotes: deps.retireNotes }),
  })

  const mine = async (actor: FreeChatActor): Promise<PositionInstance[]> =>
    (await deps.positions(actor)).filter((p) => myDuties(p).length > 0)

  const dispatchView = (
    p: PositionInstance,
    opened: { matter_id: string; title: string; role_id?: string; role_name?: string },
  ): FreeChatDispatchView => {
    const duty =
      opened.role_name ?? myDuties(p).find((d) => d.role_id === opened.role_id)?.name ?? undefined
    return {
      matter_id: opened.matter_id,
      title: opened.title,
      position_id: p.position_id,
      position_name: nameOf(p),
      ...(opened.role_id === undefined ? {} : { role_id: opened.role_id }),
      ...(duty === undefined ? {} : { duty_name: duty }),
      at: clock.now(),
    }
  }

  const overview = async (actor: FreeChatActor, only?: string): Promise<string> => {
    let list = await mine(actor)
    if (only !== undefined && only.trim() !== '') {
      const picked = pickDispatchTarget(list.map(toPick), { text: '', position: only })
      if (picked.ok) list = list.filter((p) => p.position_id === picked.position_id)
    }
    const rows: AssistantPositionRow[] = []
    for (const p of list) {
      const view = deps.work === undefined ? undefined : await deps.work(actor, p.position_id)
      const items = view?.items ?? []
      const doing = items.filter((i) => i.group === 'doing' || i.group === 'stuck')
      const done = items
        .filter((i) => i.group === 'done')
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      rows.push({
        name: nameOf(p),
        duties: myDuties(p).map((d) => d.name),
        doing: doing.slice(0, 5).map((i) => ({
          title: clip(i.title, 60),
          ...(i.progress === undefined ? {} : { latest: clip(i.progress, 100) }),
          ...(i.role_name === undefined ? {} : { duty: i.role_name }),
        })),
        done: done.slice(0, 5).map((i) => ({
          title: clip(i.title, 60),
          ...(i.progress === undefined ? {} : { latest: clip(i.progress, 100) }),
          ...(i.role_name === undefined ? {} : { duty: i.role_name }),
          at: i.updated_at,
        })),
        open: view === undefined ? p.open_matters : doing.length,
        waiting_cards: p.pending_cards,
      })
    }
    return json({ positions: rows, ...(rows.length === 0 ? { note: '还没有岗位' } : {}) })
  }

  const myCards = async (actor: FreeChatActor): Promise<string> => {
    const list = await mine(actor)
    const now = clock.now()
    const position = (item: ApprovalItem): string | undefined =>
      list.find((p) => p.roles.some((r) => r.role_id === item.role_id))?.name.zh
    const rows: AssistantCardRow[] = (await deps.cards(actor)).slice(0, 20).map((item) => {
      const where = position(item)
      return {
        title: clip(item.title, 80),
        ...(where === undefined ? {} : { position: where }),
        waiting: waitedText(item.created_at, now),
      }
    })
    return json({ cards: rows, total: rows.length })
  }

  const recentSent = (actor: FreeChatActor, input: Record<string, unknown>): string => {
    if (deps.sent === undefined) return json({ sent: [], note: '这里查不到发出记录' })
    const raw = Number(input.limit)
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(30, Math.floor(raw)) : 10
    const channel =
      typeof input.channel === 'string' && input.channel.trim() !== ''
        ? input.channel.trim().toLowerCase()
        : undefined
    const rows: AssistantSentRow[] = deps
      .sent(actor, { limit, ...(channel === undefined ? {} : { channel }) })
      .slice(0, limit)
      .map((r) => {
        const to = r.destination ?? r.counterpart
        return {
          at: r.sent_at,
          channel: r.channel,
          action: r.action,
          ...(to === undefined ? {} : { to }),
          gist: clip(r.subject ?? r.content, 80),
          ...(r.approved_by === undefined ? {} : { approved_by: r.approved_by }),
        }
      })
    return json({ sent: rows })
  }

  const progress = async (actor: FreeChatActor, query: string): Promise<string> => {
    const words = query
      .toLowerCase()
      .split(/[\s,，、]+/u)
      .filter((w) => w !== '')
    if (words.length === 0) return json({ matters: [], note: '没给关键词' })
    const list = await mine(actor)
    const hits = deps
      .matters(actor)
      .filter((m) => {
        const hay = `${m.title} ${m.context.summary}`.toLowerCase()
        return words.some((w) => hay.includes(w))
      })
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .slice(0, 5)
    const rows: AssistantMatterRow[] = []
    for (const m of hits) {
      const events = deps.timeline(m.id, 40)
      const latest = events
        .filter((e) => e.kind === 'agent_message' || e.kind === 'status')
        .slice(-3)
        .map((e) => clip(e.text, 120))
      let waiting = 0
      const cardIds = new Set(
        events.flatMap((e) =>
          e.kind === 'card' && e.approval_item_id !== undefined ? [e.approval_item_id] : [],
        ),
      )
      for (const id of cardIds) if (await deps.cardPending(actor, id)) waiting += 1
      const position = list.find((p) => p.position_id === m.position_template_id)
      const duty =
        m.role_id === undefined
          ? undefined
          : position?.roles.find((r) => r.role_id === m.role_id)?.role_name
      rows.push({
        title: clip(m.title, 80),
        status: m.archived_at === undefined ? m.status : 'archived',
        ...(position === undefined ? {} : { position: nameOf(position) }),
        ...(duty === undefined ? {} : { duty }),
        updated_at: m.updated_at,
        latest,
        waiting_cards: waiting,
      })
    }
    return json({
      matters: rows,
      ...(rows.length === 0 ? { note: `没找到和「${query}」有关的事` } : {}),
    })
  }

  const dispatch = async (
    actor: FreeChatActor,
    input: Record<string, unknown>,
    user_text: string,
  ): Promise<AssistantCallResult> => {
    const str = (k: string): string | undefined =>
      typeof input[k] === 'string' && (input[k] as string).trim() !== ''
        ? (input[k] as string).trim()
        : undefined
    const text = str('text') ?? user_text.trim()
    if (text === '')
      return { content: json({ dispatched: false, reason: '没说要做什么', candidates: [] }) }
    const list = await mine(actor)
    const position = str('position')
    const duty = str('duty')
    const picked = pickDispatchTarget(list.map(toPick), {
      // 话里点了名也算：模型改写过的 text 与用户原话一起看
      text: `${text} ${user_text}`,
      ...(position === undefined ? {} : { position }),
      ...(duty === undefined ? {} : { duty }),
    })
    if (!picked.ok) {
      const out: AssistantDispatchResult = {
        dispatched: false,
        reason: picked.reason,
        candidates: picked.candidates,
      }
      // WP350（改决策 861）：话里点了好几个岗位——别问，按岗位拆开出方案卡
      const many =
        position === undefined ? mentionedPositions(list.map(toPick), `${text} ${user_text}`) : []
      return {
        content: json(
          many.length >= 2
            ? {
                ...out,
                hint: `话里点了 ${many.length} 个岗位：用 ${ASSISTANT_FANOUT_TOOL} 按岗位拆开，出一张方案卡给用户确认`,
              }
            : out,
        ),
      }
    }
    const p = list.find((x) => x.position_id === picked.position_id) as PositionInstance
    const opened = await deps.open(actor, {
      position_id: p.position_id,
      ...(picked.role_id === undefined ? {} : { role_id: picked.role_id }),
      text,
    })
    const view = dispatchView(p, opened)
    const out: AssistantDispatchResult = {
      dispatched: true,
      position: view.position_name,
      ...(view.duty_name === undefined ? {} : { duty: view.duty_name }),
      title: view.title,
    }
    return { content: json(out), dispatch: view }
  }

  /** WP441：一句话写消息规则（转规则、试跑、出「要建吗」卡；不直接生效）。白名单出参。 */
  const messageRuleCall = async (
    actor: FreeChatActor,
    name: string,
    input: Record<string, unknown>,
    user_text: string,
  ): Promise<AssistantCallResult> => {
    const rules = deps.messageRules
    if (rules === undefined) return { content: '这个工具不存在。' }
    if (name === LIST_MESSAGE_RULES_TOOL) {
      const list = await rules.list(actor)
      return {
        content: json({
          rules: list.rules.map((r) => ({
            id: r.id,
            name: r.name,
            revision: r.revision,
            enabled: r.enabled,
            ...(r.system === undefined
              ? { said: r.origin_text }
              : { system: r.system, ...(r.time === undefined ? {} : { time: r.time }) }),
            hits_30d: r.hits_30d ?? 0,
          })),
        }),
      }
    }
    const text = user_text.trim()
    if (text === '')
      return {
        content: json({ ok: false, message: '规则只能由人的话建：这一轮没有用户的原话，不建。' }),
      }
    const rule_id =
      typeof input.rule_id === 'string' && input.rule_id !== '' ? input.rule_id : undefined
    const revision = typeof input.revision === 'number' ? input.revision : undefined
    const out = await rules.propose(actor, {
      text,
      ...(rule_id === undefined ? {} : { rule_id }),
      ...(revision === undefined ? {} : { revision }),
    })
    if (!out.ok) return { content: json({ ok: false, message: out.message ?? '没转成规则。' }) }
    return {
      content: json({
        ok: true,
        name: out.draft?.name,
        plain: out.plain,
        matched: out.trial?.matched ?? 0,
        changed: out.trial?.changed.length ?? 0,
        sample: (out.trial?.sample ?? []).map((x) => x.subject).slice(0, 3),
        ...(out.trial?.credits === undefined ? {} : { credits: out.trial.credits }),
        card: out.card_id !== undefined,
        next: '确认卡已经发到卡片流，用户点「建」才生效；告诉他一行白话和试跑命中几封、改掉去向几封。',
      }),
    }
  }

  return {
    tools: () =>
      deps.messageRules === undefined
        ? ASSISTANT_TOOL_DEFS
        : [...ASSISTANT_TOOL_DEFS, ...MESSAGE_RULE_TOOL_DEFS],
    handles: (name) =>
      isAssistantTool(name) ||
      (deps.messageRules !== undefined && MESSAGE_RULE_TOOL_NAMES.includes(name)),
    fanout,

    async promptLines(actor) {
      const list = await mine(actor)
      if (list.length === 0) return ['用户现在还没有岗位：想交代事情时，告诉他先建一个岗位。']
      return [
        '用户的岗位（交代事情时只能交给这些；派活时用这里的名字）：',
        ...list.map((p) => {
          const duties = myDuties(p).map((d) => d.name)
          return `- ${nameOf(p)}${duties.length === 0 ? '' : `：${duties.join('、')}`}`
        }),
      ]
    },

    async call(actor, call, ctx) {
      const input = (call.input ?? {}) as Record<string, unknown>
      switch (call.name) {
        case ASSISTANT_OVERVIEW_TOOL:
          return {
            content: await overview(
              actor,
              typeof input.position === 'string' ? input.position : undefined,
            ),
          }
        case ASSISTANT_CARDS_TOOL:
          return { content: await myCards(actor) }
        case ASSISTANT_SENT_TOOL:
          return { content: recentSent(actor, input) }
        case ASSISTANT_PROGRESS_TOOL:
          return { content: await progress(actor, String(input.query ?? '').trim()) }
        case ASSISTANT_DISPATCH_TOOL:
          return dispatch(actor, input, ctx.user_text)
        case ASSISTANT_FANOUT_TOOL:
          return fanout.plan(actor, input, ctx.source ?? { name: '对话里的一段话', kind: 'human' })
        case PROPOSE_MESSAGE_RULE_TOOL:
        case LIST_MESSAGE_RULES_TOOL:
          return messageRuleCall(actor, call.name, input, ctx.user_text)
        default:
          return { content: '这个工具不存在。' }
      }
    },

    async direct(actor, target, text) {
      const list = await mine(actor)
      const p = list.find((x) => x.position_id === target.position_id)
      if (p === undefined) return { reason: '这个岗位不在你名下了，换一个再交' }
      const role_id =
        target.role_id !== undefined && myDuties(p).some((d) => d.role_id === target.role_id)
          ? target.role_id
          : undefined
      const opened = await deps.open(actor, {
        position_id: p.position_id,
        ...(role_id === undefined ? {} : { role_id }),
        text,
      })
      return { dispatch: dispatchView(p, opened) }
    },

    async state(actor) {
      const list = await mine(actor)
      const targets: AssistantTargetView[] = list.map((p) => ({
        position_id: p.position_id,
        name: nameOf(p),
        duties: myDuties(p),
      }))
      const suggestions: AssistantSuggestionView[] = []
      const cards = (await deps.cards(actor)).length
      if (cards > 0) suggestions.push({ kind: 'cards', text: '今天有什么要我处理的？' })
      const working = list.filter((p) => !isGeneral(p))
      // 有事在办的岗位先问（数多的在前）
      const busy = [...working].sort((a, b) => b.open_matters - a.open_matters)
      for (const p of busy.slice(0, 2))
        suggestions.push({ kind: 'position', text: `${nameOf(p)}今天做了什么？` })
      // 一条按这个品牌已有岗位举例的派活句：职责自己的快捷提示里挑「真去做一件事」的那条
      for (const p of working) {
        const prompt = p.roles
          .filter((r) => r.my_assignment_id !== undefined)
          .flatMap((r) => r.quick_prompts ?? [])
          .find((q) => q.kind === 'start_task')
        if (prompt === undefined) continue
        suggestions.push({ kind: 'dispatch', text: `让${nameOf(p)}${prompt.label.zh}` })
        break
      }
      if (working.length === 0)
        suggestions.push({
          kind: 'create_position',
          text: '帮我建一个岗位',
          href: '/org?tab=positions',
        })
      return { suggestions: suggestions.slice(0, MAX_SUGGESTIONS), targets }
    },

    async progressOf(actor, row) {
      const out: { key: string; text: string; report: FreeChatReportView }[] = []
      const who = `**${row.position_name}${row.duty_name === undefined ? '' : ` · ${row.duty_name}`}**`
      const base = {
        matter_id: row.matter_id,
        position_name: row.position_name,
        ...(row.duty_name === undefined ? {} : { duty_name: row.duty_name }),
        // WP350：同一张方案卡派出去的，回报带着批次（界面按批次聚在一起）
        ...(row.batch_id === undefined ? {} : { batch_id: row.batch_id }),
        ...(row.batch_title === undefined ? {} : { batch_title: row.batch_title }),
      }
      const seen = new Set(row.reported)
      const events = deps.timeline(row.matter_id, 200).filter((e) => e.at >= row.at)
      for (const e of events) {
        if (e.kind === 'card' && e.approval_item_id !== undefined) {
          const key = `card:${e.approval_item_id}`
          if (seen.has(key) || !(await deps.cardPending(actor, e.approval_item_id))) continue
          seen.add(key)
          out.push({
            key,
            text: `${who} 有一件要你拍板：${clip(e.text, 80)}`,
            report: { ...base, kind: 'decide', approval_item_id: e.approval_item_id },
          })
          continue
        }
        if (e.failed !== undefined) {
          const key = `failed:${e.run_id ?? e.id}`
          if (seen.has(key)) continue
          seen.add(key)
          out.push({
            key,
            text: `${who} 这次没做成：${clip(e.text, 100)}`,
            report: { ...base, kind: 'failed' },
          })
          continue
        }
        if (e.kind === 'agent_message' && e.stopped === undefined && e.run_id !== undefined) {
          const key = `done:${e.run_id}`
          if (seen.has(key)) continue
          seen.add(key)
          out.push({
            key,
            text: `${who} 做完了：${clip(e.text, 120)}`,
            report: { ...base, kind: 'done' },
          })
        }
      }
      return out
    },
  }
}

/** 一件事还要不要接着看（交出去超过 {@link REPORT_WINDOW_MS} 就不看了）。 */
export const stillWatching = (row: AssistantDispatchRow, now: string): boolean =>
  Date.parse(now) - Date.parse(row.at) <= REPORT_WINDOW_MS
