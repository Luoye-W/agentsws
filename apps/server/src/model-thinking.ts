/**
 * WP370（Luoye 10-17）：输入框 AI 钮里的**思考程度**——把一个模型自己声明的思考档，
 * 收成界面上的三档白话「快 / 标准 / 深想」。
 *
 * 档从哪来，照官方（dsh 0.2.1-alpha.5）：
 * - ChatGPT 订阅：官方 pi-ai `getSupportedThinkingLevels`（`dsh-llm-pi-ai` 同一个来源；目录里标了不思考的模型没有档）；
 * - DeepSeek（账号登录，或 API key 走 Messages 口）：官方 `dsh-llm-deepseek` 的 off / low / high / max，默认 high；
 * - 别的来源（OpenAI 兼容、工坊积分）：官方对「没声明档位的适配器」就是不出这一行，我们也不出。
 *
 * 三档怎么落：快 = 最浅的那一档能想的（low，没有就 minimal）；标准 = 这个模型的默认档；
 * 深想 = 比默认再深一档（订阅 medium → high；DeepSeek high → max）。落不出来的那档不出，
 * 只剩一档就整行不出（没得选）。`off`（完全不想）不单列：Luoye 给的三档里没有它。
 *
 * WP373（Luoye 10-17）：思考程度挪成输入框里 AI 钮旁边的独立控件。官方只声明了「不想」和**一档**的模型
 * （pi-ai 目录里这种有几十个：`openai/gpt-5-pro`、各家托管的 Kimi / Mistral 等）画成开关：开 = 那一档，关 = `off`。
 */
import type { FreeChatModelThinking, FreeChatThinkingLevel } from '@agentsws/api'
import { REASONING_EFFORTS, type ReasoningEffort } from '@agentsws/contracts'

/** 上下文窗口到多少算「长上下文」（token）。 */
export const LONG_CONTEXT_TOKENS = 200_000

const order = (e: ReasoningEffort): number => REASONING_EFFORTS.indexOf(e)

/**
 * 一个模型声明的档（`levels`，任意顺序）+ 默认档 → 三档白话。没声明默认时按 medium → high → low 的次序挑「标准」
 * （订阅目录不写默认档；我们把 medium 当标准——OpenAI 推理模型文档里的默认档，交 Luoye 定，见 WP370 报告 979）。
 */
export function thinkingOptionsOf(
  levels: readonly ReasoningEffort[],
  declaredDefault?: ReasoningEffort,
): FreeChatModelThinking | undefined {
  const have = new Set(levels)
  const thinkers = [...have].filter((e) => e !== 'off')
  // WP373：只有「不想」和一档 → 开关（开 = 那一档；默认照声明，没声明就开着）
  const on = thinkers[0]
  if (have.has('off') && thinkers.length === 1 && on !== undefined) {
    return {
      options: [{ level: 'standard', effort: on }],
      default: declaredDefault === 'off' ? 'off' : on,
      toggle: true,
    }
  }
  const standard =
    declaredDefault !== undefined && have.has(declaredDefault) && declaredDefault !== 'off'
      ? declaredDefault
      : (['medium', 'high', 'low'] as const).find((e) => have.has(e))
  if (standard === undefined) return undefined
  const fast = (['low', 'minimal'] as const).find((e) => have.has(e) && order(e) < order(standard))
  const deep = (['high', 'xhigh', 'max'] as const).find(
    (e) => have.has(e) && order(e) > order(standard),
  )
  const options: FreeChatModelThinking['options'] = [
    ...(fast === undefined ? [] : [{ level: 'fast' as FreeChatThinkingLevel, effort: fast }]),
    { level: 'standard', effort: standard },
    ...(deep === undefined ? [] : [{ level: 'deep' as FreeChatThinkingLevel, effort: deep }]),
  ]
  return options.length < 2 ? undefined : { options, default: standard }
}

/** 这一档在这个模型的三档里吗（开事项 / 换模型时校验用）。 */
export function hasThinkingEffort(
  thinking: FreeChatModelThinking | undefined,
  effort: ReasoningEffort,
): boolean {
  if (thinking?.toggle === true && effort === 'off') return true
  return thinking?.options.some((o) => o.effort === effort) === true
}
