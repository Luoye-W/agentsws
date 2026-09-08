import type { AssignmentId, Iso8601, PersonId, RunId, WorkspaceId } from './common.js'

/** 24 §1 技能：Agent Skills 格式 + 段级元数据；三层叠加按段。 */
export type SkillTier = 'package' | 'company' | 'department' | 'personal'
export interface SkillSection {
  id: string
  heading: string
  body: string
  origin: 'authored' | 'learned'
  learned_from?: { lessons: string[]; at: Iso8601 }
}
export interface Skill {
  name: string
  tier: SkillTier
  owner: PersonId | 'package'
  version: string
  base?: { tier: SkillTier; version: string }
  sections: SkillSection[]
  evals: string[]
  source?: { package: string; version: string }
  workspace_id?: WorkspaceId
  scope_id?: string
}
export interface OverlayOp {
  op: 'replace' | 'append' | 'remove'
  section_id: string
  body?: string
}
export interface Overlay {
  skill: string
  tier: SkillTier
  owner: PersonId | string
  ops: OverlayOp[]
  base_version: string
  version: number
}
export interface LessonRecord {
  id: string
  run_id: RunId
  assignment_id: AssignmentId
  workspace_id: WorkspaceId
  skill: string
  section_id?: string
  signal: 'edit_diff' | 'reject' | 'redirect' | 'guardrail_hit' | 'tool_retry' | 'reflection'
  strength: 'strong' | 'medium' | 'weak'
  text: string
  confidence: number
  confirmations: number
  status: 'pooled' | 'proposed' | 'accepted' | 'ignored' | 'refuted'
  created_at: Iso8601
}

export interface ResolvedSkill {
  name: string
  markdown: string
  sections: SkillSection[]
  layers_applied: SkillTier[]
  conflicts: { section_id: string; tiers: SkillTier[] }[]
}

export interface SkillRegistry {
  put(skill: Skill): Promise<void>
  get(
    name: string,
    tier: SkillTier,
    scope?: { workspace_id?: WorkspaceId; scope_id?: string; owner?: PersonId },
  ): Promise<Skill | undefined>
  /** 包基础版 → 公司 → 部门 → 个人 依次按段应用；同段冲突不自动合 */
  resolve(
    name: string,
    actor: { person_id: PersonId; workspace_id: WorkspaceId; department_id?: string },
  ): Promise<ResolvedSkill>
  setOverlay(overlay: Overlay): Promise<Overlay>
  exclude(name: string, person_id: PersonId, excluded: boolean): Promise<void>
  /** 段 id 由系统分配（隐藏 ULID），按标题切段；返回带 id 的段 */
  parse(markdown: string, existing?: SkillSection[]): SkillSection[]
}

/** 24 §3 学习回路：只产提议，不自动改。 */
export interface LessonPool {
  pool(
    lesson: Omit<LessonRecord, 'id' | 'confirmations' | 'status' | 'created_at'>,
  ): Promise<LessonRecord>
  consolidate(
    workspace_id: WorkspaceId,
    opts: { now: Iso8601; threshold?: number },
  ): Promise<{
    proposals: {
      skill: string
      section_id?: string
      proposed_text: string
      lessons: string[]
      assignment_id: AssignmentId
    }[]
  }>
  mark(id: string, status: 'accepted' | 'ignored' | 'refuted'): Promise<LessonRecord>
}
