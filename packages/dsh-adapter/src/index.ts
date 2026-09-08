/**
 * `@agentsws/dsh-adapter` —— 17 §4 的 dsh 运行时适配器。
 *
 * 一切 DeepSeek Harness API 调用收在这个包里（侦察报告 §9.1 的薄适配层）：
 * 业务代码只见 `RuntimeAdapter`，升级 dsh 只看 `test/` 里的 seam 契约测试红不红。
 */

export { DshAdapterError } from './errors.js'
export type { GateApi, GateInput } from './gate.js'
export { CONTEXT_PREFIX, installGate, PERSONA_SECTION } from './gate.js'
export type { DshHarness, HarnessInput } from './harness.js'
export { createHarness } from './harness.js'
export type { GatewayAdapterOptions } from './llm.js'
export { GATEWAY_PROVIDER, GatewayLlmAdapter, toChatMessages, toToolDefs } from './llm.js'
export type { PresetComposition, PresetPaths } from './preset.js'
export { GATE_PLUGIN_MODULE, presetComposition, writePreset } from './preset.js'
export * from './reading.js'
export { createDshRuntime } from './runtime.js'
export type { ReadToolHooks, StageToolHooks } from './tools.js'
export { buildToolDefinitions, classifySideEffect, DRAFT_TOOL, STAGE_TOOL } from './tools.js'
export type {
  DshRuntimeOptions,
  DshSessionRef,
  GateHandles,
  GateRecord,
  ModelGatewayLike,
  ToolSideEffect,
} from './types.js'
