/**
 * lesson 池（24 §3「零打扰」）。
 *
 * 入池只做三件事：按语义键合并、记 hits、按 24 §3 调置信度。**绝不写 overlay**——
 * 夜里技能一个字都不能变，这是 09-08 Luoye 定的那条（06 §3.4）。
 *
 * 池有两个档：内存（测试 / 模拟回路）与 SQLite（服务进程重启续跑）。两个档共用
 * 同一套判定，差别只在 `LearningStore` 怎么存。
 */
import type { Clock, Iso8601, WorkspaceId } from '@agentsws/contracts'
import { notFound } from './errors.js'
import { keySimilarity } from './semantic.js'
import type { ExtractedLesson, PooledLesson, RejectedKey } from './types.js'

/** 确认 +0.15、忽略 ×0.7、驳回 → 0（24 §3）。 */
export const CONFIRM_STEP = 0.15
export const IGNORE_DECAY = 0.7
export const CONFIDENCE_CAP = 0.99
/** 键不同但话很像时也算同一条（合并阈值）。 */
export const MERGE_SIMILARITY = 0.7

export interface LessonFilter {
  workspace_id?: WorkspaceId
  assignment_id?: string
  skill?: string
  status?: PooledLesson['status']
}

/** 池的存储面。内存档与 SQLite 档各实现一份。 */
export interface LearningStore {
  put(lesson: PooledLesson): void
  get(id: string): PooledLesson | undefined
  list(filter: LessonFilter): PooledLesson[]
  reject(entry: RejectedKey): void
  rejected(workspace_id: WorkspaceId): RejectedKey[]
  /**
   * 按 id 删行（40 §1.2 离职里 `personal_layer: 'erase'` 那一档）。
   *
   * 可选：没实现的档退回「标成 refuted」——那条不再被提，但行还在。
   * 要「连行一起没」的档实现它。
   */
  delete?(id: string): void
  close?(): void
}

export class MemoryLearningStore implements LearningStore {
  readonly #lessons = new Map<string, PooledLesson>()
  readonly #rejected = new Map<string, RejectedKey>()

  put(lesson: PooledLesson): void {
    this.#lessons.set(lesson.id, clone(lesson))
  }

  get(id: string): PooledLesson | undefined {
    const l = this.#lessons.get(id)
    return l === undefined ? undefined : clone(l)
  }

