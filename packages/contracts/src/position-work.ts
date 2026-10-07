/**
 * WP241（docs/54 §7）：岗位页「工作」——**本岗位的工作项视图**。
 *
 * Luoye 10-06 定的口径：**卡片流管决定，工作管进度**。工作里只看「AI 在做什么、做到哪」，
 * 不放决定按钮；有卡等你的事在行尾挂「N 张卡等你」，点了跳回卡片流那张。
 *
 * 一份形状、一份分组规则，前后端同用（与 `position-plan.ts` 同一个做法）：
 * - 服务端（`apps/server/src/positions.ts` 的 `work`）用它把事项 / 待办 / 定时 / 排期合成一份；
 * - 工作台用它决定看板上哪一类能拖、拖到哪一列改成什么状态。
 *
 * **这是视图，不是新对象**：没有任何一张表存「工作项」，每次现算；每一项都指回它真正的
 * 那一行（`kind` + `ref_id`）。改状态走那一行自己的写口（待办 `PUT /v1/todos/:id`），
 * 这里一个写口都没有。
 */
import type { AssignmentId, Iso8601, RoleId } from './common.js'
import type { MatterStatus, TodoSource, TodoStatus } from './work.js'

/** 工作项是从哪一类东西来的。 */
export type PositionWorkKind =
  /** 事项（37 Matter）：AI 在办的一件事 */
  | 'matter'
  /** 待办（37 Todo）：人手动加的那一类（也有会议 / 复盘落下来的） */
  | 'todo'
  /** 定时任务（25 ScheduledTask）：到点它自己做 */
  | 'schedule'
  /** 社媒排期（56 SocialPost）：排好了、到点发 */
  | 'post'

export const POSITION_WORK_KINDS: readonly PositionWorkKind[] = [
  'matter',
  'todo',
  'schedule',
  'post',
]

/**
 * 分组（设计稿 `docs/design/position`）：进行中 / 卡住了 / 排着的（排期、定时）/ 等别人 / 已完成（折叠）。
 * 顺序就是列表里从上到下、看板从左到右的顺序。
 *
 * WP244：加「卡住了」（`stuck`）——AI 这件事交不出来（运行没跑成、被停了、它自己说缺连接），
 * 不再挂在「进行中 · AI 在做」里；行上说缺什么（{@link PositionWorkItem.stuck_reason}）。
 * 只有事项会进这一组（待办的「卡住」仍是 `blocked` → 等别人，人改的状态不动）。
 */
export type PositionWorkGroup = 'doing' | 'stuck' | 'queued' | 'waiting' | 'done'

export const POSITION_WORK_GROUPS: readonly PositionWorkGroup[] = [
  'doing',
  'stuck',
  'queued',
  'waiting',
  'done',
]

/** 这件事是怎么来的（表格「来源」那一列、筛选的一项）。 */
export type PositionWorkSource =
  /** 你交给它的（岗位 / 职责入口开的事、你手动加的待办） */
  | 'you'
  /** Agent 自己发现 / 出卡落下来的 */
  | 'agent'
  /** 定时任务、排期 */
  | 'schedule'
  /** 来信（客户 / 外部线程开出来的事） */
  | 'inbound'
  /** 会议上落下来的待办 */
  | 'meeting'

export const POSITION_WORK_SOURCES: readonly PositionWorkSource[] = [
  'you',
  'agent',
  'schedule',
  'inbound',
  'meeting',
]

/** 一条工作项（四类合成一个形状）。 */
export interface PositionWorkItem {
  /** `${kind}:${ref_id}`——四类的 id 会撞，界面上用这个当 key */
  id: string
  kind: PositionWorkKind
  /** 指回真正那一行的 id（matter / todo / schedule / post） */
  ref_id: string
  title: string
  /** 所属职责（事项走的那条、待办 / 定时挂的那条分配的职责、排期那条渠道的职责） */
  role_id?: RoleId
  role_name?: string
  /** 本人在这条职责上的那条分配（跳职责页、改待办都用它） */
  assignment_id?: AssignmentId
  group: PositionWorkGroup
  /** 底下那一行的原始状态（`open` / `doing` / `active` / `scheduled`…），界面不翻译它，只当 data 属性 */
  status: string
  /** 截止（待办）或下次时间（定时、排期）；事项没有截止 */
  due_at?: Iso8601
  /** 最近一句进展（事项的「到哪了」摘要或时间线最后一句；定时的上次结果；排期的正文开头） */
  progress?: string
  /** 等你定的卡有几张（与卡片流同一个口径：本人、这个岗位、真是卡、还没定） */
  cards: number
  /** 那几张卡的 id（点「N 张卡等你」→ 卡片流翻到第一张） */
  card_ids: string[]
  source: PositionWorkSource
  /** 最近一次变化（表格「最近更新」、排序用） */
  updated_at: Iso8601
  /** 事项本身，或待办挂着的那件事项（点标题进事项页） */
  matter_id?: string
  /** 看板上能不能拖：只有人能改状态的那一类（待办）。规则见 {@link canMoveWorkItem} */
  movable: boolean
  /**
   * WP244：事项上 AI 这一轮做完了、结果出来了（没在跑、最后一句是它的答复）——进「已完成」，
   * 行上标「待你看结果」。事项本身没关（人还能接着说），再跑一轮就回「进行中」。
   */
  result_ready?: true
  /** WP244：在「卡住了」里时，卡在哪 / 缺什么（一句人话：「缺 Shopify 连接」或运行停下来那一句）。 */
  stuck_reason?: string
}

