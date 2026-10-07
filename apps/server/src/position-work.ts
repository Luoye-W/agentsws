/**
 * WP241（docs/54 §7）：岗位页「工作」——把这个岗位下的**事项 + 待办 + 定时 + 排期**合成一份。
 *
 * 纯函数：输入是已经按岗位 / 本人滤好的几摞东西，输出是 `PositionWorkView`。取数与
 * 「哪些算这个岗位的」在 `positions.ts` 的 `work` 里做（与 `instance` 同一套归属规则），
 * 这里只管合并、分组、挂卡、截断——这样规则能脱离整套装配单测。
 *
 * 三条纪律：
 * 1. **视图，不是新对象**：每一项都指回真正那一行（`kind` + `ref_id`），这里一个写口都没有。
 * 2. **卡数与卡片流同一个口径**：调用方递进来的 `cards` 已经是「本人队列里、这个岗位的职责上、
 *    还没定、真是卡」的那些（与 `instance.pending_cards` 同一个过滤）——行尾「N 张卡等你」
 *    点过去，卡片流里一定翻得到。
 * 3. **已完成只带最近 {@link POSITION_WORK_DONE_DAYS} 天**，总数封顶
 *    {@link MAX_POSITION_WORK_ITEMS}（先保没做完的）。
 */
import {
  type ApprovalItem,
  type AssignmentId,
  type Iso8601,
  MAX_POSITION_WORK_ITEMS,
  type Matter,
  type MatterEvent,
  matterGroupOf,
  POSITION_WORK_DONE_DAYS,
  POSITION_WORK_GROUPS,
  type PositionWorkItem,
  type PositionWorkSource,
  type PositionWorkView,
  postGroupOf,
  type RoleId,
  scheduleGroupOf,
  type Todo,
  todoGroupOf,
  todoSourceOf,
} from '@agentsws/contracts'

const DAY_MS = 86_400_000

/** 工作项里的定时任务只要这几格（`ScheduledTask` 的子集）。 */
export interface WorkScheduleLike {
  id: string
  title?: string | undefined
  handler?: string | undefined
  role_id: RoleId
  assignment_id: AssignmentId
  state: 'pending' | 'active' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'
  created_by: 'user' | 'agent' | 'system'
  next_fire_at?: Iso8601 | undefined
  last_fire_at?: Iso8601 | undefined
  last_result?: string | undefined
  created_at?: Iso8601 | undefined
  updated_at?: Iso8601 | undefined
}

/** 工作项里的社媒排期只要这几格（`SocialPost` 的子集）。 */
export interface WorkPostLike {
  id: string
  channel: string
  status: 'draft' | 'scheduled' | 'published' | 'failed'
  body: string
  scheduled_at?: Iso8601
  published_at?: Iso8601
  failure_reason?: string
}

export interface BuildPositionWorkInput {
  position_id: string
  now: Iso8601
  /** 工作区时区下「今天」的起止（`Work.todayRange()`） */
  today: { from: Iso8601; to: Iso8601 }
  /** 本人在这个岗位里做的那几条职责（底座职责已滤掉） */
  duties: { role_id: RoleId; role_name: string; assignment_id: AssignmentId }[]
  /** 已按岗位滤好的事项（含别的持有人开的——与页头「N 件在办」同一个口径） */
  matters: readonly Matter[]
  /** 本人名下、挂在这个岗位某条分配上的待办 */
  todos: readonly Todo[]
  /** 本人在这个岗位那几条分配上的定时任务 */
  schedules: readonly WorkScheduleLike[]
  /** 这个品牌的社媒帖子（这里按「渠道 → 职责」只留本岗位的） */
  posts: readonly WorkPostLike[]
  /** 本人队列里、这个岗位职责上、还没定的卡（已滤成真卡） */
  cards: readonly ApprovalItem[]
  roleName(role_id: RoleId): string
  /** 分配 → 它的职责（老事项没记 `role_id` 时用它推） */
  roleOfAssignment(assignment_id: string): RoleId | undefined
  /** 事项最近一句进展（摘要或时间线最后一句）；不给就只用摘要 */
  progressOf?(matter: Matter): string | undefined
  /**
   * WP244：事项的运行情况（现在有没有在跑、最近一轮怎么收的尾、那条职责还缺什么）。
   * 不给 = 老口径（开着就是「进行中」）。
   */
  runOf?(matter: Matter): MatterRunState | undefined
}

