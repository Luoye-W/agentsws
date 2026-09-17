/**
 * `@agentsws/dsh-adapter` —— 17 §4 的 dsh 运行时适配器。
 *
 * 一切 DeepSeek Harness API 调用收在这个包里（侦察报告 §9.1 的薄适配层）：
 * 业务代码只见 `RuntimeAdapter`，升级 dsh 只看 `test/` 里的 seam 契约测试红不红。
 */

export {
  anyBrowserToolName,
  type BrowserProviderConfig,
  browserBrief,
  browserProviderConfig,
  checkBrowserNavigation,
} from './browser.js'
export type { BrowserSkillPluginConfig } from './browserskill.js'
export {
  applyBskEnv,
  BROWSERSKILL_PLUGIN,
  BROWSERSKILL_READ_ACTIONS,
  BROWSERSKILL_TOOLS,
  BSK_NO_UPDATE_MANIFEST,
  browserSkillBrief,
  browserSkillNavigationUrl,
  browserSkillPluginConfig,
  browserSkillToolName,
  bskBinaryUsable,
  checkBrowserSkillPolicy,
  classifyBrowserSkillEffect,
  isBrowserSkillHandoff,
} from './browserskill.js'
export { DshAdapterError } from './errors.js'
export type { AskedBoundary, DraftArgs, GateApi, GateInput, StageArgs } from './gate.js'
export { CONTEXT_PREFIX, installGate, PERSONA_SECTION } from './gate.js'
export type { DshHarness, HarnessInput } from './harness.js'
export { createHarness, DEFAULT_MAX_STEPS } from './harness.js'
export {
  createDshRuntime,
  createSubprocessDshRuntime,
  defaultChildEntry,
  resolveMode,
  subprocessAvailable,
} from './headless/index.js'
export * from './headless/protocol.js'
export type { GatewayAdapterOptions, GatewayBudget } from './llm.js'
export {
  GATEWAY_PROVIDER,
  GatewayLlmAdapter,
  splitSystemText,
  toChatMessages,
  toToolDefs,
} from './llm.js'
export type { PresetComposition, PresetPaths } from './preset.js'
export {
  GATE_PLUGIN_MODULE,
  MCP_CLIENT_MODULE,
  presetComposition,
  presetConnections,
  presetCredentialRefs,
  presetDigest,
  presetIdOf,
  presetToolNames,
  writePreset,
} from './preset.js'
export * from './reading.js'
export { createInProcessDshRuntime, TASK_MESSAGE } from './runtime.js'
export type { ReadToolHooks, StageToolHooks } from './tools.js'
export {
  BROWSER_DEFAULT_TOOL_NAMES,
  BROWSER_DEFAULT_TOOLS,
  BROWSER_TOOL_PREFIX,
  browserToolName,
  buildToolDefinitions,
  classifySideEffect,
  DRAFT_TOOL,
  mcpReadToolMap,
  STAGE_TOOL,
} from './tools.js'
export type {
  DshRuntimeMode,
  DshRuntimeOptions,
  DshSessionRef,
  GateHandles,
  GateRecord,
  ModelGatewayLike,
  ToolSideEffect,
} from './types.js'
