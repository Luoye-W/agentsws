import type { ObjectRef, RunRequest } from '@agentsws/contracts'
import { OUTPUT_TOOLS } from './assemble.js'

/** 16 §3 副作用表：工具名 → 读 / 写外部。宿主提供；不给的按读处理（executeTool 是兜底那道门）。 */
export type SideEffectLookup = (tool: string) => 'read' | 'write' | undefined

export interface GateDecision {
  allowed: boolean
  reason?: string
}

/** allowlist 匹配：全名相等，或一端是另一端去掉 `service.` 前缀后的裸名。 */
export function inAllowlist(tool: string, allow: readonly string[]): boolean {
  return allow.some((a) => a === tool || a.endsWith(`.${tool}`) || tool.endsWith(`.${a}`))
}

/**
 * 17 §6.3 两道门，模型的每一次工具调用都先过：
 * 1. 不在 `tools.allow` 里 → blocked，**不到达工具**
 * 2. `side_effect_policy: 'executor'` 下写外部 → blocked（公司端写口只在执行器手里，16 §3）
 *
 * 产出工具（`draft_reply` / `stage_refund`）是宿主回调，不是外部 Action：不过 allowlist，
 * 也永远不写外部——它们只产出待批的提案。
 */
export function gateToolCall(
  tool: string,
  req: RunRequest,
  sideEffectOf?: SideEffectLookup,
): GateDecision {
  if (OUTPUT_TOOLS.includes(tool)) return { allowed: true }
  if (!inAllowlist(tool, req.tools.allow)) {
    return { allowed: false, reason: `not_in_allowlist: ${tool}` }
  }
  if (sideEffectOf?.(tool) === 'write' && req.tools.side_effect_policy === 'executor') {
    return { allowed: false, reason: `write_external_requires_executor: ${tool}` }
  }
  return { allowed: true }
}

/**
 * 15 §6 provenance：工具结果里认得出的实体（"读过"，不是"有权"）。
 * 与 stub 运行时同一套判定，两个运行时对同一份工具结果推出同一组 ref。
 */
export function inferRefs(data: unknown): ObjectRef[] {
  const o =
    data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
  if (o === undefined) return []
  const refs: ObjectRef[] = []
  if (typeof o.id === 'string') {
    if ('financial_status' in o || 'line_items' in o) refs.push({ type: 'order', id: o.id })
    else if ('price' in o && 'title' in o) refs.push({ type: 'product', id: o.id })
  }
  if (Array.isArray(o.orders)) {
    for (const item of o.orders) {
      const r =
        item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : undefined
      if (typeof r?.id === 'string') refs.push({ type: 'order', id: r.id })
    }
  }
  if (Array.isArray(o.hits)) {
    for (const item of o.hits) {
      const r =
        item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : undefined
      if (typeof r?.id === 'string' && typeof r.statement === 'string') {
        refs.push({ type: 'fact_card', id: r.id })
      }
    }
  }
  return refs
}