  list(filter: LessonFilter): PooledLesson[] {
    return [...this.#lessons.values()]
      .filter((l) => matches(l, filter))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(clone)
  }

  reject(entry: RejectedKey): void {
    this.#rejected.set(`${entry.workspace_id}::${entry.semantic_key}`, { ...entry })
  }

  delete(id: string): void {
    this.#lessons.delete(id)
  }

  rejected(workspace_id: WorkspaceId): RejectedKey[] {
    return [...this.#rejected.values()]
      .filter((r) => r.workspace_id === workspace_id)
      .sort((a, b) => a.semantic_key.localeCompare(b.semantic_key))
      .map((r) => ({ ...r }))
  }
}

function matches(l: PooledLesson, f: LessonFilter): boolean {
  return (
    (f.workspace_id === undefined || l.workspace_id === f.workspace_id) &&
    (f.assignment_id === undefined || l.assignments.includes(f.assignment_id)) &&
    (f.skill === undefined || l.applies_to.skill === f.skill) &&
    (f.status === undefined || l.status === f.status)
  )
}

function clone(l: PooledLesson): PooledLesson {
  return {
    ...l,
    evidence: l.evidence.map((e) => ({ ...e })),
    runs: [...l.runs],
    assignments: [...l.assignments],
    applies_to: { ...l.applies_to },
  }
}

export interface LearningPoolOptions {
  store?: LearningStore
  clock: Clock
  /** id 工厂（ULID / 哈希）；由宿主注入，池里不 `Math.random()`。 */
  nextId: () => string
}

/** 池：合并、计数、置信度、黑名单。 */
export class LearningPool {
  readonly #store: LearningStore
  readonly #clock: Clock
  readonly #nextId: () => string

  constructor(options: LearningPoolOptions) {
    this.#store = options.store ?? new MemoryLearningStore()
    this.#clock = options.clock
    this.#nextId = options.nextId
  }

  get store(): LearningStore {
    return this.#store
  }

  /**
   * 入池。同一人（assignment）同一技能同一段下语义键相同、或话足够像的，合并成一条：
   * hits +1、置信度 +0.15（封顶 0.99）、证据并起来。
   *
   * 被驳回过的语义键**照样入池**（要能数出"又出现了几次"），但提案时会被黑名单拦下并
   * 给出 `rejected_before`——这是 `learning/reject-once` 那条场景要看见的东西。
   */
  pool(lesson: ExtractedLesson): PooledLesson {
    const now = this.#clock.now()
    const hit = this.#findMergeTarget(lesson)
    if (hit !== undefined) {
      const next: PooledLesson = {
        ...hit,
        hits: hit.hits + 1,
        confidence: round(Math.min(CONFIDENCE_CAP, hit.confidence + CONFIRM_STEP)),
        updated_at: now,
        status: hit.status === 'ignored' ? 'pooled' : hit.status,
        runs: hit.runs.includes(lesson.run_id) ? hit.runs : [...hit.runs, lesson.run_id],
        // assignments 不用并：合并只在同一个人内发生（见 `#findMergeTarget`），
        // 跨人的汇总是周合并那一步的事（`weeklyPromotions`）
        assignments: hit.assignments,
        evidence: mergeEvidence(hit.evidence, lesson.evidence),
      }
      this.#store.put(next)
      return next
    }
    const record: PooledLesson = {
      ...lesson,
      applies_to: { ...lesson.applies_to },
      evidence: lesson.evidence.map((e) => ({ ...e })),
      id: this.#nextId(),
      hits: 1,
      status: 'pooled',
      created_at: now,
      updated_at: now,
      runs: [lesson.run_id],
      assignments: [lesson.assignment_id],
    }
    this.#store.put(record)
    return record
  }

  poolAll(lessons: readonly ExtractedLesson[]): PooledLesson[] {
    return lessons.map((l) => this.pool(l))
  }

  get(id: string): PooledLesson | undefined {
    return this.#store.get(id)
  }

  list(filter: LessonFilter = {}): PooledLesson[] {
    return this.#store.list(filter)
  }

  /** 接受 → accepted；忽略 → 置信度 ×0.7；驳回 → 0 并进黑名单（24 §3）。 */
  mark(id: string, status: PooledLesson['status'], at?: Iso8601): PooledLesson {
    const lesson = this.#store.get(id)
    if (lesson === undefined) throw notFoundLesson(id)
    const next: PooledLesson = { ...lesson, status, updated_at: at ?? this.#clock.now() }
    if (status === 'ignored') next.confidence = round(lesson.confidence * IGNORE_DECAY)
    if (status === 'refuted') next.confidence = 0
    if (status === 'proposed') next.proposed_at = next.updated_at
    this.#store.put(next)
    return next
  }

  // ── 40 §1.2 离职：走的人在池里那些还没提上去的经验怎么办 ────────────────

  /**
   * 归档：把这几条分配名下**还没被采纳**的 lesson 标成 `ignored`，以后不再提。
   *
   * 为什么不删：24 §3 的池是"每人一份的观察"，人走了，观察没被验证过，
   * 不该继续以他的名义变成提案卡；但证据（人当时的原话、run id）还得留着——
   * 周复盘里"这条经验其实有两个人都提过"要靠它。已经 `accepted` 的不动：
   * 那条已经进过 overlay，属于公司。
   *
   * 幂等：跑完就没有 `pooled` / `proposed` 的了，再跑一次是 0 条。
   */
  archiveContributor(input: {
    workspace_id: WorkspaceId
    assignment_ids: readonly string[]
    at?: Iso8601
  }): number {
    const at = input.at ?? this.#clock.now()
    let n = 0
    for (const lesson of this.#byContributor(input.workspace_id, input.assignment_ids)) {
      if (lesson.status !== 'pooled' && lesson.status !== 'proposed') continue
      this.#store.put({
        ...lesson,
        status: 'ignored',
        confidence: round(lesson.confidence * IGNORE_DECAY),
        updated_at: at,
      })
      n += 1
    }
    return n
  }

  /**
   * 销毁：`personal_layer: 'erase'` 那一档——连行一起删。
   *
   * 存储档没实现 `delete` 时退回"标成 refuted、置信度归零"：那条不会再被提，
   * 但行还在（内存档在进程结束时本来就没了，落盘档实现了 `delete`）。
   */
  eraseContributor(input: {
    workspace_id: WorkspaceId
    assignment_ids: readonly string[]
    at?: Iso8601
  }): number {
    const at = input.at ?? this.#clock.now()
    let n = 0
    for (const lesson of this.#byContributor(input.workspace_id, input.assignment_ids)) {
      const drop = this.#store.delete?.bind(this.#store)
      if (drop === undefined)
        this.#store.put({ ...lesson, status: 'refuted', confidence: 0, updated_at: at })
      else drop(lesson.id)
      n += 1
    }
    return n
  }

  #byContributor(workspace_id: WorkspaceId, assignment_ids: readonly string[]): PooledLesson[] {
    const wanted = new Set(assignment_ids)
    return this.#store
      .list({ workspace_id })
      .filter((l) => l.assignments.some((a) => wanted.has(a)) || wanted.has(l.assignment_id))
  }

  /** 记一条"这个语义键以后别再提"。 */
  rejectKey(entry: Omit<RejectedKey, 'at'> & { at?: Iso8601 }): RejectedKey {
    const record: RejectedKey = { ...entry, at: entry.at ?? this.#clock.now() }
    this.#store.reject(record)
    return record
  }

  rejectedKeys(workspace_id: WorkspaceId): RejectedKey[] {
    return this.#store.rejected(workspace_id)
  }

  isRejected(workspace_id: WorkspaceId, semantic_key: string): boolean {
    return this.#store.rejected(workspace_id).some((r) => r.semantic_key === semantic_key)
  }

  #findMergeTarget(lesson: ExtractedLesson): PooledLesson | undefined {
    const candidates = this.#store.list({
      workspace_id: lesson.workspace_id,
      skill: lesson.applies_to.skill,
    })
    for (const c of candidates) {
      if (c.status === 'refuted') continue
      // 24 §3：池是"每人"的，所以合并只在同一 assignment 内发生
      if (!c.assignments.includes(lesson.assignment_id)) continue
      if ((c.applies_to.section_id ?? '') !== (lesson.applies_to.section_id ?? '')) continue
      if (c.kind !== lesson.kind) continue
      if (c.semantic_key === lesson.semantic_key) return c
      if (keySimilarity(c.text, lesson.text) > MERGE_SIMILARITY) return c
    }
    return undefined
  }
}

function mergeEvidence(
  a: readonly PooledLesson['evidence'][number][],
  b: readonly PooledLesson['evidence'][number][],
): PooledLesson['evidence'] {
  const out = a.map((e) => ({ ...e }))
  for (const e of b) {
    if (!out.some((x) => x.quote === e.quote && x.at === e.at)) out.push({ ...e })
  }
  return out
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

function notFoundLesson(id: string): Error {
  return notFound(`lesson 不存在：${id}`)
}
