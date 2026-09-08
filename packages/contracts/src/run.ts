import type { AssignmentId, Iso8601, ObjectRef, PersonId, RoleId, RunId, Sensitivity, WorkspaceId } from './common.js'
import type { ProvenanceState } from './changes.js'

/** 17 §1 RunRequest：协同服务 → 运行时适配器。无状态：运行自带全部上下文。 */
export type RunKind = 'work_item' | 'scheduled' | 'workflow_step' | 'extraction' | 'reflection' | 'dev_task' | 'simulation'

export interface ContextItem {
  id: string
  kind: 'customer' | 'thread' | 'order' | 'fact_card' | 'memory' | 'summary' | 'prefetch' | 'app_events' | 'policy'
  source_ref: ObjectRef | string
  sensitivity: Sensitivity
  content: unknown
  bytes: number
}

export interface GroundingRule { name: string; intent_terms: string[]; cue_terms: string[]; tool: string; prefetch: boolean }
export interface PromptSection { id: string; name: string; order: number; text: string }
export interface SkillRef { name: string; min_version?: string; tier: 'open' | 'premium'; load: 'always' | 'on_demand' }
export interface ModelRef { provider: string; model: string; region?: 'cn' | 'global' }

export interface RunRequest {
  id: RunId
  schema_version: 1
  workspace_id: WorkspaceId
  kind: RunKind
  actor: { person_id: PersonId; assignment_id: AssignmentId; role_id: RoleId }
  work_item?: { id: string; conversation_id: string; role_id: RoleId }
  trigger: { event_id: string; source: 'inbound' | 'schedule' | 'workflow' | 'approval_result' | 'manual' | 'sentinel' }
  context: ContextItem[]
  grounding: GroundingRule[]
  tools: { allow: string[]; connect_token: string; side_effect_policy: 'personal' | 'executor' }
  skills: SkillRef[]
  persona: { sections: PromptSection[] }
  budget: { max_tokens: number; max_tool_calls: number; max_seconds: number; max_cost_base: number }
  expectations: { outputs: ('draft' | 'staged_change' | 'proposal' | 'answer' | 'dev_result' | 'none')[]; must_stage_if_change_requested: boolean }
  runtime: { preset: string; profile: string; plugins: string[]; model: ModelRef; seed?: number }
  idempotency_key: string
}

/** 17 §2 事件流。运行时只产出这些；协同服务落事件日志。 */
export type RunEvent =
  | { type: 'run.started'; request_id: RunId; runtime: string; model: ModelRef }
  | { type: 'context.injected'; item_id: string; kind: ContextItem['kind']; bytes: number; hash: string }
  | { type: 'prompt.assembled'; hash: string; static_prefix_hash: string; total_tokens: number }
  | { type: 'text.delta'; text: string }
  | { type: 'tool.call'; call_id: string; tool: string; input: unknown }
  | { type: 'tool.result'; call_id: string; status: 'ok' | 'error' | 'blocked'; reason?: string; provenance_added?: ObjectRef[] }
  | { type: 'change.staged'; change_id: string }
  | { type: 'proposal.created'; approval_item_id: string; kind: string }
  | { type: 'ui'; component: string; payload: unknown }
  | { type: 'ui.partial'; component: string; payload: unknown }
  | { type: 'progress'; step: string; note?: string }
  | { type: 'budget.warning'; which: keyof RunRequest['budget']; used: number; cap: number }
  | { type: 'budget.exhausted'; which: keyof RunRequest['budget']; used: number; cap: number }
  | { type: 'run.completed'; usage: RunUsage; outputs: RunOutput[]; summary: string }
  | { type: 'run.failed'; error: { code: string; message: string; retryable: boolean } }
  | { type: 'run.cancelled' }

export interface RunUsage { input_tokens: number; output_tokens: number; cached_tokens: number; tool_calls: number; seconds: number; cost_base: number }

export type RunOutput =
  | { kind: 'draft'; approval_item_id: string }
  | { kind: 'staged_change'; change_id: string }
  | { kind: 'proposal'; approval_item_id: string }
  | { kind: 'answer'; text: string }
  | { kind: 'dev_result'; dev_task_id: string }
  | { kind: 'ui'; ref: string }

export interface MemoryFact { key: string; value: string; category: 'constraint' | 'preference' | 'context'; subject: ObjectRef; source_run_hash: string; expires_at: Iso8601 }
export interface Lesson { id: string; run_id: RunId; assignment_id: AssignmentId; skill: string; section_id?: string; signal: 'edit_diff' | 'reject' | 'redirect' | 'guardrail_hit' | 'tool_retry' | 'reflection'; strength: 'strong' | 'medium' | 'weak'; text: string; confidence: number }

export interface RunResult {
  request_id: RunId
  status: 'completed' | 'failed' | 'budget_exhausted' | 'cancelled'
  outputs: RunOutput[]
  provenance: ProvenanceState
  memory_candidates: MemoryFact[]
  lessons: Lesson[]
  usage: RunUsage
  session_ref: { runtime: string; session_id: string; log_uri: string }
  summary: string
  /** 15 §4.4：变更请求结束却没有 stage */
  no_stage?: boolean
}

/** 17 §4 运行时适配器契约：dsh、direct-llm、replay、stub、dev-executor 都实现它。 */
export interface RuntimeAdapter {
  name: string
  capabilities(): { tool_choice: boolean; streaming: boolean; followup: boolean; seedable: boolean }
  run(req: RunRequest, sink: (e: RunEvent) => void, signal: AbortSignal): Promise<RunResult>
  followup?(session_ref: RunResult['session_ref'], event: { type: string; payload: unknown }): Promise<void>
  health(): Promise<{ ok: boolean; detail?: string }>
}