/**
 * WP244：一件开着的事项「AI 这边」到哪了——分组靠它，不再一律算「进行中」。
 *
 * 根因（Fable 10-07 真机）：事项（37 Matter）只有 开着 / 等着 / 关了 三种状态，一轮运行跑完它照样
 * 「开着」（人还能接着说），WP241 的分组又把「开着」一律归进「进行中 · AI 在做」——于是答完了的
 * （「查完了。」）、交不出来的（「这份活现在交不出来——是没接上」）都一直挂在进行中。
 * 事项本身没有该收口而没收口的毛病；要改的是**视图的分组规则**：看它最近那一轮运行。
 */
export interface MatterRunState {
  /** 这件事上现在有运行在跑（或排着） */
  running: boolean
  /**
   * 最近一轮运行（时间线上最后一条「开始跑」之后）怎么收的尾：
   * `answered` = AI 回了话；`failed` = 没跑成；`stopped` = 被停了（看门狗 / 人 / 额度）。
   * 还没收尾 / 从没跑过 = 没有。
   */
  last?: { outcome: 'answered' | 'failed' | 'stopped'; text: string }
  /** 这件事那条职责还缺的**必需**连接（人话名）——卡住时「缺什么」先说它 */
  missing?: string[]
}

/**
 * AI 自己说「交不出来 / 没接上 / 没权限」的那几种说法（中英）。只在它最后那句答复上看，
 * 而且只决定「卡住了」还是「出结果了」——不改事项、不改卡。
 */
