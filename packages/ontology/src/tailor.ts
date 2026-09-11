/**
 * 47 J1 最后一段：**按岗位裁剪**。
 *
 * 一整张登记表对模型没用——他只会在里面挑到自己根本碰不到的对象，然后去调一个
 * 一定会被门禁拒掉的工具。裁剪的规则只有两条，都不是这里发明的：
 *
 * 1. **看得见什么**：05 §1.1 的 `PermissionScope`——这条岗位对某个数据域有没有 `read`，
 *    有的话范围多大（`own` < `assigned` < `workspace`）。
 * 2. **动得了什么**：这条岗位的 `EffectiveAction`（05 §4 已经把 Role 默认、工作区策略、
 *    分配收紧三层解析完了），再要求**它的目标对象这条岗位读得到**——
 *    15 §6 的 provenance 门禁本来就只让人动本次运行读过的实体，
 *    读不到的对象上摆一个动作，模型调了也只会吃一个 `provenance_missing`。
 *
 * 裁剪只做减法：登记表里没有的动作不会在这里冒出来。
 */
import type { EffectiveConfig, ObjectType, Range } from '@agentsws/contracts'
import { ontology } from './registry.js'
import type {
  LinkDef,
  ObjectTypeDef,
  OntologyRegistry,
  TailoredAction,
  TailoredObject,
  TailoredOntology,
} from './types.js'

/**
 * `ontologyFor` 要的那几格。
 *
 * 取 `EffectiveConfig` 的子集而不是取一个 `assignment_id` 再自己去查库：本包是**只读索引**，
 * 不持有任何存储，也就没有"从 id 查岗位"的能力。调用方（网关 / 工作台路由）手上
 * 本来就有 `effectiveConfig(assignment_id)` 的结果，直接递进来。
 */
export type OntologyForInput = Pick<
  EffectiveConfig,
  'assignment_id' | 'role_id' | 'scopes' | 'actions'
>

const RANGE_WIDTH: Record<Range, number> = { own: 0, assigned: 1, workspace: 2 }

/** 同一个域上有多条 scope 时取最宽的那一条。 */
function widestReadRange(input: OntologyForInput, def: ObjectTypeDef): Range | undefined {
  let best: Range | undefined
  for (const scope of input.scopes) {
    if (scope.domain !== def.domain) continue
    if (!scope.ops.includes('read')) continue
    if (best === undefined || RANGE_WIDTH[scope.range] > RANGE_WIDTH[best]) best = scope.range
  }
  return best
}

/**
 * 按岗位裁剪出这条岗位**能查什么、能做什么**。产物是给界面的 JSON；
 * 给模型的紧凑文本用 `ontologyBrief` 渲染同一份数据。
 */
export function ontologyFor(
  input: OntologyForInput,
  registry: OntologyRegistry = ontology(),
): TailoredOntology {
  const byObject = new Map(registry.objects.map((o) => [o.id, o]))

  const objects: TailoredObject[] = []
  const ranges = new Map<ObjectType, Range>()
  for (const def of registry.objects) {
    const range = widestReadRange(input, def)
    if (range === undefined) continue
    ranges.set(def.id, range)
    objects.push({
      id: def.id,
      label: def.label,
      read_range: range,
      source_of_truth: def.source_of_truth,
      freshness: def.freshness,
      read_via: [...def.read_via],
    })
  }

  const byActionId = new Map(input.actions.map((a) => [a.id, a]))
  const actions: TailoredAction[] = []
  for (const def of registry.actions) {
    if (def.source !== 'role') continue
    const effective = byActionId.get(def.id)
    if (effective === undefined) continue
    if (!ranges.has(def.object)) continue
    const label = byObject.get(def.object)?.label ?? def.object
    actions.push({
      id: def.id,
      object: def.object,
      label: `${def.what}（${label}）`,
      ...(def.tool === undefined ? {} : { tool: def.tool }),
      ...(def.change_kind === undefined ? {} : { change_kind: def.change_kind }),
      // 05 §4 已经把三层额度解析完了：风险级以那一份为准，登记表只是缺省
      risk_class: effective.risk_class,
      requires_approval: def.requires_approval || effective.review_cannot_be_disabled,
      ...(typeof effective.route_to === 'string' ? { route_to: effective.route_to } : {}),
    })
  }

  const links: LinkDef[] = registry.links.filter((l) => ranges.has(l.from) && ranges.has(l.to))

  return { assignment_id: input.assignment_id, role_id: input.role_id, objects, actions, links }
}
