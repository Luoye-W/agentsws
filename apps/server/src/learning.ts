/**
 * 学习回路的接线（38 §2 WP29）。
 *
 * 判定全在 `@agentsws/learning`（纯函数 + 池）；这里只做四件接线的事：
 *
 * 1. **收信号**：每张卡被决定之后抽 lesson 入池（驳回原因 / 编辑差异 / 指导 / 边界答案）；
 *    运行结束时把反思与工具摩擦一起收进来。零打扰——池里加一行，技能一个字不动。
 * 2. **次日出卡**：每天 07:30 一条定时任务，把够硬的 lesson 变成 `skill_lesson` 选择题卡。
 * 3. **采纳落地**：批准 / 驳回这几类卡时按 kind 分发施行——技能类走 `applyLessonDecision`，
 *    知识类写知识库。失败一律 `apply_failed`（不是 `unknown`）：这两类没有外部副作用，
 *    结果不可能"不知道"。
 * 4. **下次运行**：`SkillRegistry.resolve` 出来的正文进 prompt（`skillPromptSections`）。
 *
 * 纪律：**不批不生效**。这个文件里唯一写 overlay 的地方是 `applyDecision`，
 * 而它只在人按了采纳之后被调到。
 */

import { join } from 'node:path'
import type { SkillProposalSummary, SkillSummary } from '@agentsws/api'
import type {
  ApprovalBus,
  ApprovalItem,
  Assignment,
  Clock,
  DecideInput,
  EventEnvelope,
  Iso8601,
  LessonRecord,
  PersonId,
  PromotionTier,
  RunEvent,
  RunId,
  RunResult,
  SkillTier,
  WorkspaceId,
} from '@agentsws/contracts'
import type { Knowledge } from '@agentsws/knowledge'
import {
  applyLessonDecision,
  createLearning,
  draftProposals,
  type ExtractInput,
  extractLessons,
  type FilteredProposal,
  type HumanDecision,
  type Learning,
  type LessonProposalCard,
  OPTION_NONE,
  type PromotionCard,
  promotionCriteria,
  skillReaderOf,
  weeklyPromotions,
} from '@agentsws/learning'
import type { RoleStore } from '@agentsws/roles'
import { type SkillScopeRef, type Skills, TIER_ORDER } from '@agentsws/skills'
import type { CreateApprovalInput } from '@agentsws/txn'

/** 本机自带的入门技能：技能库为空时先给一份，学习回路才有落脚的段落。 */
export const DEFAULT_SKILL_NAME = 'customer-care'
export const DEFAULT_SKILL_MD = `---
name: customer-care
description: 售后客服：先查记录，再按公司口径答，改动一律先提再做
---

## 回答顺序

先查订单与物流记录，再找公司口径，最后才动笔。记录里没有的事不猜。

## 退货窗口计算

退货窗口以送达日为起点计算，不是下单日。

## 回信语气

开头先确认收到，中间讲清依据，结尾给下一步。金额一律写清币种。
`

/** 卡片 payload：工作台与施行两边都认它。 */
export interface SkillLessonPayload {
  form: 'skill_lesson'
  skill: string
  section_id: string
  heading: string
  semantic_key: string
  proposed_text: string
  /** 候选改法（含"都不要"）；`approve` 必须带 `selected_option_id` */
  options: LessonProposalCard['options']
  hits: number
  confidence: number
  lessons: string[]
  quotes: string[]
  run_ids: RunId[]
}

/** WP69（54 §3）：某一层记忆里的一段（岗位页 / 职责层的"记忆"小节列的就是它们）。 */
export interface MemoryEntry {
  /**
   * WP71：这一条的地址，改 / 删用它（`<来源>:<层>:<owner>:<技能>:<段>`）。
   *
   * 来源那一格只有两种：`m` = 手动加的（住在这一层自己的技能记录里），
   * `p` = 提升批下来的（是这一层 overlay 上的一条 op）。两种都能改能删，但
   * **来龙去脉不一样**，界面上要分得开，id 里就先分开。
   */
  id: string
  skill: string
  section_id: string
  heading?: string
  body: string
  /** 人写的还是学来的（06 §3.4：学来的段在界面上有标记） */
  origin: 'authored' | 'learned'
  learned_from?: { lessons: string[]; at: Iso8601 }
  /** WP71：手动加的，还是从事项 / 复盘提升上来的。 */
  source: 'manual' | 'promoted'
  /** WP71：手动加的那些记得是谁加的、什么时候加的（提升上来的看 `learned_from`）。 */
  added_by?: PersonId
  added_at?: Iso8601
}

/** WP71：手动加 / 改一条记忆的入参。 */
export interface MemoryWriteInput {
  tier: SkillTier
  scope_id?: string
  text: string
  heading?: string
  /** 写进哪个技能；不给就是本机自带那一份（`customer-care`）。 */
  skill?: string
  by: PersonId
}

/** WP71：记忆条目 id 拆开之后的样子。 */
export interface MemoryRef {
  source: 'manual' | 'promoted'
  tier: SkillTier
  owner: string
  skill: string
  section_id: string
}

const MEMORY_SOURCE: Readonly<Record<string, 'manual' | 'promoted'>> = Object.freeze({
  m: 'manual',
  p: 'promoted',
})

/** `m:role:dtc.store:customer-care:01J…` → 五格。任何一格不对就回 undefined（路由据此 400）。 */
export function parseMemoryRef(id: string): MemoryRef | undefined {
  const parts = id.split(':')
  if (parts.length !== 5) return undefined
  const [src, tier, owner, skill, section_id] = parts as [string, string, string, string, string]
  const source = MEMORY_SOURCE[src]
  if (source === undefined) return undefined
  if (!(TIER_ORDER as readonly string[]).includes(tier)) return undefined
  if (owner === '' || skill === '' || section_id === '') return undefined
  return { source, tier: tier as SkillTier, owner, skill, section_id }
}

export function memoryRefId(ref: MemoryRef): string {
  return [ref.source === 'manual' ? 'm' : 'p', ref.tier, ref.owner, ref.skill, ref.section_id].join(
    ':',
  )
}

/**
 * WP71b：**判"在不在这个岗位里"时不算这一条。**
 *
 * `common.member` 是"你加入了这个工作区"这件事本身（04 §7 原话：加入工作区自动获得，
 * **不属于任何岗位**），而 `org.positions()` 会把它追加进每个岗位模板的 `roles`。
 * 不把它摘掉，"本人在这个岗位下至少持有一条职责"对**每一个成员**都成立——
 * 那道门就等于没有：刚进公司的人也能读写客服岗位那一层的记忆。
 */
