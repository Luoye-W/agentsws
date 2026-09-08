import type {
  ChatMessage,
  Clock,
  Completion,
  ModelMeta,
  ObjectRef,
  RunRequest,
  ToolDef,
} from '@agentsws/contracts'
import type { CreateDraftFn, StageFn, ToolExecutor } from '@agentsws/stand-ins'

/**
 * 22 §1 网关的最小面：适配器只用 `complete`。
 * 结构化声明（不 import 具体实现）让适配器既能吃真 `ModelGatewayApi`，也能吃测试替身。
 */
export interface ModelGatewayLike {
  complete(req: {
    messages: ChatMessage[]
    tools?: ToolDef[]
    meta: ModelMeta
    seed?: number
    max_cost_base?: number
  }): Promise<Completion>
}

/** 副作用分类（16 §3）。`write_external` 在 `side_effect_policy: 'executor'` 下一律 block。 */
export type ToolSideEffect = 'local' | 'read_external' | 'write_external' | 'staged'

export interface DshRuntimeOptions {
  clock: Clock
  /** 模型经网关（模拟里是 stub provider）；LlmAdapter 把 dsh 的补全转到它。 */
  gateway: ModelGatewayLike
  /** 26 §3：一切随机经 seed。 */
  seed?: number
  /** 读工具的真实执行出口（与 stub 运行时同一套回调）。 */
  executeTool?: ToolExecutor
  /** `stage_refund` 工具经审批 answerer 落到这里。 */
  stage?: StageFn
  /** `draft_reply` 工具经审批 answerer 落到这里。 */
  createDraft?: CreateDraftFn
  /** 读不到政策时的默认退货窗口天数。 */
  defaultReturnWindowDays?: number
  signature?: string
  /** preset 目录根（`<root>/<role_id>/agent.cordis.yml`）；缺省写临时目录。 */
  presetRoot?: string
  /** 会话日志根；`session_ref.log_uri` 指向它。 */
  sessionLogRoot?: string
  /** 覆盖工具的副作用分类（16 §3 未标的按最严处理）。 */
  sideEffects?: Record<string, ToolSideEffect>
}

/** 一次运行里门禁插件记下来的东西，运行时据此发 17 §2 的事件。 */
export interface GateRecord {
  call_id: string
  tool: string
  status: 'ok' | 'error' | 'blocked'
  reason?: string
  provenance_added: ObjectRef[]
}

/** 门禁插件对外暴露的观测面（契约测试直接读它）。 */
export interface GateHandles {
  /** 每次工具调用的最终判定，按 call_id。 */
  records: Map<string, GateRecord>
  /** 已发过 `tool.result` 的 call_id（运行时不重复发）。 */
  emitted: Set<string>
  /** dsh 侧 preset 的 agent scope key（`tools.restrict` 与 scoped dispatch 的路由键）。 */
  agent: object
  /** 本次运行注入模型的 ContextItem 名（按注册顺序）。 */
  contextNames: string[]
}

/** 适配器内部对一次 dsh 会话的引用。 */
export interface DshSessionRef {
  session_id: string
  log_uri: string
  preset_dir: string
}

export type { RunRequest }
