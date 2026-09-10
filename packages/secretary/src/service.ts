/**
 * 秘书 Agent 的服务层（41 §1）：把 profile、代答、日程与约时间、任务路由接成一件东西。
 *
 * 边界：
 * - **本包不认识任何存储与运行时**。日程从注入的 `agendaOf` 来（宿主用 `@agentsws/work` 的
 *   `buildCalendar` 合并四类来源），撞车从 `findSimilar` 来（WP38），查重从 `findTools` 来
 *   （WP37），认领卡从 `createClaim` 来（进 WP38 的待认领池）。秘书只负责判断与解释。
 * - **每一次代答与路由都是 17 的一次 Run**：`run.started` / `prompt.assembled` /
 *   `run.completed` 三条事件带同一个 `run_id` 进事件日志，可回放。
 * - **正文不进事件日志**（21 §5）：事件里只有问题与答案的 sha256；正文只落在被问者
 *   自己的"谁问过我"清单里（41 §1.2「本人能看到谁问了什么、秘书答了什么」）。
 * - 时间经 Clock，随机经注入的 seed，没有一处 `Date.now()` / `Math.random()`。
 */
import type {
  CalendarItem,
  Clock,
  EventEnvelope,
  Iso8601,
  ModelRef,
  PersonId,
  WorkspaceId,
} from '@agentsws/contracts'
import { redactOutboundText, sha256 } from '@agentsws/core'
import { alternativeSlots, busySlots, checkAgenda } from './agenda.js'
import { answerQuestion, classifyQuestion } from './answer.js'
import { notFound, SecretaryError } from './errors.js'
import { buildSecretaryRunRequest } from './persona.js'
import {
  applyProfilePatch,
  dedupeSkills,
  defaultProfile,
  relationOf,
  visibleProfile,
  visibleTo,
} from './profile.js'
import { routeTask } from './route.js'
import {
  type AskedFilter,
  type MeetFilter,
  MemorySecretaryStore,
  type SecretaryStore,
} from './store.js'
import type {
  AgendaCheckResult,
  AnswerFacts,
  AskedRecord,
  MeetingBrief,
  MeetProposal,
  MeetSlot,
  PersonProfile,
  ProfileField,
  ProfilePatch,
  ProfilePosition,
  ProfileSkill,
  Relation,
  RoleProfile,
  RouteResult,
  SecretaryAnswer,
} from './types.js'

const DAY_MS = 86_400_000
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 找忙闲时往后看几天（"最近能约的是……"）。 */
export const BUSY_HORIZON_DAYS = 7
/** 认领卡标题最长多少字（丢过来的可能是一整段话）。 */
export const TITLE_MAX = 60

function makeIdFactory(random: () => number, now: () => Iso8601): (prefix: string) => string {
  let seq = 0
  return (prefix: string): string => {
    const t = Date.parse(now())
    let time = ''
    let n = Number.isFinite(t) ? t : 0
    for (let i = 0; i < 10; i += 1) {
      time = (ALPHABET[n % 32] ?? '0') + time
      n = Math.floor(n / 32)
    }
    let rand = ''
    for (let i = 0; i < 10; i += 1) rand += ALPHABET[Math.floor(random() * 32) % 32] ?? '0'
    seq = (seq + 1) % 32
    return `${prefix}_${time}${rand}${ALPHABET[seq] ?? '0'}`
  }
}

