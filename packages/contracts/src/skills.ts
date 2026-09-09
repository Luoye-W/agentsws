import type { AssignmentId, Iso8601, PersonId, RunId, WorkspaceId } from './common.js'

/** 24 §1 技能：Agent Skills 格式 + 段级元数据；三层叠加按段。 */
export type SkillTier = 'package' | 'company' | 'department' | 'personal'

export interface SkillSection {
  id: string
  heading: string
  body: string
  origin: 'authored' | 'learned'
  learned_from?: { lessons: string[]; at: Iso8601 }
  /** 06 §5.1 拆段：旧 id 归第一段，整组标记 */
  split_from?: string
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
  /** 06 §3.4：自动学来的段在界面上有标记 */
  origin?: 'authored' | 'learned'
  learned_from?: { lessons: string[]; at: Iso8601 }
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
  /** WP29：lesson 种类、证据（原话 + 出处）、语义键（去重与黑名单用） */
  kind?: 'rule' | 'example' | 'anti_example' | 'boundary'
  evidence?: { quote: string; run_id?: RunId; approval_item_id?: string }[]
  semantic_key?: string
  created_at: Iso8601
  /** 合并后的全部来源 */
  runs?: RunId[]
  assignments?: AssignmentId[]
  updated_at?: Iso8601
  proposed_at?: Iso8601
}

/** 同段冲突：两版正文都留着，人二选一（24 §1 不自动合） */
export interface SkillConflict {
  section_id: string
  tiers: SkillTier[]
  heading?: string
  versions: { tier: SkillTier; base_version: string; body: string }[]
}

export interface ResolvedSkill {
  name: string
  markdown: string
  sections: SkillSection[]
  layers_applied: SkillTier[]
  conflicts: SkillConflict[]
  /** 指向已不存在段的 overlay 操作：跳过但可见 */
  unresolved_ops?: { tier: SkillTier; op: OverlayOp }[]
  base?: { tier: SkillTier; version: string }
}

export interface SkillRegistry {
  put(skill: Skill): Promise<void>
  get(
    name: string,
    tier: SkillTier,
    scope?: { workspace_id?: WorkspaceId; scope_id?: string; owner?: PersonId },
  ): Promise<Skill | undefined>
  /** 包基础版 → 公司 → 部门 → 个人 依次按段应用；同段冲突不自动合；被本人排除 → undefined；不存在 → not_found */
  resolve(
    name: string,
    actor: { person_id: PersonId; workspace_id: WorkspaceId; department_id?: string },
  ): Promise<ResolvedSkill | undefined>
  setOverlay(overlay: Overlay): Promise<Overlay>
  exclude(name: string, person_id: PersonId, excluded: boolean): Promise<void>
  /** 上游新版：各层 overlay 更新 base_version，冲突段收集 */
  rebase(
    name: string,
    tier: SkillTier,
    opts?: { owner?: PersonId | string; scope?: { workspace_id?: WorkspaceId; scope_id?: string } },
  ): Promise<{ rebased: Overlay[]; conflicts: SkillConflict[] }>
  /** 段 id 由系统分配（隐藏 ULID），按标题切段；返回带 id 的段 */
  parse(markdown: string, existing?: SkillSection[]): SkillSection[]
}

export interface LessonProposal {
  skill: string
  section_id?: string
  proposed_text: string
  lessons: string[]
  assignment_id: AssignmentId
  confidence: number
  confirmations: number
}

export interface PromotionProposal {
  skill: string
  section_id?: string
  to_tier: SkillTier
  evidence: string[]
  contributors: AssignmentId[]
  proposed_text: string
  criteria: {
    confidence: number
    adoptions: number
    contributors: number
    age_days: number
    passed: boolean
    missing: string[]
  }
}

/** 24 §3 学习回路：只产提议，不自动改。 */
export interface LessonPool {
  /** confidence 由 strength 派生，入参可省 */
  pool(
    lesson: Omit<LessonRecord, 'id' | 'confirmations' | 'status' | 'created_at' | 'confidence'> & {
      confidence?: number
    },
  ): Promise<LessonRecord>
  /** 只产提议，绝不写 overlay；策略层被拦的进 filtered 以便向 owner 解释 */
  consolidate(
    workspace_id: WorkspaceId,
    opts: { now: Iso8601; threshold?: number; policySkills?: Iterable<string> },
  ): Promise<{
    proposals: LessonProposal[]
    filtered: { skill: string; section_id?: string; reason: 'policy_layer'; lessons: string[] }[]
  }>
  mark(id: string, status: 'accepted' | 'ignored' | 'refuted'): Promise<LessonRecord>
  /** 每周巩固：同 (skill, section) ≥2 个贡献者的相似 accepted → 晋升提议 */
  weeklyConsolidate(workspace_id: WorkspaceId, now: Iso8601): Promise<PromotionProposal[]>
  /** 晋升：不跑 eval，只消费 evalResult；红则拒；绿只产出 skill_promotion 审批请求，不落任何层 */
  promote(req: {
    skill: string
    section_ids: string[]
    from: { tier: SkillTier; owner: string }
    to_tier: SkillTier
    evidence?: string[]
    contributors?: AssignmentId[]
    evalResult: { status: 'green' | 'red' | 'unknown'; failed?: string[]; detail?: string }
    enforce_criteria?: boolean
    now?: Iso8601
  }): Promise<
    { accepted: true; request: unknown } | { accepted: false; code: string; reason: string }
  >
}
