/**
 * 47 J3：**运行时那一份裁剪**。
 *
 * 与 `ontologyFor`（界面用，输入是 `EffectiveConfig`）同一张登记表、同一个渲染器，
 * 只是输入换成了 `RunRequest` 手上有的东西——工具 allowlist 与职责 id。
 *
 * 为什么不直接用 `EffectiveConfig`：17 §1 的 `RunRequest` 里**没有** scopes。
 * 运行时能自己算出来的，只能是"这次运行摆了哪些工具在你面前"。这反而是对的——
 * allowlist 本来就是从职责推出来的，而范围过滤在网关那一层已经做了，
 * 不必在提示词里再许诺一次。
 *
 * 纯函数：同一份输入两次渲染逐字节相同（静态前缀要稳，22 §2）。
 */
import { ontologyBrief } from './brief.js'
import { ontology } from './registry.js'
import { bareToolName } from './tools.js'
import type { OntologyRegistry, TailoredAction, TailoredObject, TailoredOntology } from './types.js'

export interface RunOntologyInput {
  assignment_id: string
  role_id: string
  /** `RunRequest.tools.allow` 加上运行时自己的产出工具（`stage_refund` / `draft_reply`）。 */
  tools: readonly string[]
}

/** allowlist 的匹配口径与 17 §6.3 的两道门一致：全名相等，或去掉 `service.` 前缀后相等。 */
function known(tools: ReadonlySet<string>, bare: ReadonlySet<string>, name: string): boolean {
  return tools.has(name) || bare.has(bareToolName(name))
}

/** 按这次运行的工具面裁剪登记表。 */
export function ontologyForRun(
  input: RunOntologyInput,
  registry: OntologyRegistry = ontology(),
): TailoredOntology {
  const tools = new Set(input.tools)
  const bare = new Set(input.tools.map(bareToolName))

  const objects: TailoredObject[] = []
  const kept = new Set<string>()
  for (const def of registry.objects) {
    const via = def.read_via.filter((v) => known(tools, bare, v))
    if (via.length === 0) continue
    kept.add(def.id)
    objects.push({
      id: def.id,
      label: def.label,
      source_of_truth: def.source_of_truth,
      freshness: def.freshness,
      read_via: via,
    })
  }

  const actions: TailoredAction[] = []
  for (const def of registry.actions) {
    if (def.source !== 'role') continue
    if (def.roles !== undefined && !def.roles.includes(input.role_id)) continue
    if (!known(tools, bare, def.tool ?? def.id)) continue
    const label = registry.objects.find((o) => o.id === def.object)?.label ?? def.object
    actions.push({
      id: def.id,
      object: def.object,
      label: `${def.what}（${label}）`,
      ...(def.tool === undefined ? {} : { tool: def.tool }),
      ...(def.change_kind === undefined ? {} : { change_kind: def.change_kind }),
      risk_class: def.risk_class,
      requires_approval: def.requires_approval,
      ...(def.route_to === undefined ? {} : { route_to: def.route_to }),
    })
  }

  const links = registry.links.filter((l) => kept.has(l.from) && kept.has(l.to))
  return { assignment_id: input.assignment_id, role_id: input.role_id, objects, actions, links }
}

/**
 * 直接给一段中文——`assemblePrompt` 拿的就是它（三个运行时共用同一处，17 §1）。
 * 工具面为空时回空串：没有工具就没有"你能查什么"可说，不必往 prompt 里塞一段废话。
 */
export function runOntologyBrief(
  input: RunOntologyInput,
  registry: OntologyRegistry = ontology(),
): string {
  if (input.tools.length === 0) return ''
  return ontologyBrief(ontologyForRun(input, registry))
}
