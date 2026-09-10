/**
 * 秘书 Agent 的对象（41 §1）。
 *
 * 一句话定位：**秘书 = `common.member` 职责下每个人自带的个人 Agent，以本人权限运行，
 * 只管三件事——我是谁、我在做什么、我什么时候有空；以及"这件事该谁做"。**
 * 专业的事它不做，只把事路由给对的岗位。
 *
 * 本文件只定形状，不做 IO、不产生时间。契约里还没有这些对象（见交付报告 §4 的契约建议），
 * 所以先住在本包里；`ProfileRecord` 与 `AskedRecord` 都带 `schema_version`，进契约时可平移。
 */
import type {
  CalendarItem,
  Iso8601,
  PersonId,
  RangeRef,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'

/* ------------------------------------------------------------------ */
/* 公开级别（41 §1.3）                                                  */
/* ------------------------------------------------------------------ */

/** 三档：仅本人 / 同事可见（默认）/ 全工作区公开。 */
export type DisclosureLevel = 'self' | 'colleagues' | 'workspace'

export const DISCLOSURE_LEVELS = ['self', 'colleagues', 'workspace'] as const

/**
 * 可以设公开级别的字段。
 *
 * 41 §1.3 表格最后一行的"私有待办、个人记忆、对话正文"**不在这里**——它们永远只有本人
 * 看得到，不是一个可以调的旋钮（见 {@link PRIVATE_TOPICS}）。
 */
export type ProfileField =
  /** 岗位 */
  | 'positions'
  /** 负责范围（店铺 / 市场 / 部门） */
  | 'ranges'
  /** 现在在做的事项标题 / 数量 */
  | 'in_progress'
  /** 忙闲（时段级） */
  | 'availability'
  /** 日程明细（和谁开会）；41 §1.3 里它最高只到"同事可见（可选）" */
  | 'agenda_detail'
  /** 擅长与技能层 */
  | 'skills'
  /** 联系方式与联系偏好 */
  | 'contact'

export const PROFILE_FIELDS: readonly ProfileField[] = [
  'positions',
  'ranges',
  'in_progress',
  'availability',
  'agenda_detail',
  'skills',
  'contact',
]

/** 41 §1.3 那张表的默认列（"同事可见"是默认档）。 */
export const DEFAULT_DISCLOSURE: Readonly<Record<ProfileField, DisclosureLevel>> = Object.freeze({
  positions: 'colleagues',
  ranges: 'colleagues',
  in_progress: 'colleagues',
  availability: 'colleagues',
  // 和谁开会是隐私，默认只有本人
  agenda_detail: 'self',
  skills: 'colleagues',
  contact: 'colleagues',
})

/** 只能设到"同事可见"为止的字段（41 §1.3：日程明细那一行没有"全工作区"那一格）。 */
export const COLLEAGUES_CEILING: readonly ProfileField[] = ['agenda_detail']

/**
 * 秘书**永远不答**的东西（41 §1.2「秘书从不透露对话正文、私有待办、个人记忆」）。
 * 不是级别，是边界：问到这些一律回"这个要问本人"。
 */
export const PRIVATE_TOPICS = ['todo', 'memory', 'conversation'] as const
export type PrivateTopic = (typeof PRIVATE_TOPICS)[number]

/** 问方与被问者的关系。跨工作区（20 Join）后置，所以现在只有这两档 + 外人。 */
export type Relation = 'self' | 'colleague' | 'outsider'

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

/** 一条"擅长"。来源看得见：算出来的还是本人自己写的。 */
export interface ProfileSkill {
  name: string
  /** `skill` = 技能层里有这个技能；`memory` = 从做过的事里算出来的；`self` = 本人自己加的 */
  source: 'skill' | 'memory' | 'self'
  /** 本人手动藏掉的那几条（算出来的不一定对，人有最终解释权） */
  hidden?: boolean
}

/** 怎么找我（41 §1.2「维护 profile……联系方式」）。 */
export interface ContactPolicy {
  /** 先问秘书还是直接找人 */
  prefer: 'secretary' | 'direct'
  /** 一句话："紧急的事发消息，其余走卡片" */
  note?: string
}

/** 一条可用时段规则：周几、本地 `HH:MM` 起止。 */
export interface AvailabilityRule {
  /** 0 = 周日 … 6 = 周六 */
  days: number[]
  from: string
  to: string
}

export interface Availability {
  rules: AvailabilityRule[]
  /** 一场会默认多久（分钟） */
  default_minutes: number
  /** 一天最多接几场会；不设就是不限 */
  max_meetings_per_day?: number
}

/** 工作日 9–18 点，一场会 30 分钟。人可以改。 */
export const DEFAULT_AVAILABILITY: Availability = Object.freeze({
  rules: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }],
  default_minutes: 30,
}) as Availability

