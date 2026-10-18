/**
 * WP423：**预算到了也要交东西**——三个运行时（stub / direct / dsh）共用的收尾与「催一下」。
 *
 * 10-19 Mac 自测：Reddit 运营岗「找 5 个 subreddit + 3 个值得回的帖」查了 12 步，累计 token 撞上 6 万的上限，
 * 运行直接停，产出只剩一句开场白「我先上网查……」。这里收两件事：
 *
 * 1. **收尾回合**：任何上限（token / 调用次数 / 回合 / 时长）到了，都再跑**一次不带工具的收尾**——
 *    把已经查到的整理交出、明说还差哪些、为什么停（{@link wrapUpPrompt}）。模型收尾回来的还是空话 / 开场白 /
 *    假工具调用文字，就换成照实拼的那一段（{@link wrapUpFallback}），绝不以一句开场白结束。
 *    收尾这一跳**不受 token / 回合上限管**（就一次、不带工具），花费仍由网关的 `max_cost_base` 兜底。
 * 2. **没交东西就催**：普通运行（没有 `RunRequest.produce`）回了一句「我接下来要…」、又什么都没交，
 *    追加 {@link GENERAL_UNFINISHED_NUDGE} 再跑一回合，最多 {@link GENERAL_MAX_NUDGES} 次（别死循环）。
 *    网页模板那类要产出的长活仍按自己的 `produce.max_nudges`。
 *
 * 纯函数与常量：回放算得出同一个判定、同一句话。
 */
import type { RunRequest } from '@agentsws/contracts'
import { looksUnfinished } from './produce.js'
import { looksLikeToolCallText } from './tool-call-text.js'
import { toolWordZh } from './tool-words.js'

/** 哪一项预算到了（`budget.exhausted.which`）。 */
export type BudgetWhich = keyof RunRequest['budget']

/** `progress` 事件的 step：收尾那一跳留痕（Model-visible ⟺ logged）。 */
export const WRAP_UP_STEP = 'wrap_up'

/** 收尾那句提示的开头记号（替身规则脑据此认出「这是收尾回合」）。 */
export const WRAP_UP_MARK = '（系统提示·收尾）'

/** 普通运行「说了要做却停下」最多催几次。 */
export const GENERAL_MAX_NUDGES = 2

/**
 * 普通运行续跑那一回合追加给模型的话（三个运行时同一句）。网页模板那一类仍用 `UNFINISHED_NUDGE`。
 */
export const GENERAL_UNFINISHED_NUDGE =
  '（系统提示）这件事还没做完：你刚才只说了接下来要做什么，就直接调用工具去做，不要停下来汇报进度。' +
  '做完再用一段话交代结果；真的卡住了（缺登录、缺连接等）就照实说卡在哪。' +
  '如果这件事本来就只要回答、不用再查，直接给出答案。'

/** 停下的原因（人话，界面与收尾那段话同一句）。 */
export function budgetStopReason(which: BudgetWhich): string {
  switch (which) {
    case 'max_tokens':
      return '查的东西太多，这一轮先停在这里'
    case 'max_tool_calls':
      return '这一轮查的次数到上限了，先停在这里'
    case 'max_turns':
      return '这一轮来回的步数到上限了，先停在这里'
    case 'max_seconds':
      return '这一轮跑的时间到上限了，先停在这里'
    case 'max_cost_base':
      return '这一轮的花费到上限了，先停在这里'
    default:
      return '这一轮的额度用完了，先停在这里'
  }
}

/** 收尾回合追加给模型的那句（不带工具）。 */
export function wrapUpPrompt(which: BudgetWhich): string {
  return (
    `${WRAP_UP_MARK}这一轮要停了：${budgetStopReason(which)}。现在不能再调用任何工具。` +
    '请把到目前为止已经查到、做到的东西整理成一段交代给人：具体列出来（有数据写数据、有链接写链接、有名字写名字）；' +
    '然后明说还差哪些没查完或没做完，以及为什么停（就是上面这个原因）。' +
    '不要说「我接下来要…」，不要只回一句开场白，也不要假装调用工具。' +
    '最后单独一行写 <next>接着做</next>，人点了就从这里接着做。'
  )
}