const STUCK_WORDS =
  /交不出|没接上|没连上|还没连|连不上|接不上|没有权限|没权限|没授权|未授权|未连接|缺少?(?:必需的?)?连接|not connected|isn['’]t connected|no access|missing (?:a |the )?connection/i

/**
 * 从时间线读出「最近那一轮运行怎么收的尾」。
 *
 * 按 `run_id` 认一轮，不按事件先后切——同步跑的那一路是**跑完才记「开始跑了」那一条**
 * （`Work.say` 等 `startRun` 回来才写 `run` 事件），所以「最后一条 run 事件之后」什么都没有。
 * 最近一轮 = 时间线上最后一条带 `run_id` 的事件所属的那一轮。
 */
export function matterRunStateOf(
  events: readonly Pick<MatterEvent, 'kind' | 'text' | 'run_id' | 'stopped'>[],
  running: boolean,
  missing?: readonly string[],
): MatterRunState {
  const base: MatterRunState = {
    running,
    ...(missing === undefined || missing.length === 0 ? {} : { missing: [...missing] }),
  }
  const run_id = [...events].reverse().find((e) => e.run_id !== undefined)?.run_id
  if (run_id === undefined) return base
  const mine = events.filter((e) => e.run_id === run_id)
  const halted = mine.find(
    (e) => e.kind === 'status' && (e.stopped !== undefined || e.text.startsWith('这次运行没跑成')),
  )
  const partial = mine.find((e) => e.kind === 'agent_message' && e.stopped !== undefined)
  if (halted !== undefined || partial !== undefined) {
    const line = halted ?? mine.find((e) => e.kind === 'status' && e.text.trim() !== '') ?? partial
    return {
      ...base,
      last: {
        outcome: halted?.text.startsWith('这次运行没跑成') === true ? 'failed' : 'stopped',
        text: line?.text ?? '',
      },
    }
  }
  const answer = mine.filter((e) => e.kind === 'agent_message' && e.text.trim() !== '').at(-1)
  return answer === undefined ? base : { ...base, last: { outcome: 'answered', text: answer.text } }
}

/** 一件**开着**的事项按运行情况落哪一组（关了 / 等着的不走这里）。 */
export function openMatterPhase(
  state: MatterRunState | undefined,
  cards: number,
): { group: 'doing' | 'stuck' | 'done'; result_ready?: true; stuck_reason?: string } {
  if (state === undefined || state.running || state.last === undefined) return { group: 'doing' }
  const missing = state.missing ?? []
  const reason = (fallback: string): string =>
    missing.length > 0 ? `缺${missing.join('、')}连接` : (clip(fallback, 60) ?? '这次没做成')
  const { outcome, text } = state.last
  if (outcome === 'failed' || outcome === 'stopped' || STUCK_WORDS.test(text))
    return { group: 'stuck', stuck_reason: reason(text) }
  // 答完了、还有卡等你定：照旧挂进行中（行尾「N 张卡等你」就是下一步），不算「已完成」
  if (cards > 0) return { group: 'doing' }
  return { group: 'done', result_ready: true }
}

/** 一句话截短（列表那一格放不下长段落；完整的在事项页）。 */
export function clip(text: string | undefined, max = 80): string | undefined {
  if (text === undefined) return undefined
  const line = text.replace(/\s+/g, ' ').trim()
  if (line === '') return undefined
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/** 社媒渠道 → 它的职责 id（`facebook_group` → `social.facebook-group`）。 */
export function socialRoleOfChannel(channel: string): RoleId {
  return `social.${channel.replace(/_/g, '-')}`
}

function matterSource(m: Matter): PositionWorkSource {
  if (m.kind === 'conversation') return 'inbound'
  // 岗位入口 / 职责入口开的都是人交过来的；没有 entry 的老事项多半是 Agent / 卡片落下来的
  return m.entry === undefined ? 'agent' : 'you'
}

export function buildPositionWork(input: BuildPositionWorkInput): PositionWorkView {
  const nowMs = Date.parse(input.now)
  const doneSince = nowMs - POSITION_WORK_DONE_DAYS * DAY_MS
  const recent = (at: Iso8601 | undefined): boolean =>
    at !== undefined && Date.parse(at) >= doneSince
  const mineByRole = new Map(input.duties.map((d) => [d.role_id, d.assignment_id]))
  const dutyName = (role_id: RoleId | undefined): string | undefined =>
    role_id === undefined
      ? undefined
      : (input.duties.find((d) => d.role_id === role_id)?.role_name ?? input.roleName(role_id))
  const withRole = (
    role_id: RoleId | undefined,
  ): Pick<PositionWorkItem, 'role_id' | 'role_name' | 'assignment_id'> => {
    if (role_id === undefined) return {}
    const name = dutyName(role_id)
    const mine = mineByRole.get(role_id)
    return {
      role_id,
      ...(name === undefined ? {} : { role_name: name }),
      ...(mine === undefined ? {} : { assignment_id: mine }),
    }
  }

  // 卡 → 挂到哪一项：事项按 subject，待办按自己记着的卡 id
  const cardsByMatter = new Map<string, string[]>()
  for (const card of input.cards) {
    const matter = card.subject.matter_id ?? card.subject.work_item_id
    if (matter === undefined) continue
    cardsByMatter.set(matter, [...(cardsByMatter.get(matter) ?? []), card.id])
  }
  const waitingCardIds = new Set(input.cards.map((c) => c.id))

  const items: PositionWorkItem[] = []

  for (const m of input.matters) {
    if (m.archived_at !== undefined && m.status !== 'closed') continue
    const card_ids = cardsByMatter.get(m.id) ?? []
    // WP244：开着的事项按最近那一轮运行分：在跑 = 进行中；答完了 = 已完成（待你看结果）；交不出来 = 卡住了
    const phase =
      m.status === 'open' ? openMatterPhase(input.runOf?.(m), card_ids.length) : undefined
    const group = phase?.group ?? matterGroupOf(m.status)
    if (group === 'done' && !recent(m.closed_at ?? m.context.last_activity ?? m.updated_at))
      continue
    const role_id =
      m.role_id ?? (m.position_id === undefined ? undefined : input.roleOfAssignment(m.position_id))
    const progress = clip(input.progressOf?.(m) ?? m.context.summary)
    items.push({
      id: `matter:${m.id}`,
      kind: 'matter',
      ref_id: m.id,
      title: m.title,
      ...withRole(role_id),
      group,
      status: m.status,
      ...(progress === undefined ? {} : { progress }),
      cards: card_ids.length,
      card_ids,
      source: matterSource(m),
      updated_at: m.context.last_activity ?? m.updated_at,
      matter_id: m.id,
      movable: false,
      ...(phase?.result_ready === true ? { result_ready: true as const } : {}),
      ...(phase?.stuck_reason === undefined ? {} : { stuck_reason: phase.stuck_reason }),
    })
  }

  for (const t of input.todos) {
    const group = todoGroupOf(t.status, t.scheduled?.start, input.now)
    if (group === undefined) continue
    if (group === 'done' && !recent(t.closed_at ?? t.updated_at)) continue
    const role_id = t.position_id === undefined ? undefined : input.roleOfAssignment(t.position_id)
    // 待办自己记着委托回来的卡；还挂在它那件事项上的卡也算它的（同一件事，别让人找两处）
    const card_ids = [
      ...new Set([
        ...t.cards.filter((id) => waitingCardIds.has(id)),
        ...(t.matter_id === undefined ? [] : (cardsByMatter.get(t.matter_id) ?? [])),
      ]),
    ]
    const due = t.due ?? t.scheduled?.start
    const progress = clip(t.note)
    // WP248（决策 79）：截止在今天之前、还没做完 = 已过期（按工作区时区的「今天」切，与页头同一个数）
    const overdue = group !== 'done' && due !== undefined && due < input.today.from
    items.push({
      id: `todo:${t.id}`,
      kind: 'todo',
      ref_id: t.id,
      title: t.title,
      ...withRole(role_id),
      group,
      status: t.status,
      ...(due === undefined ? {} : { due_at: due }),
      ...(progress === undefined ? {} : { progress }),
      cards: card_ids.length,
      card_ids,
      source: todoSourceOf(t.source),
      updated_at: t.updated_at,
      ...(t.matter_id === undefined ? {} : { matter_id: t.matter_id }),
      movable: true,
      ...(overdue ? { overdue: true as const } : {}),
    })
  }

  for (const s of input.schedules) {
    // 系统例行（每日计划、日 / 周 / 月复盘、巡检）每条分配各一份，是「工作台怎么运转」不是「这个岗位在做的事」——
    // 不进工作（不然一个两条职责的岗位光复盘就占八行）；它们在「设置 · 定时任务」里照样能看能停
    if (s.created_by === 'system') continue
    const group = scheduleGroupOf(s.state)
    if (group === undefined) continue
    if (group === 'done' && !recent(s.last_fire_at ?? s.updated_at)) continue
    const progress = clip(s.last_result)
    items.push({
      id: `schedule:${s.id}`,
      kind: 'schedule',
      ref_id: s.id,
      title: s.title ?? s.handler ?? s.id,
      ...withRole(s.role_id),
      group,
      status: s.state,
      ...(s.next_fire_at === undefined ? {} : { due_at: s.next_fire_at }),
      ...(progress === undefined ? {} : { progress }),
      cards: 0,
      card_ids: [],
      source: 'schedule',
      updated_at: s.last_fire_at ?? s.updated_at ?? s.created_at ?? input.now,
      movable: false,
    })
  }

  for (const p of input.posts) {
    const role_id = socialRoleOfChannel(p.channel)
    if (!mineByRole.has(role_id)) continue
    const group = postGroupOf(p.status)
    if (group === 'done' && !recent(p.published_at ?? p.scheduled_at)) continue
    // 没排时间的草稿不算排期（它还只是一段草稿，卡在卡片流里）
    if (p.status === 'draft' && p.scheduled_at === undefined) continue
    const progress = clip(p.status === 'failed' ? p.failure_reason : p.body, 60)
    items.push({
      id: `post:${p.id}`,
      kind: 'post',
      ref_id: p.id,
      title: clip(p.body, 40) ?? p.id,
      ...withRole(role_id),
      group,
      status: p.status,
      ...(p.scheduled_at === undefined ? {} : { due_at: p.scheduled_at }),
      ...(progress === undefined ? {} : { progress }),
      cards: 0,
      card_ids: [],
      source: 'schedule',
      updated_at: p.published_at ?? p.scheduled_at ?? input.now,
      movable: false,
    })
  }

  const order = (g: PositionWorkItem['group']): number => POSITION_WORK_GROUPS.indexOf(g)
  items.sort(
    (a, b) =>
      order(a.group) - order(b.group) ||
      (a.due_at ?? '￿').localeCompare(b.due_at ?? '￿') ||
      b.updated_at.localeCompare(a.updated_at),
  )
  // 封顶：先保没做完的（已完成排在最后，截掉的就是最旧的那些已完成）
  const kept = items.slice(0, MAX_POSITION_WORK_ITEMS)
  const count = (g: PositionWorkItem['group']): number => kept.filter((i) => i.group === g).length
  // 「今天 N 个待办」= 截止 / 排在今天、还没做完的；WP248（决策 79）：已过期没做完的也算进来
  // （点过去是「截止：今天及已过期」那个筛选，两边同一个口径）
  const byToday = (at: Iso8601 | undefined): boolean => at !== undefined && at < input.today.to
  const openTodos = kept.filter((i) => i.kind === 'todo' && i.group !== 'done')
  return {
    position_id: input.position_id,
    generated_at: input.now,
    items: kept,
    counts: {
      doing: count('doing'),
      stuck: count('stuck'),
      queued: count('queued'),
      waiting: count('waiting'),
      done: count('done'),
      cards: new Set(kept.flatMap((i) => i.card_ids)).size,
      todos_today: openTodos.filter((i) => byToday(i.due_at)).length,
      todos_overdue: openTodos.filter((i) => i.overdue === true).length,
    },
    duties: input.duties.map((d) => ({ ...d })),
    done_window_days: POSITION_WORK_DONE_DAYS,
  }
}
