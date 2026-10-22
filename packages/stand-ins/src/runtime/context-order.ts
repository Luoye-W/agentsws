/**
 * WP472（docs/116 §5 / §6 A，决策 1549）：一次运行的上下文**排在哪一层、谁先谁后**——三个运行时同一份。
 *
 * 缓存的规矩只有一条：固定的在前，每次都变的在后；历史只往后加。DeepSeek 按「这次发过去的开头和之前某次
 * 逐字一样」的那一截收命中价，所以一条每次都变的内容排在前面，后面整段都对不上。
 *
 * - **系统提示那一层只放不变的**：工作区政策（`policy`）、确认过的业务边界（`boundary`）。DeepSeek 账号口 /
 *   Claude 这类 Messages 口会把所有系统消息并成开头那一段——每次都变的东西走这一层，整段系统提示就每次都不同。
 * - **其余一律走用户消息那一层**，排在系统提示之后，顺序固定：
 *   这件事之前的对话原文（只往后加）→ 记录（预取、事实卡、订单、钉住的记录……按请求里的先后）→
 *   事项摘要 → 岗位状态 → 当前设置快照 → app 事件 → 现在时间 → 这一次的话（`thread`）。
 *
 * 实测（WP472 报告）：DeepSeek 普通口（chat）里中途的系统消息原位不动、不会被提到最前，改它只丢它后面那截；
 * 工具定义摆在开头那段连续的系统消息之后、对话之前。所以普通口上省下来的靠**顺序**，账号口上还靠**层级**。
 */
import type { ChatMessage, ContextItem } from '@agentsws/contracts'

/** 走系统提示那一层的几种（不变的规矩）。 */
const SYSTEM_KINDS: ReadonlySet<string> = new Set<ContextItem['kind']>(['policy', 'boundary'])

/** WP410：「当前设置快照」那一条的 id（服务端 `SETUP_STATE_CONTEXT_ID`，这里只认不引）。 */
const SETUP_STATE_ID = 'setup_state'

/** 一条上下文进哪一层（只看 kind：dsh 那一档在线上只拿得到 `[kind:id]` 这一行）。 */
export function contextRoleOf(kind: string): Extract<ChatMessage['role'], 'system' | 'user'> {
  return SYSTEM_KINDS.has(kind) ? 'system' : 'user'
}

/** 岗位状态那一条（服务端 `contextOf` 的岗位层：`summary`，出处是岗位）。 */
function isPositionState(item: ContextItem): boolean {
  if (item.kind !== 'summary') return false
  const src = item.source_ref
  return (typeof src !== 'string' && src.type === 'position') || item.id.startsWith('position_')
}

/** 用户消息那一层里的先后（小的在前）。 */
function rankOf(item: ContextItem): number {
  if (SYSTEM_KINDS.has(item.kind)) return item.kind === 'policy' ? 0 : 1
  if (item.kind === 'history') return 2
  if (item.kind === 'matter_summary') return 4
  if (isPositionState(item)) return 5
  if (item.id === SETUP_STATE_ID) return 6
  if (item.kind === 'app_events') return 7
  if (item.kind === 'time') return 8
  if (item.kind === 'thread') return 9
  // 预取、事实卡、订单、客户、记忆、钉住的记录……：同一档里按请求里的先后（预取本来就排第一，17 §6.5）
  return 3
}

/** 按上面那张表排好（同一档内保持请求里的先后）。三个运行时都用它。 */
export function orderContextItems(items: readonly ContextItem[]): ContextItem[] {
  return items
    .map((item, i) => ({ item, i, rank: rankOf(item) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.item)
}