/**
 * **存下来的那半份** profile——本人可改的部分。
 *
 * 岗位与负责范围不存：它们是从分配算出来的（05 §3），存一份就会和制度层对不上。
 */
export interface ProfileRecord {
  schema_version: 1
  workspace_id: WorkspaceId
  person_id: PersonId
  skills: ProfileSkill[]
  contact_policy: ContactPolicy
  availability: Availability
  disclosure: Record<ProfileField, DisclosureLevel>
  updated_at: Iso8601
}

/** 一个岗位在 profile 上的样子。 */
export interface ProfilePosition {
  position_id: string
  role_id: RoleId
  role_name: string
  ranges: RangeRef[]
}

/** 完整 profile = 存下来的那半份 + 从制度层算出来的那半份。 */
export interface PersonProfile extends ProfileRecord {
  name: string
  positions: ProfilePosition[]
  ranges: RangeRef[]
}

/** 问方看得到的那一份（已按公开级别过滤）。 */
export interface VisibleProfile {
  person_id: PersonId
  name: string
  relation: Relation
  positions?: ProfilePosition[]
  ranges?: RangeRef[]
  skills?: ProfileSkill[]
  contact_policy?: ContactPolicy
  availability?: Availability
  /** 被公开级别挡下的字段（界面上写"这个要问本人"） */
  hidden_fields: ProfileField[]
  /** 公开级别本身只有本人看得到——别人不该知道你把什么藏起来了 */
  disclosure?: Record<ProfileField, DisclosureLevel>
}

/** `PUT /v1/me/profile` 的补丁：只覆盖给了的字段。 */
export interface ProfilePatch {
  skills?: ProfileSkill[]
  contact_policy?: Partial<ContactPolicy>
  availability?: Partial<Availability>
  disclosure?: Partial<Record<ProfileField, DisclosureLevel>>
}

/* ------------------------------------------------------------------ */
/* 代答                                                                */
/* ------------------------------------------------------------------ */

/**
 * 四类能答的问题（41 §1.2 表第一行）+ 两类不答的。
 *
 * - `doing` 在做什么 · `scope` 负责什么 · `busy` 忙不忙 · `skills` 擅长什么
 * - `private` 问到了私有待办 / 个人记忆 / 对话正文 / 日程明细 → 回"这个要问本人"
 * - `professional` 专业问题（退货窗口、投放出价……）→ 转给岗位 Agent
 * - `unknown` 听不懂 → 回"这个要问本人"
 */
export type AnswerKind =
  | 'doing'
  | 'scope'
  | 'busy'
  | 'skills'
  | 'private'
  | 'professional'
  | 'unknown'

/** 一次代答用到的事实（全部已按公开级别过滤过）。 */
export interface AnswerFacts {
  name: string
  positions?: ProfilePosition[]
  ranges?: RangeRef[]
  skills?: ProfileSkill[]
  contact_policy?: ContactPolicy
  /** 进行中事项：只有标题与条数（WP38 `inProgress`），没有正文 */
  in_progress?: { titles: string[]; count: number }
  /** 忙闲：时段级，不带"和谁"（那是 `agenda_detail`） */
  busy?: { slots: { start: Iso8601; end: Iso8601 }[]; next_free?: { start: Iso8601; end: Iso8601 } }
}

export interface SecretaryAnswer {
  answer: string
  kind: AnswerKind
  /** 这次答案用到了哪些字段（进"谁问过我"清单与事件） */
  fields: ProfileField[]
  /** 被挡下了没有（越级 / 私有 / 听不懂） */
  refused: boolean
  /** 专业问题转给了哪个职责 */
  refer_to?: { role_id: RoleId; role_name: string; person_id?: PersonId }
}

