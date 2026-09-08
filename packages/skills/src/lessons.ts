import type {
  AssignmentId,
  Clock,
  ErrorCode,
  Iso8601,
  LessonPool,
  LessonRecord,
  RunId,
  SkillTier,
  WorkspaceId,
} from '@agentsws/contracts'
import { invalidInput, notFound } from './errors.js'
import type { IdFactory } from './ids.js'
import type { MemorySkillRegistry } from './registry.js'
import { TIER_ORDER } from './registry.js'
import { jaccard } from './text.js'

/** 24 §3：信号强度 → 初始置信度。 */
export const STRENGTH_CONFIDENCE: Readonly<Record<LessonRecord['strength'], number>> = {
  strong: 0.6,
  medium: 0.4,
  weak: 0.25,
}
/** 确认 +0.15、忽略 ×0.7、驳回 → 0（24 §3）。 */
export const CONFIRM_STEP = 0.15
export const CONFIDENCE_CAP = 0.99
export const IGNORE_DECAY = 0.7
/** 同 skill + 段 + 相似文本合并的阈值。 */
export const MERGE_SIMILARITY = 0.7
/** 夜间整理默认置信度门槛。 */
export const DEFAULT_THRESHOLD = 0.6
/** 策略层关键词：命中即永不进学习回路（24 §3）。 */
export const POLICY_KEYWORDS: readonly string[] = ['策略', 'policy', '额度', 'mandate']

/** 07 §1 第 3 条：量化晋升判据。 */
export const PROMOTION_CRITERIA = {
  min_confidence: 0.9,
  min_adoptions: 5,
  min_contributors: 2,
  min_age_days: 14,
} as const

const DAY_MS = 86_400_000

export interface LessonRecordEx extends LessonRecord {
  /** 合并后仍要能数出“几个人（几个 assignment）”，契约单值不够用 */
  assignments: AssignmentId[]
  runs: RunId[]
  updated_at: Iso8601
  proposed_at?: Iso8601
}

export type PoolInput = Omit<
  LessonRecord,
  'id' | 'confirmations' | 'status' | 'created_at' | 'confidence'
> & { confidence?: number }

export interface LessonProposal {
  skill: string
  section_id?: string
  proposed_text: string
  lessons: string[]
  assignment_id: AssignmentId
  confidence: number
  confirmations: number
}

export interface FilteredCluster {
  skill: string
  section_id?: string
  reason: 'policy_layer'
  lessons: string[]
}

export interface ConsolidateResult {
  proposals: LessonProposal[]
  filtered: FilteredCluster[]
}

export interface PromotionCriteriaCheck {
  confidence: number
  adoptions: number
  contributors: number
  age_days: number
  passed: boolean
  missing: string[]
}

export interface PromotionProposal {
  skill: string
  section_id?: string
  to_tier: SkillTier
  evidence: string[]
  contributors: AssignmentId[]
  proposed_text: string
  criteria: PromotionCriteriaCheck
}

export interface EvalResult {
  status: 'green' | 'red' | 'unknown'
  failed?: string[]
  detail?: string
}

export interface PromotionRequest {
  skill: string
  section_ids: string[]
  from: { tier: SkillTier; owner: string }
  to_tier: SkillTier
  evidence?: string[]
  contributors?: AssignmentId[]
  /** 本包不跑 eval，只接受结果；红则拒绝（24 §6.6 预检 blocked） */
  evalResult?: EvalResult
  /** 是否强制 07 §1 的量化判据；默认只计算不拦 */
  enforce_criteria?: boolean
  now?: Iso8601
}

export type PromotionOutcome =
  | { accepted: false; code: ErrorCode; reason: string; criteria?: PromotionCriteriaCheck }
  | {
      accepted: true
      criteria?: PromotionCriteriaCheck
      approval_request: {
        kind: 'skill_promotion'
        skill: string
        section_ids: string[]
        from: { tier: SkillTier; owner: string }
        to_tier: SkillTier
        evidence: string[]
        contributors: AssignmentId[]
        created_at: Iso8601
      }
    }

export interface LessonPoolOptions {
  /** 策略层 skill 名单：这些 skill 永不进学习回路 */
  policySkills?: Iterable<string>
}