/** `GET /v1/positions/:id/work` 的回包。 */
export interface PositionWorkView {
  /** 岗位模板 id（不是分配 id） */
  position_id: string
  generated_at: Iso8601
  items: PositionWorkItem[]
  /** 页头那一行状态与分组标题旁的数（服务端数好，界面不再数一遍） */
  counts: {
    doing: number
    queued: number
    waiting: number
    done: number
    /** WP244：卡住了的件数（老服务端没有这一格） */
    stuck?: number
    /** 挂在工作项上、等你定的卡（去重后的张数） */
    cards: number
    /** 截止 / 排在今天、还没做完的待办（与工作台「截止：今天」筛选同一个口径） */
    todos_today: number
  }
  /** 本人在这个岗位里做的那几条职责（筛选「职责」的选项、加待办时挂哪条） */
  duties: { role_id: RoleId; role_name: string; assignment_id: AssignmentId }[]
  /** 「已完成」只带最近这几天的 */
  done_window_days: number
}

/** 「已完成」组只带最近几天的（再早的去「记录」里看）。 */
export const POSITION_WORK_DONE_DAYS = 14

/** 一次最多回几条（超过就按最近更新截断；一屏读不完的列表等于没有）。 */
export const MAX_POSITION_WORK_ITEMS = 300

/** 事项状态 → 分组。`waiting` 在 37 里就是「等外部 / 等别人回话」。 */
export function matterGroupOf(status: MatterStatus): PositionWorkGroup {
  if (status === 'closed') return 'done'
  if (status === 'waiting') return 'waiting'
  return 'doing'
}

/**
 * 待办状态 → 分组。`dropped`（不做了）不进工作：回 `undefined`。
 * 还没开始、但排在以后某个时段的（`scheduled.start` 在 `now` 之后）算「排着的」。
 */
export function todoGroupOf(
  status: TodoStatus,
  scheduledStart: Iso8601 | undefined,
  now: Iso8601,
): PositionWorkGroup | undefined {
  if (status === 'dropped') return undefined
  if (status === 'done') return 'done'
  if (status === 'blocked') return 'waiting'
  if (status === 'open' && scheduledStart !== undefined && scheduledStart > now) return 'queued'
  return 'doing'
}

/** 定时任务状态 → 分组。取消了的不进工作。 */
export function scheduleGroupOf(
  state: 'pending' | 'active' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled',
): PositionWorkGroup | undefined {
  if (state === 'cancelled') return undefined
  if (state === 'done') return 'done'
  if (state === 'running') return 'doing'
  return 'queued'
}

/** 社媒排期状态 → 分组。草稿 = 还在写 / 等你批（卡在卡片流里），算进行中。 */
export function postGroupOf(
  status: 'draft' | 'scheduled' | 'published' | 'failed',
): PositionWorkGroup {
  if (status === 'published') return 'done'
  if (status === 'draft') return 'doing'
  return 'queued'
}

/** 待办的来源 → 工作项来源。 */
export function todoSourceOf(source: TodoSource): PositionWorkSource {
  if (source === 'manual') return 'you'
  if (source === 'meeting') return 'meeting'
  return 'agent'
}

/**
 * 看板拖动的规则（WP241，按现有状态机来）：
 *
 * - **待办**：人是承诺人（37 Todo.owner 永远是人），状态本来就由人改——能在「进行中 /
 *   等别人 / 已完成」三列之间拖（「卡住了」只收事项，WP244），拖到哪列就改成 {@link todoStatusForGroup} 给的那个状态。
 *   「排着的」那一列不收：它的意思是「排在以后某个时段」，进去要给时间（日历视图里拖到某天），
 *   光拖一下没有时间可记，放进去刷新就会弹回「进行中」。
 * - **事项 / 定时 / 排期**：状态由 AI 的运行、调度循环、发帖结果推进，人在这里拖一下
 *   改不了「它做到哪了」——**不许拖**（卡片拿着不动，悬停说一句为什么）。要停一个定时任务
 *   去「设置 · 定时任务」，要结束一件事进事项页；要人拍板的出卡、在卡片流里定。
 */
export function canMoveWorkItem(
  item: Pick<PositionWorkItem, 'kind' | 'group'>,
  to: PositionWorkGroup,
): boolean {
  // WP244：「卡住了」只收事项（AI 交不出来的那种），待办拖不进去
  if (item.kind !== 'todo' || to === 'queued' || to === 'stuck') return false
  return item.group !== to
}

/** 待办拖到某一列 → 改成哪个状态（`queued` 不收拖动，给 `open` 只为函数是全的）。 */
export function todoStatusForGroup(group: PositionWorkGroup): TodoStatus {
  if (group === 'done') return 'done'
  if (group === 'waiting' || group === 'stuck') return 'blocked'
  if (group === 'doing') return 'doing'
  return 'open'
}