const WORKSPACE_WIDE_ROLES: readonly string[] = ['common.member']

/** 这个岗位下、真正算数的那几条职责（摘掉全员自带的那一条）。 */
function dutiesOf(position: { roles: readonly { role: string }[] }): string[] {
  return position.roles.map((r) => r.role).filter((r) => !WORKSPACE_WIDE_ROLES.includes(r))
}

/**
 * WP71（36 §10）：**这一层的记忆，本人能不能手改**。
 *
 * 一句话：**你在哪一层干活，才改得动哪一层**。
 *
 * - **职责层**：本人持有这条职责（名下有一条没撤销的分配）；
 * - **岗位层**：本人在这个岗位下至少持有一条职责——岗位层记的是"这家公司的这个岗位
 *   怎么做事"，在这个岗位里干活的人都该记得下一笔。`holders` 那条"默认包全在名下"
 *   的严规则是用来算**谁在做这个岗位**这张名单的，不是权限判据（05 §2）；
 * - **公司层 / 部门层**：owner。它们是制度层的东西（14 §13.3）；
 * - **包层 / 个人层**：这条路不开。包层是上游的，个人层在个人设置里改
 *   （而且管理员对个人数据没有读，40 E1）。
 *
 * 提升（把一条提到上一层）**不走这里**：那是提议 → 批准（24 §3），
 * 走 `POST /v1/skills/:name/promote`。这里管的只有"改自己这一层"。
 */
export function canEditMemory(input: {
  tier: SkillTier
  scope_id?: string
  /** 本人名下没撤销的那几条职责。 */
  held_roles: readonly string[]
  /** 岗位模板（只用来查"这个岗位下有哪几条职责"）。 */
  positions: readonly { id: string; roles: readonly { role: string }[] }[]
  is_owner: boolean
}): { ok: boolean; reason?: string } {
  const { tier, scope_id } = input
  if (tier === 'package') return { ok: false, reason: '内置包那一层是上游的，改不了' }
  if (tier === 'personal') return { ok: false, reason: '个人层在个人设置里改，不从这里改' }
  if (tier === 'company' || tier === 'department')
    return input.is_owner
      ? { ok: true }
      : { ok: false, reason: '公司层与部门层是制度层的东西，只有所有者能改（14 §13.3）' }
  if (scope_id === undefined || scope_id === '')
    return { ok: false, reason: `改${tier === 'position' ? '岗位' : '职责'}层要说清楚是哪一个` }
  if (tier === 'role')
    return input.held_roles.includes(scope_id)
      ? { ok: true }
      : { ok: false, reason: '这条职责不在你名下，改不了它那一层的记忆' }
  const template = input.positions.find((p) => p.id === scope_id)
  if (template === undefined) return { ok: false, reason: `没有这个岗位：${scope_id}` }
  return dutiesOf(template).some((r) => input.held_roles.includes(r))
    ? { ok: true }
    : { ok: false, reason: '你不在这个岗位里，改不了它那一层的记忆' }
}

/** {@link canEditMemory} 与 {@link canReadMemory} 共用的一份入参。 */
export interface MemoryAccessInput {
  tier: SkillTier
  scope_id?: string
  /** 本人名下没撤销的那几条职责。 */
  held_roles: readonly string[]
  /** 岗位模板（只用来查"这个岗位下有哪几条职责"）。 */
  positions: readonly { id: string; roles: readonly { role: string }[] }[]
  is_owner: boolean
}

/**
 * WP71b（36 §10.1 那个洞的修法）：**这一层的记忆，本人看不看得见**。
 *
 * 判据与 {@link canEditMemory} 同源，只在"上面几层"这一处比它松：
 *
 * | 层 | 读 | 写（`canEditMemory`） |
 * |---|---|---|
 * | 内置包 | 任何成员 | 谁都不行（上游的） |
 * | 公司 / 部门 | 任何成员 | 只有 owner（14 §13.3） |
 * | 岗位 | 本人在这个岗位下至少持有一条职责 | 同左 |
 * | 职责 | 本人持有这条职责 | 同左 |
 * | 个人 | 本人（这条路由只回本人那一份） | 在个人设置里改 |
 *
 * **为什么读要比写松**：公司层记的是"这家公司怎么做事"——它本来就是给所有人看的，
 * 上一次运行时模型也是照着它做的；不让人看，人就没法理解 Agent 为什么那样做，
 * 而"看得见机器凭什么这么干"是这整个产品的地基（36 §7）。写仍然是 owner 的事。
 *
 * **为什么不是原来那条 `skill.read@workspace`**：职责模板里根本没有 `skill` 这个域
 * （只有 `common.owner` 有），所以那条元组判定的实际效果是"除了 owner 谁都读不到
 * 自己干活那一层的记忆"——这不是一条安全边界，是一个漏配（WP71 在真 demo 上打出来的）。
 * 换成这一份之后，判据说的才是它想说的那句话：**你在哪一层干活，就看得见哪一层**。
 */
export function canReadMemory(input: MemoryAccessInput): { ok: boolean; reason?: string } {
  const { tier, scope_id } = input
  // 上面那几层是"给所有人看的"：内置包是上游带来的，公司 / 部门是这家公司的明规矩
  if (tier === 'package' || tier === 'company' || tier === 'department') return { ok: true }
  // 个人层这条路由只回本人那一份（40 E1：管理员对个人数据没有读）
  if (tier === 'personal') return { ok: true }
  if (scope_id === undefined || scope_id === '')
    return { ok: false, reason: `看${tier === 'position' ? '岗位' : '职责'}层要说清楚是哪一个` }
  if (tier === 'role')
    return input.held_roles.includes(scope_id)
      ? { ok: true }
      : { ok: false, reason: '这条职责不在你名下，看不了它那一层的记忆' }
  const here = input.positions.find((p) => p.id === scope_id)
  if (here === undefined) return { ok: false, reason: `没有这个岗位：${scope_id}` }
  return dutiesOf(here).some((r) => input.held_roles.includes(r))
    ? { ok: true }
    : { ok: false, reason: '你不在这个岗位里，看不了它那一层的记忆' }
}

