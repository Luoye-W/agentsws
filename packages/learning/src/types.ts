/**
 * 学习回路的对象（24 §1 §3、06 §3.4）。
 *
 * 与契约 `LessonRecord` 的关系：契约那条是**池里的一行**（单 run、单 assignment、单信号）；
 * 这里的 `ExtractedLesson` 是抽取器的产物，多了三样池里没有的东西——
 * `kind`（规则 / 例子 / 反例 / 边界）、`evidence`（原话 + 出处）、`semantic_key`（去重用）。
 * 入池时会投影回契约那条形状（见 `pool.ts`），所以契约不用改。
 */
import type { AssignmentId, Iso8601, RunId, WorkspaceId } from '@agentsws/contracts'

/** 一条 lesson 是什么类型的知识（24 §1 段级元数据的四种）。 */
export type LessonKind = 'rule' | 'example' | 'anti_example' | 'boundary'

/** 24 §1：信号来源。 */
export type LessonSignal =
  | 'edit_diff'
  | 'reject'
  | 'redirect'
  | 'guardrail_hit'
  | 'tool_retry'
  | 'reflection'

export type LessonStrength = 'strong' | 'medium' | 'weak'

/** 每条 lesson 都要能回答"凭什么"：哪次运行、哪张卡、人原话说了什么。 */
export interface LessonEvidence {
  /** 人的原话（驳回原因 / 指导文本 / 编辑后的那句）。不改写、不概括。 */
  quote: string
  at: Iso8601
  run_id?: RunId
  approval_item_id?: string
  /** WP486：这一次是哪种纠正（「不要 + 理由」/ 改了字 / 指导）。没有 = 早于 WP486 的证据，按 lesson 的 signal 算。 */
  signal?: LessonSignal
  /**
   * WP486：改了字的那一次——原来那一版与人改成的那一版（各截到 {@link EVIDENCE_TEXT_MAX} 字）。
   * 详情面板逐条列「原来是什么 / 你改成了什么」要用；只有 `edit_diff` 才有。
   */
  before?: string
  after?: string
  /**
   * WP487（决策 1679）：「只删了几个字」的那一次——删掉的那几段（如 `["DM us"]`）。
   * 规则版拿它写「删掉了『DM us』」，夜里模型拿它和原文 / 改后提炼成一句规矩。
   */
  deleted?: string[]
}

/** WP486：证据里原文 / 改后各留多少字（详情面板上读得完就行，不存整封信）。 */
export const EVIDENCE_TEXT_MAX = 400

/** 这条 lesson 该落到哪个技能的哪一段。 */
export interface AppliesTo {
  skill: string
  section_id?: string
}

/** 抽取器的产物（还没入池）。 */
export interface ExtractedLesson {
  workspace_id: WorkspaceId
  assignment_id: AssignmentId
  run_id: RunId
  applies_to: AppliesTo
  kind: LessonKind
  signal: LessonSignal
  strength: LessonStrength
  /** 一句人话的规则；进 overlay 的正文以它为底 */
  text: string
  confidence: number
  evidence: LessonEvidence[]
  /** 同一条经验的语义键：去重、合并、黑名单都认它 */
  semantic_key: string
}

/** 池里的一行（合并后）。 */
export interface PooledLesson extends ExtractedLesson {
  id: string
  /** 同语义键命中几次（24 §3 confirmations） */
  hits: number
  status: 'pooled' | 'proposed' | 'accepted' | 'ignored' | 'refuted'
  created_at: Iso8601
  updated_at: Iso8601
  proposed_at?: Iso8601
  /** 合并进来的全部来源 */
  runs: RunId[]
  assignments: AssignmentId[]
}

/** 被驳回过的语义键：以后不再提（黑名单）。 */
export interface RejectedKey {
  workspace_id: WorkspaceId
  semantic_key: string
  skill: string
  reason: string
  at: Iso8601
  by: string
}
