/**
 * `@agentsws/runtime-direct` —— 17 §4 的 `direct-llm` 运行时。
 *
 * 不经 dsh，自己跑 turn loop（Commerce Agents 移植：grounding 宿主预取、工具循环、
 * compact_history 占位、close_open_tool_uses、app_events 注入），模型经 22 的模型网关。
 * 它的意义是**证明 dsh 可替换**（31 §1 I6）：同一条场景在它上面跑通并过六条不变量。
 */
export type { DirectPrompt } from './assemble.js'
export {
  assembleDirect,
  DRAFT_REPLY_TOOL,
  OUTPUT_TOOLS,
  outputToolDefs,
  STAGE_REFUND_TOOL,
} from './assemble.js'
export { DirectRuntimeError, failureOf } from './errors.js'
export type { GateDecision, SideEffectLookup } from './gate.js'
export { gateToolCall, inAllowlist, inferRefs } from './gate.js'
export {
  CLOSED_TOOL_RESULT,
  COMPACT_PLACEHOLDER,
  compactHistory,
  historyTokens,
} from './history.js'
export { IDEMPOTENCY_WINDOW_MS, IdempotencyStore } from './idempotency.js'
export type {
  AftersalesBrainOptions,
  AftersalesBrainProviderOptions,
} from './providers/brain.js'
export {
  aftersalesBrain,
  aftersalesBrainProvider,
  groundingInputFor,
  orderFromToolMessage,
} from './providers/brain.js'
export type {
  ScriptedProviderOptions,
  ScriptedToolCall,
  ScriptedTurn,
  ScriptFn,
  ScriptInput,
} from './providers/scripted.js'
export { scriptedProvider, turnOf } from './providers/scripted.js'
export type { DirectRuntimeOptions } from './runtime.js'
export { createDirectRuntime, RUNTIME_NAME, refsFromEvents } from './runtime.js'
export type { DirectGateway, ForcedCompleteRequest, ToolChoiceGateway } from './tool-choice.js'
export { supportsToolChoice, withToolChoice } from './tool-choice.js'
export type { OrderView } from './view.js'
export {
  CHANGE_TERMS,
  changeRequested,
  groundingHits,
  itemsOfKind,
  orderIdFromText,
  orderView,
  plainText,
  refOf,
  ruleHits,
  threadText,
} from './view.js'