/** "谁问过我"清单里的一条。正文只在本人的库里，事件日志里只有哈希（21 §5）。 */
export interface AskedRecord {
  id: string
  schema_version: 1
  workspace_id: WorkspaceId
  /** 被问的人（这条记录归他） */
  person_id: PersonId
  /** 问的人 */
  asked_by: PersonId
  at: Iso8601
  run_id: string
  kind: AnswerKind
  question: string
  answer: string
  question_hash: string
  answer_hash: string
  fields: ProfileField[]
  refused: boolean
}

/* ------------------------------------------------------------------ */
/* 日程与约时间                                                         */
/* ------------------------------------------------------------------ */

export interface MeetSlot {
  start: Iso8601
  end: Iso8601
}

export type ConflictReason = 'busy' | 'outside_availability' | 'in_the_past' | 'too_many_meetings'

export interface AgendaCheckResult {
  ok: boolean
  /** 撞上的那几条（只给标题与时间，不给"和谁"） */
  conflicts: { id: string; title: string; start: Iso8601; end?: Iso8601 }[]
  reasons: ConflictReason[]
  /** 替代时段（按可用时段与已占用算） */
  alternatives: MeetSlot[]
}

export type MeetState = 'proposed' | 'accepted' | 'declined' | 'expired'

/** 一张"约时间"卡背后的记录。对方点头才进双方日历（41 §1.2）。 */
export interface MeetProposal {
  id: string
  schema_version: 1
  workspace_id: WorkspaceId
  /** 谁约 */
  from: PersonId
  /** 约谁 */
  to: PersonId
  title: string
  duration_minutes: number
  candidates: MeetSlot[]
  state: MeetState
  /** 对方点头选的那个 */
  accepted?: MeetSlot
  /** 对方秘书给的替代时段（候选全撞上时） */
  alternatives: MeetSlot[]
  approval_item_id?: string
  meeting_id?: string
  decline_reason?: string
  created_at: Iso8601
  decided_at?: Iso8601
}

/** 会前简报（41 §1.2「会前把相关事项摘要成议程」）。 */
export interface MeetingBrief {
  meeting_id: string
  title: string
  start: Iso8601
  end: Iso8601
  participants: string[]
  /** 每条一行，直接当议程用 */
  agenda: string[]
  /** 相关事项（标题 + 到哪了） */
  matters: { id: string; title: string; summary: string; status: string }[]
  /** 与会人手上还没做完的活（只有标题，按 WP38 的进行中视图取） */
  open_items: { title: string; owner: PersonId; owner_label?: string }[]
}

/* ------------------------------------------------------------------ */
/* 任务路由                                                            */
/* ------------------------------------------------------------------ */

/** 路由要认识的一个职责：id、人话名字、一堆判据词、它在这个工作区的持有人。 */
export interface RoleProfile {
  role_id: RoleId
  role_name: string
  terms: RoleTerm[]
  positions: { position_id: string; person_id: PersonId }[]
}

export interface RoleTerm {
  text: string
  /** 从哪来的（解释用："因为你说了『退款』，那是售后的 stage_refund"） */
  from: 'name' | 'description' | 'grounding' | 'action' | 'domain'
  weight: number
}

export interface RouteScore {
  role_id: RoleId
  role_name: string
  score: number
  matched: string[]
}

export interface RouteVerdict {
  /** 一件活（出认领卡）还是一个专业问题（转岗位，不出卡） */
  kind: 'task' | 'question'
  role_id?: RoleId
  role_name?: string
  position_id?: string
  owner?: PersonId
  /** 0..1 */
  confidence: number
  /** 卡面上那句"秘书判断：售后岗位，因为…" */
  reason: string
  scores: RouteScore[]
}

/** 路由跑完之后的完整结果（含查重与撞车）。 */
export interface RouteResult extends RouteVerdict {
  /** WP37：工具箱里已经有现成的（"别再造一个轮子"） */
  existing_tools: { id: string; title: string; kind: string; similarity: number }[]
  /** WP38：有人正在做同一件事 */
  similar_in_progress: {
    id: string
    title: string
    owner: PersonId
    owner_label?: string
    similarity: number
  }[]
  /** 出的那张认领卡与它在池里的那条待办；专业问题不出卡，这两个就没有 */
  claim_item_id?: string
  todo_id?: string
  run_id: string
}

/* ------------------------------------------------------------------ */
/* 日历投影                                                            */
/* ------------------------------------------------------------------ */

/** 秘书看到的日程 = work 的 `CalendarItem[]`（会议 + 排期待办 + 定时任务 + 卡片到期）。 */
export type AgendaItem = CalendarItem
