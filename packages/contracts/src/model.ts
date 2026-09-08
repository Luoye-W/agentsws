import type { AssignmentId, Iso8601, RoleId, RunId, WorkspaceId } from './common.js'
import type { ModelRef } from './run.js'

/** 22 模型网关：key 只在网关；按 (workspace, assignment, role, run, purpose) 记账；预算三级；急停。 */
export type ModelPurpose = 'run' | 'extraction' | 'reflection' | 'embedding' | 'judge'
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  tool_call_id?: string
  /** 角色为 `assistant` 时有效：上一轮模型发出的工具调用（真 provider 需要它来还原对话，WP14）。 */
  tool_calls?: { id: string; name: string; input: unknown }[]
}
/** 17 §5.4 强制工具选择：`tool` 时模型这一轮只能调 `name` 那个工具；provider 不支持则网关退化为 `auto`。 */
export interface ToolChoice {
  type: 'auto' | 'none' | 'tool'
  name?: string
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
    tool_choice?: ToolChoice
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

/** provider 返回的补全：`model`/`static_prefix_hash` 由网关补，`usage.cost_base` 由网关按价目表覆盖（provider 填 0 即可）。 */
export type ProviderCompletion = Omit<Completion, 'model' | 'static_prefix_hash' | 'usage'> & {
  usage: Omit<CompletionUsage, 'cost_base'> & { cost_base?: number }
}

export interface ModelProvider {
  ref: ModelRef
  complete(req: {
    messages: ChatMessage[]
    tools?: ToolDef[]
    seed?: number
    tool_choice?: ToolChoice
  }): Promise<ProviderCompletion>
  /** 是否原生支持 `tool_choice`；缺省视为不支持（网关会剥掉该字段）。 */
  supports_tool_choice?: boolean
  embed?(texts: string[]): Promise<{ vectors: number[][]; usage: CompletionUsage }>
}
