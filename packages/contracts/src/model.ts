import type { AssignmentId, Iso8601, RoleId, RunId, WorkspaceId } from './common.js'
import type { ModelRef } from './run.js'

/** 22 模型网关：key 只在网关；按 (workspace, assignment, role, run, purpose) 记账；预算三级；急停。 */
export type ModelPurpose =
  | 'run'
  | 'extraction'
  | 'reflection'
  | 'embedding'
  | 'judge'
  /** WP23：ASR（会议转写）。驻留与预算走与其它 purpose 相同的一套策略。 */
  | 'transcription'
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

/* ------------------------------------------------------------------ */
/* ASR 槽（22 + 37 §4.3）                                               */
/* ------------------------------------------------------------------ */

/**
 * 转写入参。`bytes` 与 `ref` 二选一：`ref` 是受控原始材料区（18 §2.1）的引用，
 * 由宿主解引用后再交给 provider——**音频永不进事件日志**，日志里只允许出现
 * `TranscriptionAudioDigest`（哈希、时长、字节数）。
 */
export interface TranscribeAudio {
  bytes?: Uint8Array
  ref?: string
  mime: string
  language?: string
  /** 已知时长（毫秒）；记账与日志用。 */
  duration_ms?: number
}

export interface TranscriptionSegment {
  start_ms: number
  end_ms: number
  speaker?: string
  text: string
}

/** 事件日志里唯一允许出现的音频信息。 */
export interface TranscriptionAudioDigest {
  sha256: string
  duration_ms: number
  bytes: number
  mime: string
}

export interface Transcription {
  text: string
  segments: TranscriptionSegment[]
  speakers?: string[]
  language?: string
  usage: CompletionUsage
  model: ModelRef
  audio: TranscriptionAudioDigest
}

/** provider 返回的转写：`model` / `audio` 由网关补，`usage.cost_base` 由网关按价目表覆盖。 */
export type ProviderTranscription = Omit<Transcription, 'model' | 'audio' | 'usage'> & {
  usage: Omit<CompletionUsage, 'cost_base'> & { cost_base?: number }
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
  /**
   * 22 ASR 槽：音频 → 文本。可选——没装 ASR provider 的发行版不实现它。
   * 记账与驻留同 `complete`（欧洲客户音频照 `eu_customer_to_cloud_brain` 判）。
   */
  transcribe?(audio: TranscribeAudio, meta: ModelMeta, model?: ModelRef): Promise<Transcription>
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
  /** ASR provider 槽；拿到的一定是字节（`ref` 由网关的宿主解引用）。 */
  transcribe?(audio: {
    bytes: Uint8Array
    mime: string
    language?: string
  }): Promise<ProviderTranscription>
}
