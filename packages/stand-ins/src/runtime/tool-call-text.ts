/**
 * WP230（10-05 真模型 deepseek-chat 实测）：**模型把工具调用写成了文字**。
 *
 * 红人岗位起草英文回信时，模型真调了 7 次工具，最后一轮却吐出三行
 * `[calling search_policies {...}]`——没有真 `tool_calls`，回合就此结束，这三行成了答案。
 * 病根是两个运行时回放历史时往 assistant 的 content 里塞过同样形状的文字（已去掉），
 * 但真模型偶尔还会自己学着用文字调工具（`<tool_call>`、`function_call` 一类），所以这里兜底：
 *
 * - 这一轮**没有真工具调用**、文字里又有这种伪格式 → 不当答案；
 * - 追加 {@link TOOL_CALL_TEXT_NUDGE} 再跑一轮（只重试 1 次）；
 * - 还这样就照实报 {@link TOOL_CALL_TEXT_FAILURE}，不把假文字当答案、不出卡。
 *
 * direct / dsh 两个运行时读的是这同一份（stub 不经模型，答案是模板，碰不到这种情况）。
 * 纯函数：回放算得出同一个判定。
 */

/** 像「用文字调工具」的几种写法。宁可少认，不误伤正常回复。 */
const TOOL_CALL_TEXT_PATTERNS: readonly RegExp[] = [
  // 我们自己以前回放历史时写的那一行（模型最容易模仿的就是它）
  /^\s*\[calling\s+[\w.-]+/m,
  // Qwen / Hermes 一类的 `<tool_call>…</tool_call>`、Anthropic 一类的 `<function_calls>` / `<invoke name=`
  /<\/?tool_calls?>/i,
  /<\/?function_calls?\b/i,
  /<invoke\s+name=/i,
  // DeepSeek 原生特殊记号漏到正文（`<｜tool▁calls▁begin｜>`）与 `<|tool_call|>` 一类
  /<[|｜]\s*tool[▁_ ]?call/i,
  // OpenAI 老格式 / 整段 JSON 冒充调用
  /"(?:function_call|tool_calls)"\s*:/,
]

/** 一段模型文字里有没有「像工具调用的文字」。 */
export function looksLikeToolCallText(text: string): boolean {
  if (text.trim().length === 0) return false
  return TOOL_CALL_TEXT_PATTERNS.some((re) => re.test(text))
}

/** 重试那一轮追加给模型的提示（三个运行时同一句）。 */
export const TOOL_CALL_TEXT_NUDGE =
  '（系统提示）你把工具调用写成了文字。请用真正的工具调用，或直接给出答案。'

/** 重试一次还是这样时，照实报的那句（进 `run.failed` 与摘要）。 */
export const TOOL_CALL_TEXT_FAILURE = '模型输出格式异常'

/** `progress` 事件的 step（重试那一跳留痕，Model-visible ⟺ logged）。 */
export const TOOL_CALL_TEXT_STEP = 'tool_call_text'

/** 只重试这么多次。 */
export const TOOL_CALL_TEXT_RETRIES = 1
