import type { AssignmentId, Iso8601, RoleId, RunId, WorkspaceId } from './common.js'
import type { ModelRef } from './run.js'

/** 22 模型网关：key 只在网关；按 (workspace, assignment, role, run, purpose) 记账；预算三级；急停。 */
export type ModelPurpose = 'run' | 'extraction' | 'reflection' | 'embedding' | 'judge'
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  tool_call_id?: string
}
export interface ToolDef {
  name: string
  description: string
  input_schema: unknown
}
export interface ModelMeta {
  workspace_id: WorkspaceId
  assignment_id: AssignmentId
  role_id: RoleId
  run_id: RunId
  purpose: ModelPurpose
}
export interface CompletionUsage {
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  cost_base: number
}
export interface Completion {
  text: string
  tool_calls?: { id: string; name: string; input: unknown }[]
  usage: CompletionUsage
  model: ModelRef
  static_prefix_hash: string
}

export interface ModelGateway {
  complete(req: {
    model?: ModelRef
    messages: ChatMessage[]
    tools?: ToolDef[]
    cache_breakpoints?: number[]
    meta: ModelMeta
    seed?: number
  }): Promise<Completion>
  embed(
    texts: string[],
    meta: ModelMeta,
    model?: ModelRef,
  ): Promise<{ vectors: number[][]; usage: CompletionUsage }>
  usage(filter: {
    workspace_id: WorkspaceId
    assignment_id?: AssignmentId
    role_id?: RoleId
    since?: Iso8601
  }): Promise<{
    input_tokens: number
    output_tokens: number
    cached_tokens: number
    cost_base: number
    calls: number
  }>
  budget(scope: {
    workspace_id: WorkspaceId
    assignment_id?: AssignmentId
  }): Promise<{ used_base: number; cap_base: number; frozen: boolean }>
}

export interface ModelProvider {
  ref: ModelRef
  complete(req: {
    messages: ChatMessage[]
    tools?: ToolDef[]
    seed?: number
  }): Promise<Omit<Completion, 'model' | 'static_prefix_hash'>>
  embed?(texts: string[]): Promise<{ vectors: number[][]; usage: CompletionUsage }>
}