export interface SkillPromotionPayload {
  form: 'skill_promotion'
  skill: string
  section_ids: string[]
  from: PromotionCard['from']
  to_tier: PromotionCard['to_tier']
  /** WP69：提到岗位 / 职责层时，提到的是哪一个（另两层不需要） */
  scope_id?: string
  proposed_text: string
  contributors: string[]
  criteria: PromotionCard['criteria']
  lessons: string[]
}

export interface LearningOptions {
  workspace_id: WorkspaceId
  clock: Clock
  random: () => number
  skills: Skills
  knowledge: Knowledge
  roles: RoleStore
  approvals: ApprovalBus
  owner: PersonId
  ownerAssignment: Assignment
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 给了数据目录就落盘（重启续跑）。 */
  dbDir?: string
  /** 策略层技能：永不进学习回路（24 §3）。 */
  policySkills?: string[]
}

export interface LearningAssembly {
  learning: Learning
  /** 每天 07:30 跑一次：池 → `skill_lesson` 卡。 */
  proposeDaily(now: Iso8601): Promise<{ created: string[]; filtered: FilteredProposal[] }>
  /** 周一 06:00：跨人聚类 → `skill_promotion` 卡。 */
  weeklyConsolidate(
    workspace_id: WorkspaceId,
    now: Iso8601,
  ): Promise<{ proposals: PromotionCard[] }>
  /** 一次运行结束：反思与工具摩擦进池（人的决定走 `wrap`）。 */
  onRunCompleted(input: {
    run_id: RunId
    assignment_id: string
    events?: readonly RunEvent[]
    result?: Pick<RunResult, 'lessons'>
  }): void
  /** 把审批总线包一层：决定之后抽 lesson + 按 kind 施行。 */
  wrap(bus: ApprovalBus): ApprovalBus
  /** 已有的提案卡（工作台技能页的"待审提案数"）。 */
  pendingProposals(skill?: string): Promise<ApprovalItem[]>
  /** 24 §5 `GET /lessons`：池里那些，投影成契约的 `LessonRecord`。 */
  lessons(filter: { workspace_id?: WorkspaceId; status?: LessonRecord['status'] }): LessonRecord[]
  /** 技能页：每个技能的当前版本、三层 overlay、待审提案数。 */
  summaries(actor: {
    person_id: PersonId
    workspace_id: WorkspaceId
    department_id?: string
  }): Promise<SkillSummary[]>
  /** 技能页：待审的「昨天学到的」。 */
  proposalSummaries(): Promise<SkillProposalSummary[]>
  /**
   * 手动晋升：产出一条 `skill_promotion` 审批项（不落任何一层）。
   *
   * WP69（54 §3）目标层从两档变四档：公司 / 部门 / **岗位** / **职责**。
   * 提到岗位层或职责层时要 `scope_id`（哪个岗位 / 哪条职责）——没有它写不下去，
   * 因为那两层的 owner 就是那个 id。
   */
  promote(input: {
    skill: string
    section_ids: string[]
    to_tier: PromotionTier
    scope_id?: string
    by: PersonId
  }): Promise<{ accepted: boolean; approval_item_id?: string; reason?: string }>
  /**
   * WP69（54 §3）：某一层记忆的一句话（岗位页"记忆"tab 的标题行）。
   * 只数，不出正文——正文由 {@link LearningAssembly.memoryAt} 给。
   */
  memorySummary(target: { tier: SkillTier; scope_id?: string }): string
  /** WP69：某一层记忆里有哪几段。WP71 起每条带 `id`，可改可删。 */
  memoryAt(target: { tier: SkillTier; scope_id?: string }): MemoryEntry[]
  /**
   * WP71（36 §10）：**手动加一条**。
   *
   * 落在这一层自己的技能记录里（`skills/positions/<id>` / `skills/roles/<id>` 那份），
   * 不是 overlay——overlay 是"在上游某一段上打的补丁"，而手动加的这句话上游没有对应段。
   * 下一次这一层被解析时它作为新的一段并进去（`resolve` 里"base 里没有的段就 push"）。
   */
  addMemory(input: MemoryWriteInput): Promise<MemoryEntry>
  /** WP71：改一条（正文，可带标题）。只改本层那一条，别的层一个字不动。 */
  updateMemory(id: string, input: { text: string; heading?: string }): Promise<MemoryEntry>
  /** WP71：删一条。手动加的从这一层的技能记录里删；提升来的从 overlay 的 ops 里摘掉。 */
  removeMemory(id: string): Promise<void>
  close(): void
}

const CARD_KINDS = new Set(['skill_lesson', 'skill_promotion', 'knowledge_update'])

/** 层的人话名（卡面上与"记忆"tab 上都用它，别在两处各写一份）。 */
const TIER_LABEL: Readonly<Record<SkillTier, string>> = Object.freeze({
  package: '包基础',
  company: '公司',
  department: '部门',
  position: '岗位',
  role: '职责',
  personal: '个人',
})

