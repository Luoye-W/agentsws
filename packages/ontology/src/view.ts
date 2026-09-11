/**
 * **浏览器也能 import 的那一半**：类型 + 纯函数，不碰文件系统。
 *
 * `./index.js` 会读 `ontology.json`（`node:fs`），打进工作台的包里就炸了。
 * 工作台要的只有两样——登记表的形状（服务端回给它的那个 JSON）与那段固定话，
 * 两样都不需要登记表本体，所以单开一个入口。
 *
 * 纪律：**这个文件里不许出现任何 `node:` 导入**，也不许转出 `registry.js` 的东西。
 */
export { BRIEF_MAX_CHARS, freshnessText, ORDER_RULE, ontologyBrief } from './brief.js'
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