function defaultRandom(): () => number {
  let s = 0x5f3e21b
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

/** 21 §1 的事件出口，与 `@agentsws/work` 的 `WorkEventSink` 同源。 */
export type SecretaryEventSink = (e: Omit<EventEnvelope, 'id' | 'at'> & { at?: Iso8601 }) => void

/** 41 §1 多出来的四个事件名（契约的 `KnownEventType` 里还没有，见交付报告 §4）。 */
export type SecretaryEventType =
  | 'secretary.answered'
  | 'secretary.routed'
  | 'meet.proposed'
  | 'meet.accepted'
  | 'meet.declined'

export interface ClaimRequest {
  title: string
  note: string
  role_id?: string
  position_id?: string
  /** 建议给谁（岗位持有人）；没有就进"没人认领"的车道 */
  owner?: PersonId
  /** 丢这件事进来的人 */
  by: PersonId
  reason: string
  similar_to: string[]
  run_id: string
}

export interface SecretaryOptions {
  workspace_id: WorkspaceId
  clock: Clock
  store?: SecretaryStore
  random?: () => number
  /** 工作区时区偏移（分钟），日界线与"几点"按它切；默认 +8 */
  tz_offset_minutes?: number
  appendEvent: SecretaryEventSink

  /* ── 世界（宿主注入；给不了的就是这一格没有，秘书照答别的）────────────── */

  /** 人的展示名；翻译不出来回落成 id */
  personName(person_id: PersonId): string | undefined
  /** 这个人是不是本工作区的在职成员（决定问方与被问者的关系） */
  isMember(person_id: PersonId): boolean
  /** 他持有的岗位（从分配算，05 §3；profile 不存这一份） */
  positionsOf(person_id: PersonId): ProfilePosition[]
  /** 技能层里挂在他名下的技能名（"擅长"的来源之一，24） */
  skillsOf?(person_id: PersonId): string[]
  /** 他手上进行中的活（WP38 `Work.inProgress`，已按主人过滤） */
  inProgressOf?(person_id: PersonId): { id: string; title: string }[]
  /** 他的日程（WP22 `Work.calendar` 合并好的四类来源） */
  agendaOf?(
    person_id: PersonId,
    range: { from: Iso8601; to: Iso8601 },
  ): Promise<CalendarItem[]> | CalendarItem[]
  /** 这个工作区的职责库（路由的判据来源，04 / 05） */
  roleProfiles?(): RoleProfile[]
  /** WP37 工具箱查重 */
  findTools?(text: string): Promise<RouteResult['existing_tools']> | RouteResult['existing_tools']
  /** WP38 撞车检测 */
  findSimilar?(subject: {
    title: string
    at: Iso8601
  }): Promise<RouteResult['similar_in_progress']> | RouteResult['similar_in_progress']
  /** 出一张认领卡（进 WP38 的待认领池）；不给就只出判断不出卡 */
  createClaim?(
    input: ClaimRequest,
  ):
    | Promise<{ approval_item_id?: string; todo_id?: string }>
    | { approval_item_id?: string; todo_id?: string }
  /** 发一张"约时间"卡给对方；不给就只有记录没有卡 */
  createMeetCard?(
    proposal: MeetProposal,
  ): Promise<{ approval_item_id?: string }> | { approval_item_id?: string }
  /** 对方点头之后真的开一场会（进双方日历） */
  createMeeting?(input: {
    title: string
    start: Iso8601
    end: Iso8601
    participants: PersonId[]
    created_by: PersonId
  }): Promise<{ meeting_id: string }> | { meeting_id: string }
  /** 会前简报的素材：这场会与它牵着的事项 */
  meetingBriefSource?(
    meeting_id: string,
  ): Promise<MeetingBriefSource | undefined> | MeetingBriefSource | undefined
  /**
   * 装了模型就用模型把同一份事实说成人话。**判据与可见字段仍由规则算**——
   * 模型只润色，不决定给不给看。抛错就退回规则版那句话。
   */
  complete?(input: {
    system: string
    user: string
    run_id: string
    purpose: 'ask' | 'route'
  }): Promise<string>
  /** 现在生效的默认模型（进 `RunRequest.runtime.model`） */
  modelRef?(): ModelRef
}

export interface MeetingBriefSource {
  meeting_id: string
  title: string
  start: Iso8601
  end: Iso8601
  participants: { person_id?: PersonId; name?: string; email?: string }[]
  agenda?: string
  matters: { id: string; title: string; summary: string; status: string }[]
  open_items: { title: string; owner: PersonId }[]
}

export interface AskInput {
  /** 问的人 */
  viewer: PersonId
  /** 被问的人 */
  person_id: PersonId
  question: string
  assignment_id: string
}

export interface AskOutcome extends SecretaryAnswer {
  run_id: string
  /** "谁问过我"清单里那条的 id */
  asked_id: string
}

export interface MeetInput {
  from: PersonId
  to: PersonId
  title: string
  candidates: MeetSlot[]
  duration_minutes?: number
  assignment_id: string
}

export interface RouteInputArgs {
  person_id: PersonId
  assignment_id: string
  text: string
}

export class Secretary {
  readonly workspace_id: WorkspaceId
  readonly store: SecretaryStore
  readonly tz_offset_minutes: number
  readonly #clock: Clock
  readonly #newId: (prefix: string) => string
  readonly #options: SecretaryOptions

  constructor(options: SecretaryOptions) {
    this.#options = options
    this.workspace_id = options.workspace_id
    this.#clock = options.clock
    this.store = options.store ?? new MemorySecretaryStore()
    this.tz_offset_minutes = options.tz_offset_minutes ?? 480
    this.#newId = makeIdFactory(options.random ?? defaultRandom(), () => options.clock.now())
  }

  now(): Iso8601 {
    return this.#clock.now()
  }

  /* ── profile ──────────────────────────────────────────────────────── */

  /** 完整 profile：存下来的那半份 + 从制度层与技能层算出来的那半份。 */
  profile(person_id: PersonId): PersonProfile {
    const record =
      this.store.getProfile(this.workspace_id, person_id) ??
      defaultProfile({ workspace_id: this.workspace_id, person_id, at: this.now() })
    const positions = this.#options.positionsOf(person_id)
    const ranges = positions.flatMap((p) => p.ranges)
    const learned: ProfileSkill[] = (this.#options.skillsOf?.(person_id) ?? []).map((name) => ({
      name,
      source: 'skill' as const,
    }))
    const hidden = new Set(
      record.skills.filter((s) => s.hidden === true).map((s) => s.name.trim().toLowerCase()),
    )
    return {
      ...record,
      name: this.#options.personName(person_id) ?? person_id,
      positions,
      ranges: dedupeRanges(ranges),
      // 本人写的赢过算出来的；本人藏掉的那几条不再回来
      skills: dedupeSkills([...record.skills, ...learned]).filter(
        (s) => !(s.source !== 'self' && hidden.has(s.name.trim().toLowerCase())),
      ),
    }
  }

  updateProfile(person_id: PersonId, patch: ProfilePatch): PersonProfile {
    const prev =
      this.store.getProfile(this.workspace_id, person_id) ??
      defaultProfile({ workspace_id: this.workspace_id, person_id, at: this.now() })
    this.store.putProfile(applyProfilePatch(prev, patch, this.now()))
    return this.profile(person_id)
  }

  relation(viewer: PersonId, subject: PersonId): Relation {
    return relationOf({
      viewer,
      subject,
      same_workspace: this.#options.isMember(viewer) && this.#options.isMember(subject),
    })
  }

  /** 按问方身份过滤出他看得到的那一份（41 §1.3）。 */
  visibleProfile(viewer: PersonId, person_id: PersonId): ReturnType<typeof visibleProfile> {
    if (!this.#options.isMember(person_id)) throw notFound('这个人', person_id)
    return visibleProfile(this.profile(person_id), this.relation(viewer, person_id))
  }

  /** 问方看得见哪些字段。 */
  visibleFields(viewer: PersonId, person_id: PersonId): Set<ProfileField> {
    const profile = this.profile(person_id)
    const relation = this.relation(viewer, person_id)
    const out = new Set<ProfileField>()
    for (const [field, level] of Object.entries(profile.disclosure) as [
      ProfileField,
      PersonProfile['disclosure'][ProfileField],
    ][]) {
      if (visibleTo(level, relation)) out.add(field)
    }
    return out
  }

  /* ── 代答 ─────────────────────────────────────────────────────────── */

  /**
   * 别人问他的秘书。
   *
   * 走法固定：分类 → 只取问方**看得见**的事实 → 规则版给一句话（装了模型再润色）→
   * 记一条"谁问过我" → 发 `secretary.answered`（只有哈希）。
   */
  async ask(input: AskInput): Promise<AskOutcome> {
    const { viewer, person_id } = input
    if (!this.#options.isMember(person_id)) throw notFound('这个人', person_id)
    if (!this.#options.isMember(viewer))
      throw new SecretaryError('forbidden', '你不在这个工作区里，问不到别人的秘书')
    const run_id = this.#newId('run')
    const at = this.now()
    const kind = classifyQuestion(input.question)
    const visible = this.visibleFields(viewer, person_id)
    const facts = await this.#factsFor(person_id, visible, kind)
    const referral = kind === 'professional' ? this.#refer(input.question, person_id) : undefined
    const ruled = answerQuestion({
      question: input.question,
      facts,
      visible,
      now: at,
      tz_offset_minutes: this.tz_offset_minutes,
      ...(referral === undefined ? {} : { refer: referral }),
    })
    const request = buildSecretaryRunRequest({
      run_id,
      workspace_id: this.workspace_id,
      person_id: viewer,
      assignment_id: input.assignment_id,
      purpose: 'ask',
      model: this.#options.modelRef?.() ?? { provider: 'stub', model: 'default', region: 'cn' },
      context: [
        {
          id: `facts_${person_id}`,
          kind: 'summary',
          source_ref: { type: 'person', id: person_id },
          sensitivity: 'internal',
          content: facts,
          bytes: Buffer.byteLength(JSON.stringify(facts), 'utf8'),
        },
      ],
    })
    const answer = await this.#run(request, async () => {
      if (this.#options.complete === undefined || ruled.refused) return ruled.answer
      try {
        const text = await this.#options.complete({
          system: request.persona.sections.map((s) => s.text).join('\n\n'),
          user: `现场材料（已经按公开级别过滤过，只能用这些）：\n${JSON.stringify(facts)}\n\n问题：${input.question}\n\n规则版答案（可以润色，但事实一个字都不能改、不能添）：${ruled.answer}`,
          run_id,
          purpose: 'ask',
        })
        // 31 §3.3 出站脱敏：答案也是一个输出通道
        const clean = redactOutboundText('answer', text).trim()
        return clean === '' ? ruled.answer : clean
      } catch {
        // 模型不可用不该让秘书哑掉——规则版本来就答得出来
        return ruled.answer
      }
    })

    const record: AskedRecord = {
      id: this.#newId('asked'),
      schema_version: 1,
      workspace_id: this.workspace_id,
      person_id,
      asked_by: viewer,
      at,
      run_id,
      kind: ruled.kind,
      question: input.question,
      answer,
      question_hash: sha256(input.question),
      answer_hash: sha256(answer),
      fields: ruled.fields,
      refused: ruled.refused,
    }
    this.store.appendAsked(record)
    // 21 §5：审计得到「谁问了、答的是哪一类、用了哪些字段」，但拿不到正文
    this.#emit('secretary.answered', { kind: 'person', id: viewer }, run_id, {
      about: person_id,
      asked_by: viewer,
      kind: ruled.kind,
      fields: ruled.fields,
      refused: ruled.refused,
      question_hash: record.question_hash,
      answer_hash: record.answer_hash,
      answer_chars: answer.length,
    })
    return { ...ruled, answer, run_id, asked_id: record.id }
  }

  /** 「谁问过我」——只有本人看得到（41 §1.2）。 */
  asked(person_id: PersonId, viewer: PersonId, filter: AskedFilter = {}): AskedRecord[] {
    if (viewer !== person_id) throw new SecretaryError('forbidden', '「谁问过我」只有本人看得到')
    return this.store.listAsked(this.workspace_id, person_id, filter)
  }

  /* ── 日程 ─────────────────────────────────────────────────────────── */

  async agenda(
    person_id: PersonId,
    range: { from: Iso8601; to: Iso8601 },
  ): Promise<CalendarItem[]> {
    return [...((await this.#options.agendaOf?.(person_id, range)) ?? [])]
  }

  /** 这个时段能不能约（本人视角）。 */
  async checkAgenda(
    person_id: PersonId,
    slot: MeetSlot,
    options: { alternatives?: number; horizon_days?: number } = {},
  ): Promise<AgendaCheckResult> {
    const profile = this.profile(person_id)
    const horizon = options.horizon_days ?? BUSY_HORIZON_DAYS
    const from = slot.start
    const to = new Date(Date.parse(slot.start) + horizon * DAY_MS).toISOString()
    const items = await this.agenda(person_id, { from: minIso(from, this.now()), to })
    return checkAgenda({
      slot,
      items,
      availability: profile.availability,
      tz_offset_minutes: this.tz_offset_minutes,
      now: this.now(),
      ...(options.alternatives === undefined ? {} : { alternatives: options.alternatives }),
      ...(options.horizon_days === undefined ? {} : { horizon_days: options.horizon_days }),
    })
  }

  /* ── 约时间 ───────────────────────────────────────────────────────── */

  /**
   * 向对方秘书发一张"约时间"卡。
   *
   * **对方点头才进双方日历**（41 §1.2）：这一步只产生一条 `proposed` 的记录与一张卡，
   * 双方日历上什么都不会多出来。候选时段全撞上就不发卡——直接回冲突加替代时段，
   * 让人换一个再约（比发一张注定被拒的卡有礼貌）。
   */
  async meet(input: MeetInput): Promise<MeetProposal> {
    if (input.from === input.to) throw new SecretaryError('invalid_input', '不用跟自己约时间')
    if (!this.#options.isMember(input.to)) throw notFound('这个人', input.to)
    if (input.candidates.length === 0)
      throw new SecretaryError('invalid_input', '至少给一个候选时段')
    const theirs = this.profile(input.to)
    const duration =
      input.duration_minutes ??
      durationOf(input.candidates[0]) ??
      theirs.availability.default_minutes
    const feasible: MeetSlot[] = []
    const blocked: { slot: MeetSlot; who: PersonId; result: AgendaCheckResult }[] = []
    for (const slot of input.candidates) {
      const mine = await this.checkAgenda(input.from, slot)
      if (!mine.ok) {
        blocked.push({ slot, who: input.from, result: mine })
        continue
      }
      const theirCheck = await this.checkAgenda(input.to, slot)
      if (!theirCheck.ok) {
        blocked.push({ slot, who: input.to, result: theirCheck })
        continue
      }
      feasible.push(slot)
    }
    if (feasible.length === 0) {
      const alternatives = await this.#commonAlternatives(input.from, input.to, duration)
      throw new SecretaryError('conflict', '这几个时段都约不上', {
        reason: 'slot_conflict',
        blocked: blocked.map((b) => ({
          start: b.slot.start,
          end: b.slot.end,
          who: b.who,
          who_label: this.#options.personName(b.who) ?? b.who,
          reasons: b.result.reasons,
          conflicts: b.result.conflicts.map((c) => ({ title: c.title, start: c.start })),
        })),
        alternatives,
      })
    }
    const at = this.now()
    const proposal: MeetProposal = {
      id: this.#newId('meet'),
      schema_version: 1,
      workspace_id: this.workspace_id,
      from: input.from,
      to: input.to,
      title: input.title,
      duration_minutes: duration,
      candidates: feasible,
      state: 'proposed',
      alternatives: [],
      created_at: at,
    }
    const card = await this.#options.createMeetCard?.(proposal)
    const withCard: MeetProposal =
      card?.approval_item_id === undefined
        ? proposal
        : { ...proposal, approval_item_id: card.approval_item_id }
    this.store.putMeet(withCard)
    this.#emit('meet.proposed', { kind: 'person', id: input.from }, undefined, {
      meet_id: withCard.id,
      from: input.from,
      to: input.to,
      candidates: feasible.length,
      duration_minutes: duration,
    })
    return withCard
  }

  /** 对方（或他的秘书按他的规则）答这张卡。 */
  async decideMeet(
    id: string,
    by: PersonId,
    decision:
      | { action: 'accept'; slot?: MeetSlot | undefined }
      | { action: 'decline'; reason?: string | undefined },
  ): Promise<MeetProposal> {
    const proposal = this.store.getMeet(id)
    if (proposal === undefined || proposal.workspace_id !== this.workspace_id)
      throw notFound('约时间卡', id)
    if (proposal.to !== by) throw new SecretaryError('forbidden', '这张卡不是给你的')
    if (proposal.state !== 'proposed')
      throw new SecretaryError(
        'conflict',
        `这张卡已经${proposal.state === 'accepted' ? '接了' : '回过了'}`,
        {
          reason: 'already_decided',
          state: proposal.state,
        },
      )
    const at = this.now()
    if (decision.action === 'decline') {
      const alternatives = await this.#commonAlternatives(
        proposal.from,
        proposal.to,
        proposal.duration_minutes,
      )
      const next: MeetProposal = {
        ...proposal,
        state: 'declined',
        alternatives,
        decided_at: at,
        ...(decision.reason === undefined ? {} : { decline_reason: decision.reason }),
      }
      this.store.putMeet(next)
      this.#emit('meet.declined', { kind: 'person', id: by }, undefined, {
        meet_id: id,
        from: proposal.from,
        to: proposal.to,
        alternatives: alternatives.length,
      })
      return next
    }
    const slot = decision.slot ?? proposal.candidates[0]
    if (slot === undefined) throw new SecretaryError('invalid_input', '没有可接的时段')
    if (!proposal.candidates.some((c) => c.start === slot.start && c.end === slot.end))
      throw new SecretaryError('invalid_input', '这个时段不在候选里')
    // 从提议到点头之间对方日历可能变了——接之前再看一眼
    const recheck = await this.checkAgenda(by, slot)
    if (!recheck.ok)
      throw new SecretaryError('conflict', '这个时段现在约不上了', {
        reason: 'slot_conflict',
        reasons: recheck.reasons,
        alternatives: recheck.alternatives,
      })
    const made = await this.#options.createMeeting?.({
      title: proposal.title,
      start: slot.start,
      end: slot.end,
      participants: [proposal.from, proposal.to],
      created_by: proposal.from,
    })
    const next: MeetProposal = {
      ...proposal,
      state: 'accepted',
      accepted: slot,
      decided_at: at,
      ...(made?.meeting_id === undefined ? {} : { meeting_id: made.meeting_id }),
    }
    this.store.putMeet(next)
    this.#emit('meet.accepted', { kind: 'person', id: by }, undefined, {
      meet_id: id,
      from: proposal.from,
      to: proposal.to,
      start: slot.start,
      end: slot.end,
      ...(made?.meeting_id === undefined ? {} : { meeting_id: made.meeting_id }),
    })
    return next
  }

  meets(person_id: PersonId, filter: MeetFilter = {}): MeetProposal[] {
    return this.store.listMeets(this.workspace_id, { ...filter, to: filter.to ?? person_id })
  }

  /** 会前简报（41 §1.2）：把相关事项摘要成议程。 */
  async brief(meeting_id: string): Promise<MeetingBrief> {
    const source = await this.#options.meetingBriefSource?.(meeting_id)
    if (source === undefined) throw notFound('会议', meeting_id)
    const agenda: string[] = []
    for (const line of (source.agenda ?? '').split('\n')) {
      const t = line.replace(/^[-*\d.、\s]+/, '').trim()
      if (t !== '') agenda.push(t)
    }
    for (const m of source.matters) {
      agenda.push(m.summary === '' ? m.title : `${m.title}：${m.summary}`)
    }
    for (const item of source.open_items.slice(0, 5)) {
      agenda.push(`${this.#options.personName(item.owner) ?? item.owner}手上的「${item.title}」`)
    }
    return {
      meeting_id: source.meeting_id,
      title: source.title,
      start: source.start,
      end: source.end,
      participants: source.participants.map(
        (p) =>
          (p.person_id === undefined ? undefined : this.#options.personName(p.person_id)) ??
          p.name ??
          p.email ??
          p.person_id ??
          '（不知道是谁）',
      ),
      agenda,
      matters: source.matters,
      open_items: source.open_items.map((i) => ({
        title: i.title,
        owner: i.owner,
        owner_label: this.#options.personName(i.owner) ?? i.owner,
      })),
    }
  }

  /* ── 任务路由 ─────────────────────────────────────────────────────── */

  /**
   * 有人把一件事丢给秘书：判断该谁做 → 查工具箱有没有现成的 → 查有没有人正在做 →
   * 出一张认领卡给对的岗位。
   *
   * **专业问题不出卡**（41 §1.4）：那是岗位 Agent 的事，秘书只说"去问谁"。
   */
  async route(input: RouteInputArgs): Promise<RouteResult> {
    const run_id = this.#newId('run')
    const at = this.now()
    const text = input.text.trim()
    if (text === '') throw new SecretaryError('invalid_input', '没说要路由什么')
    const roles = this.#options.roleProfiles?.() ?? []
    const verdict = routeTask({ text, roles, me: input.person_id })
    const existing_tools = (await this.#options.findTools?.(text)) ?? []
    const similar_in_progress = (await this.#options.findSimilar?.({ title: text, at })) ?? []
    const request = buildSecretaryRunRequest({
      run_id,
      workspace_id: this.workspace_id,
      person_id: input.person_id,
      assignment_id: input.assignment_id,
      purpose: 'route',
      model: this.#options.modelRef?.() ?? { provider: 'stub', model: 'default', region: 'cn' },
      context: [
        {
          id: `route_${run_id}`,
          kind: 'summary',
          source_ref: { type: 'person', id: input.person_id },
          sensitivity: 'internal',
          content: { verdict, existing_tools, similar_in_progress },
          bytes: Buffer.byteLength(JSON.stringify(verdict), 'utf8'),
        },
      ],
    })

    const outcome = await this.#run(request, async () => {
      if (verdict.kind === 'question' || this.#options.createClaim === undefined)
        return { claim_item_id: undefined, todo_id: undefined }
      const made = await this.#options.createClaim({
        title: text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text,
        note: text,
        by: input.person_id,
        reason: verdict.reason,
        similar_to: similar_in_progress.map((s) => s.id),
        run_id,
        ...(verdict.role_id === undefined ? {} : { role_id: verdict.role_id }),
        ...(verdict.position_id === undefined ? {} : { position_id: verdict.position_id }),
        ...(verdict.owner === undefined ? {} : { owner: verdict.owner }),
      })
      return { claim_item_id: made.approval_item_id, todo_id: made.todo_id }
    })

    this.#emit('secretary.routed', { kind: 'person', id: input.person_id }, run_id, {
      kind: verdict.kind,
      confidence: verdict.confidence,
      text_hash: sha256(text),
      existing_tools: existing_tools.length,
      similar_in_progress: similar_in_progress.length,
      ...(verdict.role_id === undefined ? {} : { role_id: verdict.role_id }),
      ...(verdict.owner === undefined ? {} : { owner: verdict.owner }),
      ...(outcome.claim_item_id === undefined ? {} : { claim_item_id: outcome.claim_item_id }),
      ...(outcome.todo_id === undefined ? {} : { todo_id: outcome.todo_id }),
    })

    return {
      ...verdict,
      existing_tools,
      similar_in_progress,
      run_id,
      ...(outcome.claim_item_id === undefined ? {} : { claim_item_id: outcome.claim_item_id }),
      ...(outcome.todo_id === undefined ? {} : { todo_id: outcome.todo_id }),
    }
  }

  /** 21 §4 随主体删除。 */
  erase(person_id: PersonId): number {
    return this.store.erasePerson(this.workspace_id, person_id)
  }

  /* ── 内部 ─────────────────────────────────────────────────────────── */

  /** 一次秘书运行：三条事件带同一个 `run_id` 进日志（17 §2），中间那一步由调用方给。 */
  async #run<T>(
    request: ReturnType<typeof buildSecretaryRunRequest>,
    body: () => Promise<T>,
  ): Promise<T> {
    const actor = { kind: 'agent' as const, id: request.actor.assignment_id, run_id: request.id }
    this.#emit('run.started', actor, request.id, {
      request_id: request.id,
      runtime: 'secretary',
      model: request.runtime.model,
    })
    this.#emit('prompt.assembled', actor, request.id, {
      hash: sha256(JSON.stringify(request.persona.sections)),
      static_prefix_hash: sha256(request.persona.sections[0]?.text ?? ''),
      total_tokens: 0,
    })
    try {
      const out = await body()
      this.#emit('run.completed', actor, request.id, {
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: 0,
          tool_calls: 0,
          seconds: 0,
          cost_base: 0,
        },
        outputs: [],
        summary: '秘书跑完了一次',
      })
      return out
    } catch (err) {
      this.#emit('run.failed', actor, request.id, {
        error: {
          code: err instanceof SecretaryError ? err.code : 'internal',
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
      })
      throw err
    }
  }

  #emit(
    type: SecretaryEventType | string,
    actor: EventEnvelope['actor'],
    run_id: string | undefined,
    payload: unknown,
  ): void {
    this.#options.appendEvent({
      schema_version: 1,
      workspace_id: this.workspace_id,
      type,
      actor,
      correlation: { trace_id: '', ...(run_id === undefined ? {} : { run_id }) },
      payload,
    })
  }

  /** 只取问方看得见的那几格事实（41 §1.3）。看不见的**不取**——不是取了再藏。 */
  async #factsFor(
    person_id: PersonId,
    visible: ReadonlySet<ProfileField>,
    kind: ReturnType<typeof classifyQuestion>,
  ): Promise<AnswerFacts> {
    const profile = this.profile(person_id)
    const facts: AnswerFacts = { name: profile.name }
    if (visible.has('positions')) facts.positions = profile.positions
    if (visible.has('ranges')) facts.ranges = profile.ranges
    if (visible.has('skills')) facts.skills = profile.skills.filter((s) => s.hidden !== true)
    if (visible.has('contact')) facts.contact_policy = profile.contact_policy
    if (visible.has('in_progress') && kind === 'doing') {
      const items = this.#options.inProgressOf?.(person_id) ?? []
      facts.in_progress = { titles: items.map((i) => i.title), count: items.length }
    }
    if (visible.has('availability') && kind === 'busy') {
      const now = this.now()
      const to = new Date(Date.parse(now) + BUSY_HORIZON_DAYS * DAY_MS).toISOString()
      const items = await this.agenda(person_id, { from: now, to })
      const free = alternativeSlots({
        from: now,
        duration_minutes: profile.availability.default_minutes,
        items,
        availability: profile.availability,
        tz_offset_minutes: this.tz_offset_minutes,
        limit: 1,
        horizon_days: BUSY_HORIZON_DAYS,
      })[0]
      facts.busy = {
        slots: busySlots(items),
        ...(free === undefined ? {} : { next_free: free }),
      }
    }
    return facts
  }

  /** 专业问题转给哪个岗位。 */
  #refer(question: string, about: PersonId): SecretaryAnswer['refer_to'] {
    const roles = this.#options.roleProfiles?.() ?? []
    const verdict = routeTask({ text: question, roles, me: about })
    if (verdict.role_id === undefined || verdict.role_name === undefined) return undefined
    return {
      role_id: verdict.role_id,
      role_name: verdict.role_name,
      ...(verdict.owner === undefined
        ? {}
        : { person_id: this.#options.personName(verdict.owner) ?? verdict.owner }),
    }
  }

  /** 两个人都空着的时段（约不上时给的那几个替代）。 */
  async #commonAlternatives(
    a: PersonId,
    b: PersonId,
    duration_minutes: number,
    limit = 3,
  ): Promise<MeetSlot[]> {
    const now = this.now()
    const to = new Date(Date.parse(now) + BUSY_HORIZON_DAYS * DAY_MS).toISOString()
    const items = [
      ...(await this.agenda(a, { from: now, to })),
      ...(await this.agenda(b, { from: now, to })),
    ]
    // 两个人的可用时段取交集：谁的规则严就按谁的（这里用被约的那位，他才是要点头的人）
    const availability = this.profile(b).availability
    const mineOk = this.profile(a).availability
    return alternativeSlots({
      from: now,
      duration_minutes,
      items,
      availability,
      tz_offset_minutes: this.tz_offset_minutes,
      limit: limit * 3,
      horizon_days: BUSY_HORIZON_DAYS,
    })
      .filter(
        (slot) =>
          // 再过一遍约的人自己的可用时段——他也得有空
          checkAgenda({
            slot,
            items: [],
            availability: mineOk,
            tz_offset_minutes: this.tz_offset_minutes,
            now,
          }).ok,
      )
      .slice(0, limit)
  }
}

function dedupeRanges<T extends { kind: string; id: string }>(list: readonly T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const r of list) {
    const key = `${r.kind}:${r.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

function durationOf(slot: MeetSlot | undefined): number | undefined {
  if (slot === undefined) return undefined
  const d = Math.round((Date.parse(slot.end) - Date.parse(slot.start)) / 60_000)
  return Number.isFinite(d) && d > 0 ? d : undefined
}

const minIso = (a: Iso8601, b: Iso8601): Iso8601 => (Date.parse(a) <= Date.parse(b) ? a : b)

export function createSecretary(options: SecretaryOptions): Secretary {
  return new Secretary(options)
}
