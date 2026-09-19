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
  /**
   * 角色为 `assistant` 时有效：思考模型上一轮的推理内容。DeepSeek 的 thinking 模式要求多轮时
   * 原样带回（"reasoning_content in the thinking mode must be passed back"，09-14 真店实测 400）。
   * 只在运行时的对话历史里流转，不进事件、不进卡片。
   */
  reasoning?: string
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
  /** 思考模型回的推理内容（下一轮要原样带回给 provider）；非思考模型没有。 */
  reasoning?: string
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

/* ------------------------------------------------------------------ */
/* 图片槽（22 + 58 §1）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 出图入参（WP76）。
 *
 * `size` 是 `"<宽>x<高>"`（`"1024x1024"`）——**不是** `DesignSpec` 的 id：
 * 图片模型只认画布，认不出"Amazon 主图"。规格 → 画布的换算在
 * `@agentsws/design-core` 的 `variants.ts` 里，网关不认识设计那一侧的概念。
 */
export interface ImageGenerateRequest {
  /**
   * 提示词。**进模型之前已经由 guardrail 查过品牌禁忌词**（`design_variant`
   * 那条 kind）——网关这一层不重复判，它判不了"这个品牌忌讳什么"。
   */
  prompt: string
  /** `"1024x1024"`。provider 不支持这个尺寸时自己就近取，并在返回里报真实尺寸。 */
  size?: string
  /** 要几张。上限由 guardrail 按 `max_variants_per_brief` 判，不在这里。 */
  n?: number
  meta: ModelMeta
  model?: ModelRef
  seed?: number
}

/**
 * 出来的一张图。
 *
 * **字节与 URL 二选一**：本地 / stub 档直接给 `bytes`，云端 provider 多数给一条
 * 限时 URL。两种都由**宿主**负责落进 blob store（41 §2）——
 * 图片字节永不进事件日志，同 `TranscriptionAudioDigest` 那条纪律。
 */
export interface GeneratedImage {
  bytes?: Uint8Array
  url?: string
  content_type: string
  width: number
  height: number
  /** 提示词哈希（素材来源那一格，58 §1 末行：**存哈希不存原文**）。 */
  prompt_sha256: string
}

export interface ImageGeneration {
  assets: GeneratedImage[]
  usage: CompletionUsage
  model: ModelRef
}

/**
 * 22 的图片能力槽（58 §1：图片生成走模型网关）。
 *
 * **可选**：DeepSeek 没有图片模型，所以多数发行版装不上真的这一条
 * （走 OpenAI 兼容口或 agentsws 云按积分才有）。装不上时挂一个
 * `available: false` 的实现，它的 `generate` 会抛，而 `unavailable_reason`
 * 是**给人看的那句话**——58 §1：没有就明说"只出 brief 与规格，不出图"，
 * 而不是让界面显示"生成失败"。
 */
export interface ImageProvider {
  ref: ModelRef
  /** 现在出不出得了图。`false` 时 `generate` 一定抛。 */
  available: boolean
  /** 出不了图的原因，人话一句（`available: false` 时必有）。 */
  unavailable_reason?: string
  generate(req: ImageGenerateRequest): Promise<ImageGeneration>
}

export interface ModelGateway {
  /**
   * 22 图片槽：提示词 → 图（WP76）。可选——没装图片 provider 的发行版不实现它。
   * 记账与驻留同 `complete`。
   */
  images?: ImageProvider
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

/**
 * provider 自报的一个可用模型（WP42）。
 *
 * 为什么进契约：设置页的「模型名」原本是一个手填的输入框——用户得自己去官网翻文档，
 * 抄一个字符串进来，抄错了要点「测试」才知道。让 provider 自己报一份清单，
 * 这个框才能变成一个下拉。**只有 id 是必须的**：各家 `/models` 回的字段并不一致，
 * 网关不假装它们一样。
 */
export interface ProviderModelInfo {
  id: string
  owned_by?: string
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
  /**
   * 这家现在有哪些模型（WP42）。可选——不是每个 provider 都有这个口
   * （stub 就没有）。实现里**不许**把凭据写进返回值或错误信封。
   */
  listModels?(): Promise<ProviderModelInfo[]>
  /** ASR provider 槽；拿到的一定是字节（`ref` 由网关的宿主解引用）。 */
  transcribe?(audio: {
    bytes: Uint8Array
    mime: string
    language?: string
  }): Promise<ProviderTranscription>
}

/**
 * 试跑一把模型没通，**到底是哪一类没通**（70 §2.2，WP121b）。
 *
 * 五档，因为界面上只说得出五句话：密钥不对 / 余额不足 / 地址不对 /
 * 连上了没回 / 认不出来。分档在契约里而不是在界面里，是因为**不止一处要它**：
 * 向导第 ① 步按它挑那一句人话，模拟场景按它断言"说的是人话不是错误码"。
 * 分成两份的话，哪天多一档（比如 429）就会有一处忘了改。
 */
export type ModelFailureKind = 'key' | 'balance' | 'address' | 'timeout' | 'other'

/**
 * 判这一次失败属于哪一档。
 *
 * 先看上游那句原文（它带着 HTTP 状态码，最准），再看 `reason` 这个码。
 * **认不出来就是 `other`**——硬套一句"密钥不对"会让人去改一把本来没问题的密钥。
 */
export function modelFailureKind(input: { reason?: string; detail?: string }): ModelFailureKind {
  if (input.reason === 'no_key') return 'key'
  const text = `${input.reason ?? ''} ${input.detail ?? ''}`.toLowerCase()
  if (/401|403|unauthorized|invalid api key|api key/.test(text)) return 'key'
  if (/402|insufficient|balance|余额/.test(text)) return 'balance'
  if (/timeout|timed out|etimedout|abort|超时/.test(text)) return 'timeout'
  if (/404|enotfound|econnrefused|provider_unavailable|model not found|连不上/.test(text))
    return 'address'
  return 'other'
}