export class MemoryLessonPool {
  readonly #lessons = new Map<string, LessonRecordEx>()
  readonly #registry: MemorySkillRegistry
  readonly #clock: Clock
  readonly #nextId: IdFactory
  readonly #policySkills: Set<string>

  constructor(
    registry: MemorySkillRegistry,
    clock: Clock,
    nextId: IdFactory,
    options: LessonPoolOptions = {},
  ) {
    this.#registry = registry
    this.#clock = clock
    this.#nextId = nextId
    this.#policySkills = new Set(options.policySkills ?? [])
  }

  // ---------- 池 ----------

  /**
   * 24 §3：零打扰入池。同一人（assignment）同 skill 同段的相似文本合并成一条，
   * confirmations +1、置信度 +0.15（封顶 0.99）。
   */
  async pool(input: PoolInput): Promise<LessonRecordEx> {
    const now = this.#clock.now()
    const existing = this.#findMergeTarget(input)
    if (existing !== undefined) {
      existing.confirmations += 1
      existing.confidence = Math.min(CONFIDENCE_CAP, existing.confidence + CONFIRM_STEP)
      existing.updated_at = now
      if (!existing.runs.includes(input.run_id)) existing.runs.push(input.run_id)
      if (!existing.assignments.includes(input.assignment_id)) {
        existing.assignments.push(input.assignment_id)
      }
      if (existing.status === 'ignored') existing.status = 'pooled'
      return { ...existing }
    }
    const record: LessonRecordEx = {
      id: this.#nextId(),
      run_id: input.run_id,
      assignment_id: input.assignment_id,
      workspace_id: input.workspace_id,
      skill: input.skill,
      ...(input.section_id === undefined ? {} : { section_id: input.section_id }),
      signal: input.signal,
      strength: input.strength,
      text: input.text,
      confidence: STRENGTH_CONFIDENCE[input.strength],
      confirmations: 1,
      status: 'pooled',
      created_at: now,
      updated_at: now,
      assignments: [input.assignment_id],
      runs: [input.run_id],
    }
    this.#lessons.set(record.id, record)
    return { ...record }
  }

  get(id: string): LessonRecordEx | undefined {
    const l = this.#lessons.get(id)
    return l === undefined ? undefined : { ...l }
  }

