/**
 * 登记表的加载：`ontology.json` 是**生成物**（`scripts/gen-ontology.mjs`），
 * 签进仓库、CI 里重生成后比 diff（同 SDK 的做法，42 §2）。
 *
 * 运行期只读一次、只读文件——不建表、不进库（47 J4：登记表不是新的存储）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ActionId, ObjectType } from '@agentsws/contracts'
import type { ActionDef, LinkDef, ObjectTypeDef, OntologyRegistry } from './types.js'

/** 本包自带的那一份（`packages/ontology/ontology.json`）。 */
export const ONTOLOGY_JSON_PATH = fileURLToPath(new URL('../ontology.json', import.meta.url))

let cached: OntologyRegistry | undefined

/** 读登记表（第一次读文件，之后回同一份；返回值当只读用）。 */
export function ontology(): OntologyRegistry {
  cached ??= JSON.parse(readFileSync(ONTOLOGY_JSON_PATH, 'utf8')) as OntologyRegistry
  return cached
}

/** 测试用：换一份登记表（传 undefined 恢复自带的那份）。 */
export function setOntology(registry: OntologyRegistry | undefined): void {
  cached = registry
}

export function objectDef(id: ObjectType, registry = ontology()): ObjectTypeDef | undefined {
  return registry.objects.find((o) => o.id === id)
}

export function actionDef(id: ActionId, registry = ontology()): ActionDef | undefined {
  return registry.actions.find((a) => a.id === id)
}

/** 一个对象连出去 / 被连进来的全部链接。 */
export function linksOf(id: ObjectType, registry = ontology()): LinkDef[] {
  return registry.links.filter((l) => l.from === id || l.to === id)
}
