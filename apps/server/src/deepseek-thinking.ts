/**
 * WP378（决策 1055，Luoye 10-17）：DeepSeek 官方模型的思考小钮——三档各落到哪一档，与工坊积分一致
 * （WP377、决策 1054：v4 Pro 快 = 关掉思考 / 标准 = high / 深度 = max；Flash 快 = low / 标准 = high / 深度 = max）。
 *
 * 用在两条自带的 DeepSeek 来源上：
 * - API key 走 **Chat 口**（默认那条）：以前不出小钮（WP370 没核实写法），现在照这张表出；
 * - 账号登录 / API key 走 **Messages 口**：表里认得的模型照这张表（v4 Pro 的「快」从 low 改成关掉思考，三条来源口径一致）；
 *   表里没有的（账号清单以后放出的新模型）仍照官方适配器的四档挑。
 *
 * 表在 `@agentsws/model-gateway` 的 `deepseek-chat-thinking.ts`（请求体那两格也按同一张表写）。
 */
import type { FreeChatModelThinking } from '@agentsws/api'
import { deepseekThinkingLevelsOf } from '@agentsws/model-gateway'

/** 这个 DeepSeek 模型的三档小钮；表里没有回 `undefined`。默认 = 「标准」那一档（high）。 */
export function deepseekThinkingOf(model: string): FreeChatModelThinking | undefined {
  const levels = deepseekThinkingLevelsOf(model)
  if (levels === undefined) return undefined
  return {
    options: [
      { level: 'fast', effort: levels.fast },
      { level: 'standard', effort: levels.standard },
      { level: 'deep', effort: levels.deep },
    ],
    default: levels.standard,
  }
}