  list(
    filter: { workspace_id?: WorkspaceId; status?: LessonRecord['status'] } = {},
  ): LessonRecordEx[] {
    return [...this.#lessons.values()]
      .filter(
        (l) =>
          (filter.workspace_id === undefined || l.workspace_id === filter.workspace_id) &&
          (filter.status === undefined || l.status === filter.status),
      )
      .map((l) => ({ ...l }))
  }

  // ---------- 夜间整理 ----------

  /**
   * 24 §3：只产提议，不写任何 overlay。策略层的段（含 policySkills）永不进提议。
   */
  async consolidate(
    workspace_id: WorkspaceId,
    opts: { now: Iso8601; threshold?: number; policySkills?: Iterable<string> },
  ): Promise<ConsolidateResult> {
    const threshold = opts.threshold ?? DEFAULT_THRESHOLD
    const extraPolicy = new Set(opts.policySkills ?? [])
    const candidates = [...this.#lessons.values()].filter(
      (l) => l.workspace_id === workspace_id && l.status === 'pooled' && l.confidence >= threshold,
    )
    const clusters = groupBy(candidates, (l) => clusterKey(l.skill, l.section_id))
    const proposals: LessonProposal[] = []
    const filtered: FilteredCluster[] = []
    for (const group of clusters) {
      const head = group[0]
      if (head === undefined) continue
      if (this.isPolicyTarget(head.skill, head.section_id, extraPolicy)) {
        filtered.push({
          skill: head.skill,
          ...(head.section_id === undefined ? {} : { section_id: head.section_id }),
          reason: 'policy_layer',
          lessons: group.map((l) => l.id),
        })
        continue
      }
      const rep = representative(group)
      if (rep === undefined) continue
      for (const l of group) {
        l.status = 'proposed'
        l.proposed_at = opts.now
      }
      proposals.push({
        skill: rep.skill,
        ...(rep.section_id === undefined ? {} : { section_id: rep.section_id }),
        proposed_text: rep.text,
        lessons: group.map((l) => l.id),
        assignment_id: rep.assignment_id,
        confidence: Math.max(...group.map((l) => l.confidence)),
        confirmations: group.reduce((n, l) => n + l.confirmations, 0),
      })
    }
    return { proposals, filtered }
  }

  /** 接受 → accepted；忽略 → 置信度 ×0.7；驳回 → 0。 */
  async mark(id: string, status: 'accepted' | 'ignored' | 'refuted'): Promise<LessonRecordEx> {
    const lesson = this.#lessons.get(id)
    if (lesson === undefined) throw notFound(`lesson 不存在：${id}`)
    lesson.status = status
    lesson.updated_at = this.#clock.now()
    if (status === 'ignored') lesson.confidence = round(lesson.confidence * IGNORE_DECAY)
    if (status === 'refuted') lesson.confidence = 0
    return { ...lesson }
  }

  // ---------- 每周巩固 ----------

  /**
   * 24 §3 / 06 §3.4：同一 (skill, section) 下 ≥ 2 个不同 assignment 接受了相似修改
   * → 一条晋升提议给部门负责人（仍是提议，不自动改）。
   */
  async weeklyConsolidate(
    workspace_id: WorkspaceId,
    now: Iso8601,
    opts: { to_tier?: SkillTier; policySkills?: Iterable<string> } = {},
  ): Promise<{ proposals: PromotionProposal[] }> {
    const toTier = opts.to_tier ?? 'department'
    const extraPolicy = new Set(opts.policySkills ?? [])
    const accepted = [...this.#lessons.values()].filter(
      (l) => l.workspace_id === workspace_id && l.status === 'accepted',
    )
    const proposals: PromotionProposal[] = []
    for (const group of groupBy(accepted, (l) => clusterKey(l.skill, l.section_id))) {
      const head = group[0]
      if (head === undefined) continue
      if (this.isPolicyTarget(head.skill, head.section_id, extraPolicy)) continue
      for (const cluster of clusterBySimilarity(group)) {
        const contributors = [
          ...new Set(cluster.flatMap((l) => [l.assignment_id, ...l.assignments])),
        ]
        if (contributors.length < 2) continue
        const rep = representative(cluster)
        if (rep === undefined) continue
        proposals.push({
          skill: rep.skill,
          ...(rep.section_id === undefined ? {} : { section_id: rep.section_id }),
          to_tier: toTier,
          evidence: cluster.map((l) => l.id),
          contributors,
          proposed_text: rep.text,
          criteria: criteriaOf(cluster, contributors, now),
        })
      }
    }
    return { proposals }
  }

  /**
   * 晋升入口：本包不跑 eval，只接受结果。红 → 拒绝并给原因（24 §6.6）。
   * 通过也只产出一条 `skill_promotion` 审批请求，不落任何一层。
   */
  async promote(req: PromotionRequest): Promise<PromotionOutcome> {
    const now = req.now ?? this.#clock.now()
    if (req.section_ids.length === 0) throw invalidInput('promote 需要至少一个 section_id')
    const fromIdx = TIER_ORDER.indexOf(req.from.tier)
    const toIdx = TIER_ORDER.indexOf(req.to_tier)
    if (toIdx < 0 || fromIdx < 0 || toIdx >= fromIdx) {
      return {
        accepted: false,
        code: 'invalid_input',
        reason: `晋升目标层必须高于来源层：${req.from.tier} → ${req.to_tier}`,
      }
    }
    const evidence = req.evidence ?? []
    const lessons = evidence
      .map((id) => this.#lessons.get(id))
      .filter((l): l is LessonRecordEx => l !== undefined)
    const contributors = req.contributors ?? [
      ...new Set(lessons.flatMap((l) => [l.assignment_id, ...l.assignments])),
    ]
    const criteria = lessons.length > 0 ? criteriaOf(lessons, contributors, now) : undefined

    if (req.evalResult !== undefined && req.evalResult.status === 'red') {
      const failed = req.evalResult.failed ?? []
      const detail = req.evalResult.detail ?? ''
      const tail = failed.length > 0 ? `：${failed.join('、')}` : detail === '' ? '' : `：${detail}`
      return {
        accepted: false,
        code: 'not_approved',
        reason: `eval 回归（红），晋升预检 blocked${tail}`,
        ...(criteria === undefined ? {} : { criteria }),
      }
    }
    if (req.enforce_criteria === true) {
      const check = criteria ?? criteriaOf(lessons, contributors, now)
      if (!check.passed) {
        return {
          accepted: false,
          code: 'not_approved',
          reason: `未达晋升判据（07 §1）：${check.missing.join('、')}`,
          criteria: check,
        }
      }
    }
    return {
      accepted: true,
      ...(criteria === undefined ? {} : { criteria }),
      approval_request: {
        kind: 'skill_promotion',
        skill: req.skill,
        section_ids: [...req.section_ids],
        from: { ...req.from },
        to_tier: req.to_tier,
        evidence,
        contributors,
        created_at: now,
      },
    }
  }

  /** 策略层判定：skill 名在名单里，或段标题含策略关键词。 */
  isPolicyTarget(skill: string, section_id?: string, extra?: ReadonlySet<string>): boolean {
    if (this.#policySkills.has(skill) || extra?.has(skill) === true) return true
    if (section_id === undefined) return false
    const heading = this.#registry.sectionHeading(skill, section_id)
    if (heading === undefined) return false
    const lower = heading.toLowerCase()
    return POLICY_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))
  }

  #findMergeTarget(input: PoolInput): LessonRecordEx | undefined {
    for (const l of this.#lessons.values()) {
      if (l.status === 'refuted') continue
      if (l.workspace_id !== input.workspace_id) continue
      // 24 §3：lesson 池是“每人”的，所以合并只在同一 assignment 内发生
      if (l.assignment_id !== input.assignment_id) continue
      if (l.skill !== input.skill) continue
      if ((l.section_id ?? '') !== (input.section_id ?? '')) continue
      if (jaccard(l.text, input.text) > MERGE_SIMILARITY) return l
    }
    return undefined
  }
}

