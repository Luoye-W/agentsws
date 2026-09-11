/**
 * 47 J3 调用顺序：**工具面按三组排列**。
 *
 * 查对象（只读，按范围过滤）→ 查知识（带身份）→ 提议动作（staged change）。
 * 模型挑工具是从上往下扫的，顺序本身就是一句提示——把"先看现在是什么样"摆在
 * "翻翻政策怎么说"前面，把"提一条变更"摆在最后。
 *
 * **只换顺序，不换名字**：工具名一个字都不动（老的工具面顺序不变的那部分照旧），
 * 组内仍按名字排序，所以同一个 RunRequest 两次装配的工具清单逐字节相同（17 §6.2）。
 */
import { ontology } from './registry.js'
import type { OntologyRegistry } from './types.js'

export type ToolGroup = 'object' | 'knowledge' | 'action'

export const TOOL_GROUP_ORDER: readonly ToolGroup[] = ['object', 'knowledge', 'action']

/** 全名 `service.action` 去掉服务前缀。 */
export function bareToolName(name: string): string {
  return name.includes('.') ? name.slice(name.indexOf('.') + 1) : name
}

const READ_PREFIXES = ['get_', 'list_', 'search_', 'read_', 'find_', 'fetch_']
/** 名字里带这些词的读工具查的是**文字**，不是状态：归知识组。 */
const KNOWLEDGE_WORDS = ['polic', 'knowledge', 'fact', 'doc', 'faq', 'wiki']

/**
 * 一个工具属于哪一组。
 *
 * 先问登记表（它知道这个 Action 读的是哪类对象、是读还是写）；登记表里没有的
 * 才按名字兜底——**兜底一律最严**：判不出来的当成"提议动作"排在最后，
 * 免得一个写工具混在只读组里被模型当成"看看而已"。
 */
export function toolGroup(name: string, registry: OntologyRegistry = ontology()): ToolGroup {
  const bare = bareToolName(name)
  const def =
    registry.actions.find((a) => a.id === name) ??
    registry.actions.find((a) => bareToolName(a.id) === bare) ??
    registry.actions.find((a) => a.tool === bare)
  if (def !== undefined) {
    if (def.access === 'write') return 'action'
    return def.object === 'fact_card' ? 'knowledge' : 'object'
  }
  const lower = bare.toLowerCase()
  if (KNOWLEDGE_WORDS.some((w) => lower.includes(w))) return 'knowledge'
  if (READ_PREFIXES.some((p) => lower.startsWith(p))) return 'object'
  return 'action'
}

/**
 * 三组排列。组内按名字排序——组间的顺序是纪律，组内的顺序只是为了字节稳定。
 */
export function orderTools(
  names: readonly string[],
  registry: OntologyRegistry = ontology(),
): string[] {
  const rank = new Map<string, number>()
  for (const n of names) rank.set(n, TOOL_GROUP_ORDER.indexOf(toolGroup(n, registry)))
  return [...names].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0) || a.localeCompare(b))
}
