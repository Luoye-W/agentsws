/**
 * WP378（决策 1055，Luoye 10-17）：用户自己的 DeepSeek API key、走 **Chat 口**（OpenAI 兼容 `/chat/completions`）
 * 那一条的思考程度。
 *
 * 写法照 DeepSeek 官方 Chat 口（WP377 调研 + Fable 10-17 实测）：`thinking: { type: 'enabled' | 'disabled' }`
 * 加 `reasoning_effort`（v4 Pro / Flash 都收 low / high / max；思考 token 含在 `completion_tokens` 里，照实计费）。
 *
 * 三档怎么落，与工坊积分（WP377、决策 1054）一致——「显示什么就发什么」（决策 1032）：
 *
 * | 模型 | 快 | 标准 | 深度 |
 * |---|---|---|---|
 * | v4 Pro | 关掉思考 | high | max |
 * | Flash（含 `deepseek-v4-flash` 等老名字） | low | high | max |
 *
 * 表里没有的模型（`deepseek-chat`、`deepseek-reasoner` 等老名字、以后的新模型）不出小钮、一格不发。
 */
import type { ReasoningEffort } from '@agentsws/contracts'

/** 界面三档（与 `@agentsws/api` 的 `FreeChatThinkingLevel` 同名）各落到哪一档。 */
export interface DeepSeekThinkingLevels {
  fast: ReasoningEffort
  standard: ReasoningEffort
  deep: ReasoningEffort
}

const PRO: DeepSeekThinkingLevels = { fast: 'off', standard: 'high', deep: 'max' }
const FLASH: DeepSeekThinkingLevels = { fast: 'low', standard: 'high', deep: 'max' }

/**
 * DeepSeek 官方模型名 → 三档。只收官方目录里的名字（`pricing/catalog.json` 的 deepseek 一家：
 * `deepseek-flash` 与它的两个老名字、`deepseek-v4-pro`）。
 */
export const DEEPSEEK_THINKING_LEVELS: Readonly<Record<string, DeepSeekThinkingLevels>> = {
  'deepseek-v4-pro': PRO,
  'deepseek-flash': FLASH,
  'deepseek-v4-flash': FLASH,
  'deepseek-v4-flash-vision-exp': FLASH,
}

/** 这个模型的三档；不认得回 `undefined`（不出小钮）。 */
export function deepseekThinkingLevelsOf(model: string): DeepSeekThinkingLevels | undefined {
  return Object.hasOwn(DEEPSEEK_THINKING_LEVELS, model)
    ? DEEPSEEK_THINKING_LEVELS[model]
    : undefined
}

/**
 * 选的那一档 → Chat 口请求体那两格。
 *
 * - 没选（`effort` 不给）：一格不写——官方默认就是 high = 界面上亮的「标准」（决策 1032 的备注），请求字节不变；
 * - 调用方硬要「别想」（`thinking: 'off'`，WP243）：这里一格不写，`thinking: disabled` 由关思考那一格写；
 * - 不认得的模型、或不在这个模型三档里的值（例：Pro 的 low）：一格不写，按官方默认跑，不报错；
 * - `off`：只写 `thinking: { type: 'disabled' }`；
 * - 其余：`thinking: { type: 'enabled' }` + `reasoning_effort`。
 */
export function deepseekChatEffortFields(
  model: string,
  effort: ReasoningEffort | undefined,
  thinking: 'off' | undefined,
): Record<string, unknown> {
  if (effort === undefined || thinking === 'off') return {}
  const levels = deepseekThinkingLevelsOf(model)
  if (levels === undefined || !Object.values(levels).includes(effort)) return {}
  return effort === 'off'
    ? { thinking: { type: 'disabled' } }
    : { thinking: { type: 'enabled' }, reasoning_effort: effort }
}