function clusterKey(skill: string, section_id?: string): string {
  return `${skill}::${section_id ?? ''}`
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = map.get(k) ?? []
    list.push(item)
    map.set(k, list)
  }
  return [...map.values()]
}

function clusterBySimilarity(items: readonly LessonRecordEx[]): LessonRecordEx[][] {
  const clusters: LessonRecordEx[][] = []
  for (const item of items) {
    const hit = clusters.find((c) => {
      const head = c[0]
      return head !== undefined && jaccard(head.text, item.text) > MERGE_SIMILARITY
    })
    if (hit) hit.push(item)
    else clusters.push([item])
  }
  return clusters
}

function representative(group: readonly LessonRecordEx[]): LessonRecordEx | undefined {
  return [...group].sort(
    (a, b) =>
      b.confidence - a.confidence ||
      b.confirmations - a.confirmations ||
      a.created_at.localeCompare(b.created_at),
  )[0]
}

function criteriaOf(
  lessons: readonly LessonRecordEx[],
  contributors: readonly AssignmentId[],
  now: Iso8601,
): PromotionCriteriaCheck {
  const confidence = lessons.length === 0 ? 0 : Math.max(...lessons.map((l) => l.confidence))
  const adoptions = lessons.reduce((n, l) => n + l.confirmations, 0)
  const nowMs = Date.parse(now)
  const oldest = lessons.reduce(
    (min, l) => Math.min(min, Date.parse(l.created_at)),
    Number.POSITIVE_INFINITY,
  )
  const age_days = Number.isFinite(oldest) && Number.isFinite(nowMs) ? (nowMs - oldest) / DAY_MS : 0
  const missing: string[] = []
  if (confidence < PROMOTION_CRITERIA.min_confidence) missing.push('置信度 < 0.9')
  if (adoptions < PROMOTION_CRITERIA.min_adoptions) missing.push('采用次数 < 5')
  if (contributors.length < PROMOTION_CRITERIA.min_contributors) missing.push('贡献者 < 2')
  if (age_days < PROMOTION_CRITERIA.min_age_days) missing.push('存在时间 < 14 天')
  return {
    confidence,
    adoptions,
    contributors: contributors.length,
    age_days,
    passed: missing.length === 0,
    missing,
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

/** 契约一致性：pool / consolidate / mark 与 LessonPool 同形（入参更宽、返回更全）。 */
export type LessonPoolConformsToContract = MemoryLessonPool extends LessonPool ? true : false
