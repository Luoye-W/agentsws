/**
 * `@agentsws/learning`：学习回路的判定（24 §3、06 §3.4）。
 *
 * 一条线：**运行里学到一条 → 池 → 次日提案卡 → 人采纳 → 写进技能 overlay → 下次运行用新版**。
 * 这个包只放判定，不放接线：它不认识审批总线、不认识调度器、不认识 HTTP。
 * 接线在 `apps/server/src/learning.ts`，模拟回路里在 `packages/simulation`。
 *
 * 两条纪律，整包都靠它们成立：
 * - **不批不生效**：除了 `applyLessonDecision`（只有人按了采纳才走到），没有任何函数写 overlay。
 * - **每条都带出处**：`evidence` 里是人的原话与 run / 卡 id，落到 overlay 上是
 *   `origin: 'learned'` + `learned_from`，随时能看出技能里哪些是学来的、能整体回滚。
 */
import type { Clock, WorkspaceId } from '@agentsws/contracts'
import type { LearningStore } from './pool.js'
import { LearningPool } from './pool.js'
import type { SkillReader, SkillSectionView } from './proposals.js'
import { SqliteLearningStore } from './sqlite.js'

export * from './apply.js'
export * from './errors.js'
export * from './extract.js'
export * from './pool.js'
export * from './promote.js'
export * from './proposals.js'
export * from './resolved.js'
export * from './semantic.js'
export * from './sqlite.js'
export * from './types.js'

/** `MemorySkillRegistry` 这一类"能列出段"的东西 → 提案要的只读面。 */
export interface SectionSource {
  listSections(name: string): readonly SkillSectionView[]
}

export function skillReaderOf(source: SectionSource): SkillReader {
  return { sections: (skill) => source.listSections(skill) }
}

export interface CreateLearningOptions {
  clock: Clock
  nextId: () => string
  /** 给了路径就落盘（重启续跑）；不给就是内存档。 */
  dbPath?: string
  store?: LearningStore
}

export interface Learning {
  pool: LearningPool
  store: LearningStore
  close(): void
}

/** 装配入口：池 + 存储。判定函数都是纯函数，不进这里。 */
export function createLearning(options: CreateLearningOptions): Learning {
  const store =
    options.store ??
    (options.dbPath === undefined ? undefined : new SqliteLearningStore({ dbPath: options.dbPath }))
  const pool = new LearningPool({
    clock: options.clock,
    nextId: options.nextId,
    ...(store === undefined ? {} : { store }),
  })
  return {
    pool,
    store: pool.store,
    close: () => pool.store.close?.(),
  }
}

/** 池的健康摘要（24 §4 Agent 健康看板输入的技能那几项）。 */
export function poolHealth(
  pool: LearningPool,
  workspace_id: WorkspaceId,
): { pooled: number; proposed: number; accepted: number; ignored: number; refuted: number } {
  const all = pool.list({ workspace_id })
  const count = (s: string): number => all.filter((l) => l.status === s).length
  return {
    pooled: count('pooled'),
    proposed: count('proposed'),
    accepted: count('accepted'),
    ignored: count('ignored'),
    refuted: count('refuted'),
  }
}
