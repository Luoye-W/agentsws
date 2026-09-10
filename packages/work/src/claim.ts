/**
 * 认领即锁（40 §3.2 / §3.5，06 §2 认领管道）。
 *
 * 会议、每日计划、告警、秘书路由抽出来的活**先进待认领池**：一条没有主人的待办。
 * 谁点「我来」谁是主人，其余人立刻看到「李默已认领」；主人可以转交、可以加协作者；
 * 认领之后 N 天没动静先提醒，再 N 天回池。
 *
 * ## 为什么状态不写在 `Todo.status` 上
 *
 * 契约的 `Todo.status` 现在只有 `open | doing | blocked | done | dropped`，`owner` 还是必填，
 * 也没有 `collaborators`。本 WP 不改契约（见交付报告 §4 的契约建议），所以认领状态
 * 作为一条 {@link TodoClaim} **随 `Todo` 的 JSON 一起存**：两档存储都是整条 JSON 进出
 * （内存档 `structuredClone`、SQLite 档 `JSON.stringify`），所以它天然跟着走，
 * 不需要第二张表、也不需要动 `WorkStore` 接口。
 *
 * 池里的项用 {@link UNCLAIMED_OWNER} 这个保留 id 占 `owner`，因此**不会**出现在任何
 * `listTodos({ owner: 某人 })` 里——待办箱、日历、每日计划、复盘一个都不会误收。
 *
 * 纯逻辑，没有 IO：判定给同样的输入永远出同样的结果。
 */
import type { Iso8601, MatterId, PersonId, Todo, TodoId } from '@agentsws/contracts'
import { DAY_MS, ms } from './util.js'

/** 池里的项没有主人；`Todo.owner` 必填，先用这个保留 id 占位。 */
export const UNCLAIMED_OWNER = 'unclaimed' as PersonId

/**
 * `unclaimed` 在池里等人认；`offered` 是转交出去、对方还没接下（**接下之前不形成责任**，
 * 31 I13）；`claimed` 是有主人。
 */
export type ClaimState = 'unclaimed' | 'offered' | 'claimed'

/** 「仍新建」时那句区别至少要写这么多字（40 §3.1）。 */
export const MIN_DISTINCT_REASON = 8

/** 认领后多少天没动静开始提醒、再多少天回池（策略 `idle_days` 缺省值）。 */
export const DEFAULT_IDLE_DAYS = 5

export interface TodoClaim {
  state: ClaimState
  /** 协作者（主人之外一起做的人）；主人永远只有一个 */
  collaborators: PersonId[]
  /** 进池的时间（回池会刷新） */
  pooled_at?: Iso8601
  claimed_at?: Iso8601
  claimed_by?: PersonId
  /** 转交给谁 / 谁交的 / 什么时候交的 */
  offered_to?: PersonId
  offered_by?: PersonId
  offered_at?: Iso8601
  /** 闲置提醒发出去的时间（发过一次就不重复发） */
  reminded_at?: Iso8601
  /** 回过几次池 */
  recycled: number
  /** 建的时候撞过谁（认领卡与事项页上那句「可能与 X 重复」） */
  similar_to?: TodoId[]
  /** 选「我这个不一样」时写的那句区别 */
  distinct_reason?: string
}

/** 带认领状态的待办。存储里存的就是它——多出来的键随 JSON 一起走。 */
export type TodoWithClaim = Todo & { claim?: TodoClaim }

/**
 * 取一条待办的认领状态。老数据（没有 `claim` 的）按它的 `owner` 推：
 * 有主人就是 `claimed`，占位主人就是 `unclaimed`——不需要迁移。
 */
export function claimOf(todo: Todo): TodoClaim {
  const carried = (todo as TodoWithClaim).claim
  if (carried !== undefined)
    return { ...carried, collaborators: [...(carried.collaborators ?? [])] }
  return {
    state: todo.owner === UNCLAIMED_OWNER ? 'unclaimed' : 'claimed',
    collaborators: [],
    recycled: 0,
  }
}

/** 写回认领状态（不改别的字段）。 */
export function withClaim(todo: Todo, claim: TodoClaim): TodoWithClaim {
  return { ...todo, claim }
}

export const isUnclaimed = (todo: Todo): boolean => claimOf(todo).state === 'unclaimed'

/** 转交出去、对方还没接的那些（对方首页上的「交给你」）。 */
export const isOfferedTo = (todo: Todo, person: PersonId): boolean => {
  const c = claimOf(todo)
  return c.state === 'offered' && c.offered_to === person
}

/** 谁跟这条待办有关系：主人 + 协作者 + 被转交的对象。 */
export function involves(todo: Todo, person: PersonId): boolean {
  const c = claimOf(todo)
  return todo.owner === person || c.collaborators.includes(person) || c.offered_to === person
}

/** 「仍新建」的理由够不够（不够就 400，别让「不一样」变成一个空按钮）。 */
export function distinctReasonOk(reason: string | undefined): boolean {
  return reason !== undefined && [...reason.trim()].length >= MIN_DISTINCT_REASON
}

export type IdleVerdict = 'none' | 'remind' | 'recycle'

export interface IdleInput {
  claim: TodoClaim
  /** 有卡等着定就不算闲置——人在等 Agent，不是没动 */
  cards: number
  /** 这条待办最近一次真动过的时间（事项时间线 / 委托 / 改状态），没有就用认领时间 */
  last_activity?: Iso8601 | undefined
  now: Iso8601
  idle_days: number
}

/**
 * 闲置判定（40 §3.5）：认领后 N 天无卡无时间线 → 提醒主人；提醒之后再 N 天 → 回池。
 *
 * 只对 `claimed` 生效：池里的项本来就没人认，不存在「闲置」。
 */
export function idleVerdict(input: IdleInput): IdleVerdict {
  const { claim } = input
  if (claim.state !== 'claimed') return 'none'
  if (input.cards > 0) return 'none'
  const window = Math.max(1, input.idle_days) * DAY_MS
  const now = ms(input.now)
  if (claim.reminded_at !== undefined) {
    return now - ms(claim.reminded_at) >= window ? 'recycle' : 'none'
  }
  const since = input.last_activity ?? claim.claimed_at
  if (since === undefined) return 'none'
  return now - ms(since) >= window ? 'remind' : 'none'
}

/** 池里一条项的展示投影（首页「待认领」那一区）。 */
export interface PoolItem {
  todo_id: TodoId
  title: string
  note?: string
  source: Todo['source']
  position_id?: string
  matter_id?: MatterId
  due?: Iso8601
  pooled_at: Iso8601
  /** 回过几次池（回过的那条标一下：上一个主人没动它） */
  recycled: number
  /** 可能与这些进行中项重复 */
  similar_to: TodoId[]
}

export function poolItemOf(todo: Todo): PoolItem {
  const c = claimOf(todo)
  return {
    todo_id: todo.id,
    title: todo.title,
    source: todo.source,
    pooled_at: c.pooled_at ?? todo.created_at,
    recycled: c.recycled,
    similar_to: c.similar_to ?? [],
    ...(todo.note === undefined ? {} : { note: todo.note }),
    ...(todo.position_id === undefined ? {} : { position_id: todo.position_id }),
    ...(todo.matter_id === undefined ? {} : { matter_id: todo.matter_id }),
    ...(todo.due === undefined ? {} : { due: todo.due }),
  }
}