export function createLearningAssembly(options: LearningOptions): LearningAssembly {
  const { clock, skills, workspace_id } = options
  let seq = 0
  const nextId = (): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff).toString(36)
    return `les_${rand}${seq.toString(36)}`
  }
  const learning = createLearning({
    clock,
    nextId,
    ...(options.dbDir === undefined ? {} : { dbPath: join(options.dbDir, 'learning.sqlite') }),
  })
  const cards = new Map<string, LessonProposalCard>()

  let traceSeq = 0
  const emit = (type: string, payload: Record<string, unknown>, subject?: string): void => {
    traceSeq += 1
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'system', id: 'learning' },
      ...(subject === undefined ? {} : { subject: { type: 'approval_item', id: subject } }),
      // 学习回路是请求之外的后台动作：没有外面那条 trace 时自己起一条（21 §1）
      correlation: { trace_id: `tr_learn_${String(traceSeq).padStart(6, '0')}` },
      payload,
    })
  }

  /** 这张卡属于哪个技能：岗位配的第一个 always 技能，拿不到就退回职责 id。 */
  const skillOf = (item: ApprovalItem): string => {
    const assignment_id = item.proposer.assignment_id
    if (assignment_id !== undefined) {
      try {
        const config = options.roles.effectiveConfig(assignment_id)
        const hit = config.skills.find((s) => s.load === 'always') ?? config.skills[0]
        if (hit !== undefined) return hit.name
      } catch {
        // 岗位没了 / 撤销了：退回职责 id，别让抽取整条挂掉
      }
    }
    return item.role_id
  }

  const decisionOf = (item: ApprovalItem, input: DecideInput): HumanDecision | undefined => {
    const d = item.decision
    if (d === undefined) return undefined
    const action =
      d.action === 'approve' ||
      d.action === 'approve_edited' ||
      d.action === 'reject' ||
      d.action === 'redirect'
        ? d.action
        : undefined
    if (action === undefined) return undefined
    const before = textOf(item.payload)
    const after = textOf(d.edited_payload)
    const boundary = boundaryOf(item, input)
    return {
      approval_item_id: item.id,
      action,
      at: d.at,
      ...(d.reason === undefined ? {} : { reason: d.reason }),
      ...(after === undefined
        ? {}
        : { edit_diff: { ...(before === undefined ? {} : { before }), after } }),
      ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
      ...(boundary === undefined ? {} : { boundary }),
    }
  }

  /** 一张卡被决定之后：抽 lesson 入池。技能 / 知识类卡本身不产 lesson（它们是产物）。 */
  const observe = (item: ApprovalItem, input: DecideInput): void => {
    if (CARD_KINDS.has(item.kind)) return
    const decision = decisionOf(item, input)
    if (decision === undefined) return
    const assignment_id = item.proposer.assignment_id ?? options.ownerAssignment.id
    const extractInput: ExtractInput = {
      workspace_id,
      assignment_id,
      run_id: item.evidence.run_id ?? `card_${item.id}`,
      at: decision.at,
      applies_to: { skill: skillOf(item) },
      decisions: [decision],
    }
    for (const lesson of extractLessons(extractInput)) {
      const pooled = learning.pool.pool(lesson)
      emit('lesson.pooled', {
        lesson_id: pooled.id,
        skill: pooled.applies_to.skill,
        signal: pooled.signal,
        hits: pooled.hits,
        confidence: pooled.confidence,
      })
    }
  }

  /** 采纳一张 `skill_lesson` 卡：写 overlay。人没选就当"都不要"。 */
  const applyLesson = async (item: ApprovalItem, input: DecideInput): Promise<void> => {
    const payload = item.payload as SkillLessonPayload
    const card = cards.get(item.id) ?? cardFrom(item, payload, workspace_id)
    const accepted = item.state === 'approved' || item.state === 'approved_edited'
    const edited = (item.decision?.edited_payload as { text?: string } | undefined)?.text
    const out = await applyLessonDecision(
      {
        proposal: card,
        action: accepted ? 'accept' : 'reject',
        owner: item.decision?.by ?? options.owner,
        by: item.decision?.by ?? options.owner,
        at: item.decision?.at ?? clock.now(),
        ...(input.selected_option_id === undefined
          ? {}
          : { selected_option_id: input.selected_option_id }),
        ...(edited === undefined ? {} : { edited_text: edited }),
        ...(item.decision?.reason === undefined ? {} : { reason: item.decision.reason }),
      },
      { registry: skills.registry, pool: learning.pool },
    )
    emit(
      out.status === 'applied' ? 'skill.overlay.changed' : 'lesson.ignored',
      {
        skill: card.skill,
        status: out.status,
        ops: out.ops.length,
        ...(out.skill_version === undefined ? {} : { version: out.skill_version }),
        ...(out.blacklisted === undefined ? {} : { blacklisted: out.blacklisted }),
      },
      item.id,
    )
  }

  /** 采纳一张 `skill_promotion` 卡：把段落写到目标层的 overlay 上。 */
  const applyPromotion = async (item: ApprovalItem): Promise<void> => {
    const payload = item.payload as SkillPromotionPayload
    const section_id = payload.section_ids[0]
    if (section_id === undefined) throw new Error('晋升卡没有段 id，无法施行')
    const ops = payload.section_ids.map((id) => ({
      op: 'replace' as const,
      section_id: id,
      body: payload.proposed_text,
      origin: 'learned' as const,
      learned_from: { lessons: payload.lessons, at: item.decision?.at ?? clock.now() },
    }))
    // WP69（54 §3）：岗位层与职责层的 owner 就是那个 id（`skills/positions/<id>` /
    // `skills/roles/<id>`）；公司层是工作区，部门层沿用卡上的职责 id（老行为不动）。
    const owner =
      payload.to_tier === 'company'
        ? workspace_id
        : payload.to_tier === 'position' || payload.to_tier === 'role'
          ? (payload.scope_id ?? (item.role_id as string))
          : (item.role_id as string)
    const existing = skills.registry.getOverlay(payload.skill, payload.to_tier, owner)
    await skills.registry.setOverlay({
      skill: payload.skill,
      tier: payload.to_tier,
      owner,
      ops,
      base_version: existing?.base_version ?? '0.0.0',
      version: existing?.version ?? 0,
    })
    emit('skill.promoted', { skill: payload.skill, to_tier: payload.to_tier }, item.id)
  }

  /** 采纳一张 `knowledge_update` 卡：写进知识库并激活（19 §1）。 */
  const applyKnowledge = async (item: ApprovalItem): Promise<void> => {
    const p = item.payload as {
      layer?: 'fact' | 'phrasing' | 'policy'
      statement?: string
      candidate_key?: string
      category?: string
    }
    const statement = p.statement ?? ''
    if (statement.trim() === '') throw new Error('知识卡没有正文，无法写入')
    const card = await options.knowledge.store.propose({
      schema_version: 1,
      workspace_id,
      layer: p.layer ?? 'fact',
      domain: 'company',
      scope: [],
      sensitivity: 'internal',
      subject: { type: 'company', key: p.candidate_key ?? item.id },
      statement,
      provenance: [{ source: 'document', ref: `approval:${item.id}`, at: clock.now() }],
      confidence: { value: 0.9, state: 'probable' },
      valid: {},
      owner: item.decision?.by ?? options.owner,
      created_by: { kind: 'person', id: item.decision?.by ?? options.owner },
    })
    await options.knowledge.store.activate(card.id, item.decision?.by ?? options.owner)
    emit('knowledge.card.activated', { card_id: card.id, layer: card.layer }, item.id)
  }

  /**
   * 按 kind 分发施行。这三类没有外部副作用，所以失败一律 `apply_failed`——
   * `unknown` 是留给"发出去了但不知道对面收没收到"的（15 §5.9）。
   */
  const applyDecided = async (
    bus: ApprovalBus,
    item: ApprovalItem,
    input: DecideInput,
  ): Promise<void> => {
    if (!CARD_KINDS.has(item.kind)) return
    const decided =
      item.state === 'approved' || item.state === 'approved_edited' || item.state === 'rejected'
    if (!decided) return
    // 驳回只有技能建议要记（进黑名单）；知识与晋升驳回就是不写
    if (item.state === 'rejected' && item.kind !== 'skill_lesson') return
    const at = clock.now()
    const record = (bus as Partial<{ recordApply: RecordApply }>).recordApply
    try {
      if (item.kind === 'skill_lesson') await applyLesson(item, input)
      else if (item.kind === 'skill_promotion') await applyPromotion(item)
      else await applyKnowledge(item)
      await record?.call(bus, item.id, 'applied', {
        attempts: [
          { at, by_executor: 'learning', idempotency_key: item.id, result: 'ok' as const },
        ],
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit('learning.apply_failed', { kind: item.kind, message }, item.id)
      await record?.call(bus, item.id, 'apply_failed', {
        attempts: [
          {
            at,
            by_executor: 'learning',
            idempotency_key: item.id,
            result: 'failed' as const,
            error: message,
          },
        ],
      })
    }
  }

  const cardEnvelope = (
    kind: 'skill_lesson' | 'skill_promotion',
  ): Omit<
    CreateApprovalInput<unknown>,
    'kind' | 'subject' | 'dedupe_key' | 'title' | 'summary' | 'payload' | 'evidence'
  > => ({
    workspace_id,
    schema_version: 1,
    role_id: options.ownerAssignment.role_id,
    proposer: { kind: 'system', id: 'learning' },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [
        { person: options.owner, via: kind === 'skill_lesson' ? 'role_holder' : 'owner' },
      ],
      rule: kind === 'skill_lesson' ? 'role_holder' : 'owner',
      escalation: {
        after_hours: 72,
        business_hours: true,
        chain: ['owner'],
        escalated_at: [],
      },
      separation_of_duties: false,
    },
    priority: 'queue',
  })

  const proposeDaily: LearningAssembly['proposeDaily'] = async (now) => {
    const { proposals, filtered } = draftProposals({
      workspace_id,
      lessons: learning.pool.list({ workspace_id }),
      skills: skillReaderOf(skills.registry),
      now,
      ...(options.policySkills === undefined ? {} : { policySkills: options.policySkills }),
      rejectedKeys: learning.pool.rejectedKeys(workspace_id).map((r) => r.semantic_key),
    })
    const created: string[] = []
    for (const card of proposals) {
      const payload: SkillLessonPayload = {
        form: 'skill_lesson',
        skill: card.skill,
        section_id: card.section_id,
        heading: card.heading,
        semantic_key: card.semantic_key,
        proposed_text: card.diff.after,
        options: card.options,
        hits: card.hits,
        confidence: card.confidence,
        lessons: card.lessons,
        quotes: card.evidence.quotes,
        run_ids: card.evidence.run_ids,
      }
      const item = await options.approvals.create({
        ...cardEnvelope('skill_lesson'),
        kind: 'skill_lesson',
        subject: { object: { type: 'skill', id: card.skill } },
        // 14 §4：`skill_*` 的去重键是 (skill, section)——同一段一天只问一次
        dedupe_key: `${workspace_id}:skill_lesson:${card.skill}:${card.section_id}`,
        title: card.title,
        summary: card.summary,
        payload,
        evidence: {
          source_events: [],
          diff: card.diff,
          provenance: { seen: [{ type: 'skill', id: card.skill }] },
          precheck: { permission_diff: 'ok' },
        },
        options: card.options.map((o) => ({ id: o.id, label: o.label })),
      })
      if (item.state === 'blocked') continue
      cards.set(item.id, card)
      for (const id of card.lessons) learning.pool.mark(id, 'proposed', now)
      created.push(item.id)
      emit('lesson.proposed', { skill: card.skill, hits: card.hits }, item.id)
    }
    return { created, filtered }
  }

  const weeklyConsolidate: LearningAssembly['weeklyConsolidate'] = async (ws, now) => {
    const { cards: promotions } = weeklyPromotions({
      workspace_id: ws,
      lessons: learning.pool.list({ workspace_id: ws }),
      now,
      from: { tier: 'personal', owner: options.owner },
      ...(options.policySkills === undefined ? {} : { policySkills: options.policySkills }),
    })
    for (const card of promotions) {
      const payload: SkillPromotionPayload = {
        form: 'skill_promotion',
        skill: card.skill,
        section_ids: card.section_ids,
        from: card.from,
        to_tier: card.to_tier,
        proposed_text: card.proposed_text,
        contributors: card.contributors,
        criteria: card.criteria,
        lessons: card.evidence.lessons,
      }
      await options.approvals.create({
        ...cardEnvelope('skill_promotion'),
        kind: 'skill_promotion',
        subject: { object: { type: 'skill', id: card.skill } },
        dedupe_key: `${ws}:skill_promotion:${card.skill}:${card.section_ids.join(',')}`,
        title: card.title,
        summary: card.summary,
        payload,
        evidence: {
          source_events: [],
          diff: card.diff,
          provenance: { seen: [{ type: 'skill', id: card.skill }] },
          precheck: { permission_diff: 'ok' },
        },
      })
    }
    return { proposals: promotions }
  }

  const promote: LearningAssembly['promote'] = async (input) => {
    // WP69：岗位层 / 职责层的 owner 就是那个 id，没有它这条提议落不到任何地方
    if ((input.to_tier === 'position' || input.to_tier === 'role') && input.scope_id === undefined)
      return {
        accepted: false,
        reason: `提到${TIER_LABEL[input.to_tier]}层要说清楚是哪一个（scope_id）`,
      }
    const overlay = skills.registry.getOverlay(input.skill, 'personal', input.by)
    const ops = (overlay?.ops ?? []).filter((o) => input.section_ids.includes(o.section_id))
    if (ops.length === 0) {
      return { accepted: false, reason: '个人层上没有这几段的修改，没有可以提上去的东西' }
    }
    const lessons = learning.pool
      .list({ workspace_id, skill: input.skill, status: 'accepted' })
      .filter(
        (l) =>
          l.applies_to.section_id === undefined ||
          input.section_ids.includes(l.applies_to.section_id),
      )
    const proposed_text = ops
      .map((o) => o.body ?? '')
      .join('\n\n')
      .trim()
    const contributors = [...new Set(lessons.flatMap((l) => l.assignments))]
    const criteria = promotionCriteria({
      accepted: lessons.reduce((n, l) => n + l.hits, 0),
      samples: learning.pool
        .list({ workspace_id, skill: input.skill })
        .reduce((n, l) => n + l.hits, 0),
      contributors: contributors.length,
      ...(lessons.length === 0
        ? {}
        : { oldest_at: lessons.map((l) => l.created_at).sort()[0] as Iso8601 }),
      now: clock.now(),
    })
    const payload: SkillPromotionPayload = {
      form: 'skill_promotion',
      skill: input.skill,
      section_ids: [...input.section_ids],
      from: { tier: 'personal', owner: input.by },
      to_tier: input.to_tier,
      ...(input.scope_id === undefined ? {} : { scope_id: input.scope_id }),
      proposed_text,
      contributors,
      criteria,
      lessons: lessons.map((l) => l.id),
    }
    const item = await options.approvals.create({
      ...cardEnvelope('skill_promotion'),
      kind: 'skill_promotion',
      subject: { object: { type: 'skill', id: input.skill } },
      dedupe_key: `${workspace_id}:skill_promotion:${input.skill}:${input.to_tier}:${input.scope_id ?? ''}:${input.section_ids.join(',')}`,
      title: `把「${input.skill}」的 ${input.section_ids.length} 段提到${TIER_LABEL[input.to_tier]}层${
        input.scope_id === undefined ? '' : `（${input.scope_id}）`
      }`,
      summary: '通过之后目标层版本 +1，个人层里已合并的那几段会被移除（24 §2）。',
      payload,
      evidence: {
        source_events: [],
        diff: { before: null, after: proposed_text, summary: `${input.skill} 段级晋升` },
        provenance: { seen: [{ type: 'skill', id: input.skill }] },
        precheck: { permission_diff: 'ok' },
      },
    })
    if (item.state === 'blocked') {
      return {
        accepted: false,
        reason: (item.evidence.precheck.notes ?? ['预检没过']).join('；'),
      }
    }
    return { accepted: true, approval_item_id: item.id }
  }

  const proposalSummaries: LearningAssembly['proposalSummaries'] = async () => {
    const items = await options.approvals.queue({
      workspace_id,
      person_id: options.owner,
      lane: 'mine',
      kind: 'skill_lesson',
    })
    return items.map((item) => {
      // 提案卡有两个来源：夜间整理（payload 齐全）与 36 §2.1 的「指导 → similar_cases」
      // （payload 只有一句话）。技能页两种都要能列，所以这里逐项兜底。
      const p = (item.payload ?? {}) as Partial<SkillLessonPayload> & { text?: string }
      return {
        approval_item_id: item.id,
        skill: p.skill ?? item.role_id,
        section_id: p.section_id ?? '',
        heading: p.heading ?? '',
        title: item.title,
        summary: item.summary,
        hits: p.hits ?? 1,
        confidence: p.confidence ?? 0,
        options: (p.options ?? item.options ?? []).map((o) => ({ id: o.id, label: o.label })),
        quotes: p.quotes ?? (p.text === undefined ? [] : [p.text]),
        diff: (item.evidence.diff ?? {
          before: null,
          after: p.proposed_text ?? '',
          summary: p.heading ?? '',
        }) as SkillProposalSummary['diff'],
      }
    })
  }

  const summaries: LearningAssembly['summaries'] = async (actor) => {
    const pending = await proposalSummaries()
    const names = [...new Set(skills.registry.listSkillNames())].sort()
    const out: SkillSummary[] = []
    for (const name of names) {
      const sections = skills.registry.listSections(name)
      const excluded = skills.registry.isExcluded(name, actor.person_id)
      let version = ''
      let tier = ''
      for (const t of ['personal', 'department', 'company', 'package'] as const) {
        const found = await skills.registry.get(name, t, { workspace_id: actor.workspace_id })
        if (found !== undefined) {
          version = found.version
          tier = found.tier
          break
        }
      }
      const overlays = skills.registry
        .listOverlays(name)
        .filter((o) => o.tier !== 'package')
        // 40 E1「管理员对个人数据没有读」：个人层是**本人的**。
        // 在这之前技能页把工作区里每个人的个人层正文都端出来了——
        // 公司层与部门层是公共的，个人层不是（21 §3 敏感级，默认 confidential）。
        .filter((o) => o.tier !== 'personal' || String(o.owner) === actor.person_id)
        .map((o) => ({
          tier: o.tier as 'company' | 'department' | 'personal',
          owner: String(o.owner),
          version: o.version,
          base_version: o.base_version,
          ops: o.ops.map((op) => {
            const heading = sections.find((s) => s.id === op.section_id)?.heading
            return {
              op: op.op,
              section_id: op.section_id,
              ...(heading === undefined ? {} : { heading }),
              origin: op.origin ?? ('authored' as const),
              ...(op.body === undefined ? {} : { body: op.body }),
              ...(op.learned_from === undefined ? {} : { learned_from: op.learned_from }),
            }
          }),
        }))
      out.push({
        name,
        tier,
        version,
        excluded,
        sections: sections.map((s) => ({ id: s.id, heading: s.heading, origin: s.origin })),
        overlays,
        pending_proposals: pending.filter((p) => p.skill === name).length,
      })
    }
    return out
  }

  const lessons: LearningAssembly['lessons'] = (filter) =>
    learning.pool
      .list({
        ...(filter.workspace_id === undefined ? {} : { workspace_id: filter.workspace_id }),
        ...(filter.status === undefined ? {} : { status: filter.status }),
      })
      .map((l) => ({
        id: l.id,
        run_id: l.run_id,
        assignment_id: l.assignment_id,
        workspace_id: l.workspace_id,
        skill: l.applies_to.skill,
        ...(l.applies_to.section_id === undefined ? {} : { section_id: l.applies_to.section_id }),
        signal: l.signal,
        strength: l.strength,
        text: l.text,
        confidence: l.confidence,
        confirmations: l.hits,
        status: l.status,
        created_at: l.created_at,
        updated_at: l.updated_at,
        ...(l.proposed_at === undefined ? {} : { proposed_at: l.proposed_at }),
        runs: [...l.runs],
        assignments: [...l.assignments],
      }))

  /**
   * WP69（54 §3）：某一层记忆里有哪几段。
   *
   * 读的是**那一层的 overlay**（`owner` 就是 scope_id：岗位 id / 职责 id / 工作区 id）。
   * 只读：岗位页的"记忆"tab 列它们，改要走"提到这一层"那条提议 → 批准的路。
   */
  /**
   * 这一层的 owner：公司层是工作区，其余几层就是那个 id（岗位 id / 职责 id / 部门 id）。
   * 与 `applyPromotion` 里那段同一条规则——记忆读写两侧必须对上，否则手动加的那条
   * 与提升上来的那条会落在两个不同的 owner 下。
   */
  const ownerOf = (target: { tier: SkillTier; scope_id?: string }): string =>
    target.tier === 'company' ? workspace_id : (target.scope_id ?? '')

  /** 技能记录按 `(workspace, scope)` 索引；公司层不带 scope。 */
  const scopeRefOf = (target: { tier: SkillTier; scope_id?: string }): SkillScopeRef => ({
    workspace_id,
    ...(target.tier === 'company' || target.scope_id === undefined || target.scope_id === ''
      ? {}
      : { scope_id: target.scope_id }),
  })

  /** 手动加的那条是谁、什么时候加的。与 overlay 一样是内存档（`packages/skills` 没有落盘层）。 */
  const manualMeta = new Map<string, { by: PersonId; at: Iso8601 }>()

  /** 没给标题就从正文头一句里取一截当标题（段落要有标题才在技能文档里立得住）。 */
  const headingOf = (text: string): string => {
    const first = text.split('\n')[0]?.trim() ?? text
    return first.length <= 24 ? first : `${first.slice(0, 24)}…`
  }

  const memoryAt: LearningAssembly['memoryAt'] = (target) => {
    const owner = ownerOf(target)
    if (owner === '') return []
    const out: MemoryEntry[] = []
    for (const name of skills.registry.listSkillNames()) {
      // WP71：手动加的那些——住在这一层自己的技能记录里，每一段就是一条记忆
      const own = skills.registry.peek(name, target.tier, scopeRefOf(target))
      for (const section of own?.sections ?? []) {
        const ref: MemoryRef = {
          source: 'manual',
          tier: target.tier,
          owner,
          skill: name,
          section_id: section.id,
        }
        const meta = manualMeta.get(memoryRefId(ref))
        out.push({
          id: memoryRefId(ref),
          skill: name,
          section_id: section.id,
          heading: section.heading,
          body: section.body,
          origin: section.origin,
          ...(section.learned_from === undefined ? {} : { learned_from: section.learned_from }),
          source: 'manual',
          ...(meta === undefined ? {} : { added_by: meta.by, added_at: meta.at }),
        })
      }
      // 提升批下来的那些——这一层 overlay 上的 op（WP69 起就是这样）
      const overlay = skills.registry.getOverlay(name, target.tier, owner)
      if (overlay === undefined) continue
      for (const op of overlay.ops) {
        if (op.op === 'remove') continue
        const heading = skills.registry.sectionHeading(name, op.section_id)
        out.push({
          id: memoryRefId({
            source: 'promoted',
            tier: target.tier,
            owner,
            skill: name,
            section_id: op.section_id,
          }),
          skill: name,
          section_id: op.section_id,
          ...(heading === undefined ? {} : { heading }),
          body: op.body ?? '',
          origin: op.origin ?? 'authored',
          ...(op.learned_from === undefined ? {} : { learned_from: op.learned_from }),
          source: 'promoted',
        })
      }
    }
    return out.sort((a, b) =>
      a.skill === b.skill ? a.section_id.localeCompare(b.section_id) : a.skill < b.skill ? -1 : 1,
    )
  }

  /**
   * WP71：手动加一条。
   *
   * 写进**这一层自己的技能记录**（不是 overlay，理由见 `LearningAssembly.addMemory`）。
   * 这一层还没有记录就当场建一份最小的：名字沿用同一个技能名，`base` 指着当前上游版本，
   * 这样之后上游出新版时 `rebase` 那条路对它一样管用。
   */
  const addMemory: LearningAssembly['addMemory'] = async (input) => {
    const owner = ownerOf(input)
    if (owner === '') throw new Error('这一层要说清楚是哪一个（scope_id）')
    const text = input.text.trim()
    if (text === '') throw new Error('记忆条目不能是空的')
    const name = input.skill ?? DEFAULT_SKILL_NAME
    const scope = scopeRefOf(input)
    const existing = skills.registry.peek(name, input.tier, scope)
    const section = {
      id: skills.nextId(),
      heading: (input.heading ?? '').trim() === '' ? headingOf(text) : (input.heading as string),
      body: text,
      origin: 'authored' as const,
    }
    await skills.registry.put({
      name,
      tier: input.tier,
      owner,
      version: existing?.version ?? '1.0.0',
      evals: existing?.evals ?? [],
      sections: [...(existing?.sections ?? []), section],
      ...(existing?.base === undefined ? {} : { base: existing.base }),
      workspace_id,
      ...(scope.scope_id === undefined ? {} : { scope_id: scope.scope_id }),
    })
    const ref: MemoryRef = {
      source: 'manual',
      tier: input.tier,
      owner,
      skill: name,
      section_id: section.id,
    }
    const at = clock.now()
    manualMeta.set(memoryRefId(ref), { by: input.by, at })
    emit('memory.added', { tier: input.tier, scope_id: owner, skill: name })
    return {
      id: memoryRefId(ref),
      skill: name,
      section_id: section.id,
      heading: section.heading,
      body: section.body,
      origin: 'authored',
      source: 'manual',
      added_by: input.by,
      added_at: at,
    }
  }

  const updateMemory: LearningAssembly['updateMemory'] = async (id, input) => {
    const ref = parseMemoryRef(id)
    if (ref === undefined) throw new Error(`认不出这条记忆：${id}`)
    const text = input.text.trim()
    if (text === '') throw new Error('记忆条目不能是空的')
    const scope = scopeRefOf({ tier: ref.tier, scope_id: ref.owner })
    if (ref.source === 'manual') {
      const own = skills.registry.peek(ref.skill, ref.tier, scope)
      const hit = own?.sections.find((s) => s.id === ref.section_id)
      if (own === undefined || hit === undefined) throw new Error(`没有这条记忆：${id}`)
      const heading = (input.heading ?? '').trim() === '' ? hit.heading : (input.heading as string)
      await skills.registry.put({
        ...own,
        sections: own.sections.map((s) =>
          s.id === ref.section_id ? { ...s, heading, body: text } : s,
        ),
      })
    } else {
      const overlay = skills.registry.getOverlay(ref.skill, ref.tier, ref.owner)
      const hit = overlay?.ops.find((o) => o.section_id === ref.section_id)
      if (overlay === undefined || hit === undefined) throw new Error(`没有这条记忆：${id}`)
      await skills.registry.setOverlay({
        ...overlay,
        ops: overlay.ops.map((o) =>
          o.section_id === ref.section_id ? { ...o, body: text } : { ...o },
        ),
      })
    }
    emit('memory.updated', { tier: ref.tier, scope_id: ref.owner, skill: ref.skill })
    const found = memoryAt({
      tier: ref.tier,
      ...(ref.tier === 'company' ? {} : { scope_id: ref.owner }),
    }).find((e) => e.id === id)
    if (found === undefined) throw new Error(`没有这条记忆：${id}`)
    return found
  }

  const removeMemory: LearningAssembly['removeMemory'] = async (id) => {
    const ref = parseMemoryRef(id)
    if (ref === undefined) throw new Error(`认不出这条记忆：${id}`)
    const scope = scopeRefOf({ tier: ref.tier, scope_id: ref.owner })
    if (ref.source === 'manual') {
      const own = skills.registry.peek(ref.skill, ref.tier, scope)
      if (own === undefined || !own.sections.some((s) => s.id === ref.section_id))
        throw new Error(`没有这条记忆：${id}`)
      await skills.registry.put({
        ...own,
        sections: own.sections.filter((s) => s.id !== ref.section_id),
      })
      manualMeta.delete(id)
    } else {
      const overlay = skills.registry.getOverlay(ref.skill, ref.tier, ref.owner)
      if (overlay === undefined || !overlay.ops.some((o) => o.section_id === ref.section_id))
        throw new Error(`没有这条记忆：${id}`)
      await skills.registry.setOverlay({
        ...overlay,
        ops: overlay.ops.filter((o) => o.section_id !== ref.section_id),
      })
    }
    emit('memory.removed', { tier: ref.tier, scope_id: ref.owner, skill: ref.skill })
  }

  const memorySummary: LearningAssembly['memorySummary'] = (target) => {
    const entries = memoryAt(target)
    if (entries.length === 0) return `${TIER_LABEL[target.tier]}层还没有攒下东西`
    const learned = entries.filter((e) => e.origin === 'learned').length
    return `${TIER_LABEL[target.tier]}层：${entries.length} 段（其中 ${learned} 段是学来的）`
  }

  return {
    learning,
    proposeDaily,
    weeklyConsolidate,
    lessons,
    promote,
    memoryAt,
    memorySummary,
    addMemory,
    updateMemory,
    removeMemory,
    summaries,
    proposalSummaries,
    onRunCompleted(input) {
      const lessons = extractLessons({
        workspace_id,
        assignment_id: input.assignment_id,
        run_id: input.run_id,
        at: clock.now(),
        applies_to: { skill: DEFAULT_SKILL_NAME },
        ...(input.events === undefined ? {} : { events: input.events }),
        ...(input.result?.lessons === undefined ? {} : { reflections: input.result.lessons }),
      })
      for (const l of lessons) learning.pool.pool(l)
    },
    wrap(bus) {
      // 用 Proxy 而不是展开：总线是个类实例，方法在原型上，`{...bus}` 会把它们全丢掉。
      return new Proxy(bus, {
        get(target, prop, receiver) {
          if (prop !== 'decide') {
            const value = Reflect.get(target, prop, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return async (id: string, by: PersonId, input: DecideInput): Promise<ApprovalItem> => {
            const out = await target.decide(id, by, input)
            observe(out, input)
            await applyDecided(target, out, input)
            return out
          }
        },
      })
    },
    async pendingProposals(skill) {
      const items = await options.approvals.queue({
        workspace_id,
        person_id: options.owner,
        lane: 'mine',
        kind: 'skill_lesson',
      })
      return skill === undefined
        ? items
        : items.filter((i) => (i.payload as SkillLessonPayload).skill === skill)
    },
    close: () => learning.close(),
  }
}

type RecordApply = (
  id: string,
  state: 'applying' | 'applied' | 'apply_failed',
  apply: ApprovalItem['apply'],
) => Promise<void>

/** 技能库为空时铺一份自带技能：没有段落，学习回路无处落脚。 */
export async function seedDefaultSkill(skills: Skills, workspace_id: WorkspaceId): Promise<void> {
  if (skills.registry.listSections(DEFAULT_SKILL_NAME).length > 0) return
  await skills.registry.putFromMarkdown({
    markdown: DEFAULT_SKILL_MD,
    tier: 'package',
    owner: 'package',
    version: '1.0',
    workspace_id,
  })
}

function textOf(payload: unknown): string | undefined {
  if (payload === undefined || payload === null || typeof payload !== 'object') return undefined
  const p = payload as Record<string, unknown>
  const body = (p.body ?? {}) as Record<string, unknown>
  const text = body.text ?? p.text
  return typeof text === 'string' && text.trim() !== '' ? text : undefined
}

function boundaryOf(
  item: ApprovalItem,
  input: DecideInput,
): { id: string; question: string; answer: string } | undefined {
  if (item.kind !== 'policy_change') return undefined
  const selected = input.selected_option_id
  if (selected === undefined || selected === OPTION_NONE) return undefined
  const option = item.options?.find((o) => o.id === selected)
  if (option === undefined) return undefined
  const p = item.payload as { boundary_id?: string }
  return {
    id: p.boundary_id ?? item.subject.object.id,
    question: item.title,
    answer: option.label,
  }
}

/** 提案卡回读成 `LessonProposalCard`（进程重启后卡还在，内存里的那份没了）。 */
function cardFrom(
  item: ApprovalItem,
  payload: SkillLessonPayload,
  workspace_id: WorkspaceId,
): LessonProposalCard {
  return {
    workspace_id,
    skill: payload.skill,
    section_id: payload.section_id,
    heading: payload.heading,
    semantic_key: payload.semantic_key,
    assignment_id: item.proposer.assignment_id ?? '',
    title: item.title,
    summary: item.summary,
    options: payload.options,
    diff: (item.evidence.diff ?? {
      before: null,
      after: payload.proposed_text,
      summary: payload.heading,
    }) as LessonProposalCard['diff'],
    evidence: {
      quotes: payload.quotes,
      run_ids: payload.run_ids,
      approval_item_ids: [item.id],
    },
    hits: payload.hits,
    confidence: payload.confidence,
    lessons: payload.lessons,
    created_at: item.created_at,
  }
}
