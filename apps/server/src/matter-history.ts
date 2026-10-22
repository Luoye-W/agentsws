/**
 * WP472（docs/116 §6 C，决策 1551）：岗位 / 事项对话**带上这件事之前的原文**。
 *
 * 以前事项里每说一句就是一次全新的运行，只带一份每轮重写的摘要——第 N+1 句和第 N 句能共用的只有最开头那段。
 * 现在把这件事的来回原文（人的话 + 岗位的回复，按先后）作为一条上下文（`kind: 'history'`）带上：
 *
 * - **只往后加**：这一次的历史 = 上一次的历史 + 上一句人话 + 上一次的回复，前面一个字不动——前缀命中缓存；
 * - **只带文字**：工具调用过程、卡、状态行不进；附件只留占位（`［附件：名字］`），要看原文由岗位按需去取；
 * - **太长就一次折一大截**（照助理的办法，docs/115 / WP352）：原文超过预算，把较早那部分**一次**折成一段固定的
 *   小结放在最前面，之后照旧只往后加，下一次再超才重折。折点是事件序列的纯函数（从第一句起逐句累加、
 *   超了就折到只剩预算的四成），所以不用存——同样的时间线每次算出同一个折点、同一段小结，不会每轮重写。
 *   小结用规则拼（每句开头几十个字），不另调模型：零花费，而且同样的输入永远同样的字节。
 *
 * 这一条排在静态系统提示之后、事项摘要 / 岗位状态 / 时间 / 这一次的话之前（`orderContextItems`）。
 */
import type { ContextItem, MatterEvent, MatterId } from '@agentsws/contracts'
import { estimateTokens } from './assistant-thread.js'

/** 历史原文最多占模型窗口的多少（剩下的给提示词、工具结果和这一次的话）。 */
export const HISTORY_WINDOW_RATIO = 0.25
/** 历史原文的封顶（窗口再大也不超过）。 */
export const HISTORY_CAP_TOKENS = 32_000
/** 折一次之后，最近的原文留多少（占预算的比例；与助理段内压缩 `RETAIN_RATIO` 同一个数）。 */
export const HISTORY_RETAIN_RATIO = 0.4
/** 折起来的那段小结里，每句留多少字。 */
const FOLD_LINE_CHARS = 60
/** 折起来的那段小结最多多少 token（再多就只留最近的几句，前面写「更早的略」）。 */
const FOLD_CAP_TOKENS = 1_500

/** 这一条的抬头（固定字节：每次都一样，前缀才对得上）。 */
const HEAD = '这件事里之前的对话（按先后；最后那句新话在后面单独给出）：'
const FOLD_HEAD = '［更早的对话已折起，每句只留开头］'

/** 历史预算（token）：窗口的四分之一，封顶 3.2 万；窗口拿不到按 64K。 */
export function historyBudgetFor(window: number | undefined): number {
  const w = window !== undefined && Number.isFinite(window) && window > 0 ? window : 64_000
  return Math.max(1_000, Math.min(Math.floor(w * HISTORY_WINDOW_RATIO), HISTORY_CAP_TOKENS))
}

interface Turn {
  who: '人' | '你'
  text: string
}

/** 一条时间线事件 → 一句历史（不是人话 / 岗位回复的不要）。 */
function turnOf(e: MatterEvent): Turn | undefined {
  if (e.kind !== 'human_message' && e.kind !== 'agent_message') return undefined
  const files = (e.attachments ?? []).map((a) => `［附件：${a.name}］`)
  const text = [e.text.trim(), ...files].filter((t) => t !== '').join('\n')
  if (text === '') return undefined
  return { who: e.kind === 'human_message' ? '人' : '你', text }
}

const lineOf = (t: Turn): string => `${t.who}：${t.text}`

/**
 * 这一次之前的那几句（按先后）。时间线最后一句是人话、后面还没有回复——那就是这一次要回的那句，
 * 它另作「这一次的话」（`thread`）给，不进历史；最后一句是回复（重跑 / 接着跑）就全进。
 */
export function priorTurns(events: readonly MatterEvent[]): Turn[] {
  const turns: Turn[] = []
  let pendingHuman = false
  for (const e of events) {
    const t = turnOf(e)
    if (t === undefined) continue
    turns.push(t)
    pendingHuman = e.kind === 'human_message'
  }
  return pendingHuman ? turns.slice(0, -1) : turns
}

const clip = (text: string): string => {
  const flat = text.replace(/\s+/gu, ' ').trim()
  const chars = [...flat]
  return chars.length <= FOLD_LINE_CHARS ? flat : `${chars.slice(0, FOLD_LINE_CHARS).join('')}…`
}

/** 折起来的那几句 → 一段固定的小结（规则拼的，同样的输入永远同样的字节）。 */
function foldText(folded: readonly Turn[]): string {
  const lines = folded.map((t) => `${t.who}：${clip(t.text)}`)
  let start = 0
  const total = (from: number): number =>
    lines.slice(from).reduce((n, l) => n + estimateTokens(l) + 1, 0)
  while (start < lines.length - 1 && total(start) > FOLD_CAP_TOKENS) start += 1
  return [
    FOLD_HEAD,
    ...(start > 0 ? [`（再早的 ${String(start)} 句略）`] : []),
    ...lines.slice(start),
  ].join('\n')
}

/**
 * 折点：从第一句起逐句累加，原文超过预算就把前面折掉、只留预算的四成；之后照旧累加，再超再折。
 * 是事件序列的纯函数——前 n 句的折点只由前 n 句决定，所以新加一句只会「不变」或「往后挪一大截」。
 */
export function foldPoint(turns: readonly Turn[], budgetTokens: number): number {
  const cost = turns.map((t) => estimateTokens(lineOf(t)) + 1)
  const retain = Math.floor(budgetTokens * HISTORY_RETAIN_RATIO)
  let fold = 0
  let raw = 0
  for (let i = 0; i < cost.length; i += 1) {
    raw += cost[i] ?? 0
    if (raw <= budgetTokens) continue
    // 超了：从前往后折，直到剩下的原文不超过预算的四成（这一句本身太长也至少留着它）
    while (fold < i && raw > retain) {
      raw -= cost[fold] ?? 0
      fold += 1
    }
  }
  return fold
}

/** 历史那一条的正文（没有之前的话就是 `undefined`，不出这一条）。 */
export function historyText(
  events: readonly MatterEvent[],
  budgetTokens: number,
): string | undefined {
  const turns = priorTurns(events)
  if (turns.length === 0) return undefined
  const fold = foldPoint(turns, budgetTokens)
  return [
    HEAD,
    ...(fold > 0 ? [foldText(turns.slice(0, fold))] : []),
    ...turns.slice(fold).map(lineOf),
  ].join('\n')
}

/** 历史那一条上下文（`kind: 'history'`，id 按事项，跨运行同一个）。 */
export function matterHistoryItem(input: {
  matter_id: MatterId
  events: readonly MatterEvent[]
  budgetTokens: number
}): ContextItem | undefined {
  const content = historyText(input.events, input.budgetTokens)
  if (content === undefined) return undefined
  return {
    id: `history_${input.matter_id}`,
    kind: 'history',
    source_ref: { type: 'matter', id: input.matter_id },
    sensitivity: 'internal',
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
  }
}
