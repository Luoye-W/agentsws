/**
 * 47 J1 本体登记表（Ontology Registry）。
 *
 * 一张**只读**的对象 / 链接 / 动作总表，由 `scripts/gen-ontology.mjs` 从契约、
 * 18 的副作用覆盖表、05 的职责定义与 29 的命名查询生成，签进仓库（`ontology.json`），
 * CI 里重生成后比 diff。
 *
 * 它不是新的存储（47 J4）：没有表、没有图数据库、没有"用户建本体"。
 * 它回答的只有三个问题——**这是什么、它连到什么、能对它做什么**。
 */
export { BRIEF_MAX_CHARS, freshnessText, ORDER_RULE, ontologyBrief } from './brief.js'
export {
  actionDef,
  linksOf,
  ONTOLOGY_JSON_PATH,
  objectDef,
  ontology,
  setOntology,
} from './registry.js'
export type { RunOntologyInput } from './run.js'
export { ontologyForRun, runOntologyBrief } from './run.js'
export type { OntologyForInput } from './tailor.js'
export { ontologyFor } from './tailor.js'
export type { ToolGroup } from './tools.js'
export { bareToolName, orderTools, TOOL_GROUP_ORDER, toolGroup } from './tools.js'
export type {
  ActionDef,
  Freshness,
  LinkDef,
  ObjectTypeDef,
  OntologyRegistry,
  PropertyDef,
  SourceOfTruth,
  TailoredAction,
  TailoredObject,
  TailoredOntology,
} from './types.js'