/** 这条用户消息是不是收尾那句。 */
export function isWrapUpPrompt(text: string): boolean {
  return text.startsWith(WRAP_UP_MARK)
}

/**
 * 模型收尾回来的话能不能直接交出去：空的、只是「我接下来要…」、或者又把工具调用写成了文字——都不能。
 */
export function wrapUpUsable(text: string): boolean {
  const t = text.trim()
  if (t === '') return false
  if (looksLikeToolCallText(t)) return false
  return !looksUnfinished(t)
}

/**
 * 模型收尾不能用时照实拼的那一段：为什么停 + 已经做了什么 + 还差什么 + 怎么接着做。
 * `said` 是模型在这之前说过的、不是开场白的话（有就放在前面，不丢）。
 */
export function wrapUpFallback(input: {
  which: BudgetWhich
  readTools: readonly string[]
  said?: string
}): string {
  const did: string[] = []
  for (const name of input.readTools) {
    const word = toolWordZh(name)
    if (!did.includes(word)) did.push(word)
  }
  const said = input.said?.trim() ?? ''
  const lines: string[] = [`${budgetStopReason(input.which)}。`]
  if (said !== '' && wrapUpUsable(said)) lines.push('', said)
  lines.push(
    '',
    did.length > 0
      ? `已经做了：${did.join('、')}（共 ${input.readTools.length} 次）。`
      : '这一轮还没来得及查到东西。',
    '还差：把查到的整理成结论、补齐没查完的部分。',
    '点「接着做」，我从这里接着来，已经查过的不重复。',
    '<next>接着做</next>',
  )
  return lines.join('\n')
}

/** 收尾回合的最终那一段：模型给的能用就用它，否则用照实拼的。 */
export function finalizeWrapUp(
  text: string,
  fallback: Parameters<typeof wrapUpFallback>[0],
): string {
  return wrapUpUsable(text) ? text.trim() : wrapUpFallback(fallback)
}

/**
 * 普通运行这一回合要不要催一下：没有工具调用、话像「我接下来要…」、这次什么都还没交（没出卡 / 草稿 / 变更），
 * 工具面里还有工具可调，次数没到上限。
 */
export function shouldNudgeGeneral(input: {
  text: string
  hasTools: boolean
  delivered: boolean
  nudges: number
}): boolean {
  return (
    input.hasTools &&
    !input.delivered &&
    input.nudges < GENERAL_MAX_NUDGES &&
    input.text.trim() !== '' &&
    looksUnfinished(input.text)
  )
}

const ALL_WHICH: readonly BudgetWhich[] = [
  'max_tokens',
  'max_tool_calls',
  'max_turns',
  'max_seconds',
  'max_cost_base',
]

/** 从收尾那句提示里认回是哪一项到了（替身规则脑用；认不出就 `undefined`）。 */
export function wrapUpWhichOf(prompt: string): BudgetWhich | undefined {
  if (!isWrapUpPrompt(prompt)) return undefined
  return ALL_WHICH.find((w) => prompt.includes(budgetStopReason(w)))
}

/**
 * 剧本（stub / 替身规则脑）收尾的那一段：为什么停 + 已经查到的（`body`）+ 还差什么 + 怎么接着做。
 * 三个运行时在模拟里拼出同一段话。
 */
export function renderWrapUp(input: {
  which: BudgetWhich
  body: string
  missing?: string
}): string {
  return [
    `${budgetStopReason(input.which)}。下面是已经查到的：`,
    '',
    input.body.trim(),
    '',
    `还差：${input.missing ?? '没查完的部分还没来得及查'}。点「接着做」，我从这里接着来，已经查过的不重复。`,
    '<next>接着做</next>',
  ].join('\n')
}

/** 查资料的剧本：开了抓网页、预算到了时第一条来源还没细看（stub 与替身规则脑同一句）。 */
export const WEB_WRAP_UP_MISSING_FETCH = '第一条来源还没细看'
