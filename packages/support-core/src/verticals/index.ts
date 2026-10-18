/**
 * 垂直包 registry —— **唯一的解析入口**（48 v2 L2）。
 *
 * 所有读工作区的代码通过 `WorkspaceProfile.vertical` 取包；运行时经
 * `RunRequest.vertical` 拿到同一个值。
 *
 * `null` / `undefined` / 任何非法值 → `goods`。存量工作区、老的导出包、手改过的库行，
 * 全部落在这一条上，而那正是"现有电商工作区零变化"的兜底：拿不到垂直时的行为
 * 必须与这一版上线前完全相同。
 */
import { hasContentTableProviders } from '@agentsws/core'
import {
  chatRulesFromRows,
  classifierRulesFromRows,
  emailRulesFromRows,
  labelsFromRows,
  missingInfoFromRows,
  normalizeEnumLineFromRows,
  openingStrategiesFromRows,
  personaFromRows,
  planTextFromRows,
  type RuleRow,
  triageScopeFromRows,
  type VerticalContentTables,
  verticalRows,
} from './content.js'
import { digitalPack } from './digital/index.js'
import { DIGITAL_TABLES } from './digital/tables.js'
import { goodsPack } from './goods/index.js'
import { GOODS_TABLES } from './goods/tables.js'
import { isVertical, type Vertical, type VerticalPack } from './types.js'

const PACKS: Record<Vertical, VerticalPack> = {
  goods: goodsPack,
  digital: digitalPack,
}

/** WP404：各包的三张内容表（按品牌覆盖时拿它们重拼文字那几格）。 */
const TABLES: Record<Vertical, VerticalContentTables> = {
  goods: GOODS_TABLES,
  digital: DIGITAL_TABLES,
}

/**
 * 取包。非法值一律按"没选过"处理，回落实物。
 *
 * WP404：给了 `brand` 且宿主登记了内容覆盖源（`registerContentTableProvider`）时，文字那几格
 * （persona、聊天 / 邮件规则、分流范围、意图标签与判据、开场策略、缺料清单与计划文案）按这个品牌的表重拼；
 * 判法与结构（值域、闸、L3、知识、边界……）不变。没登记覆盖源 → 原样那个常量包，与外置前一样。
 */
export function getVerticalPack(
  vertical: Vertical | string | null | undefined,
  options: { brand?: string } = {},
): VerticalPack {
  const pack = isVertical(vertical) ? PACKS[vertical] : goodsPack
  if (options.brand === undefined || !hasContentTableProviders()) return pack
  return packWithContent(pack, options.brand)
}

/** 按品牌的表把文字那几格重拼一遍（键的位置不变）。 */
function packWithContent(pack: VerticalPack, brand: string): VerticalPack {
  const rows = verticalRows(TABLES[pack.key], brand)
  const others: Record<string, readonly RuleRow[]> = {}
  for (const [key, tables] of Object.entries(TABLES))
    others[key] = verticalRows(tables, brand).rules
  return {
    ...pack,
    persona: personaFromRows(rows.persona),
    chatRules: chatRulesFromRows(rows.rules, pack.chatRules.boundaryRuleIndex, others),
    emailRules: emailRulesFromRows(rows.rules, others),
    intents: {
      ...pack.intents,
      labelsZh: labelsFromRows(rows.intents),
      classifierRules: classifierRulesFromRows(rows.intents),
      guideOpeningStrategies: openingStrategiesFromRows(rows.intents),
      normalizeEnumLine: normalizeEnumLineFromRows(rows.intents),
      triageScope: triageScopeFromRows(rows.rules),
    },
    chatPlan: {
      ...pack.chatPlan,
      missingInfo: missingInfoFromRows(rows.intents),
      defaultNextQuestionZh: planTextFromRows(rows.intents, 'defaultNextQuestionZh'),
      handoffReplyEn: planTextFromRows(rows.intents, 'handoffReplyEn'),
    },
  }
}

/** 非法值一律按"没选过"处理（导入的档案、老数据、手填的字段）。 */
export function normalizeVertical(vertical: unknown): Vertical | undefined {
  return isVertical(vertical) ? vertical : undefined
}

/** 首次设置那一步要列的选项：`key` + 中文名 + 一句人话。 */
export function verticalChoices(): { key: Vertical; label: string; hint: string }[] {
  return [goodsPack, digitalPack].map((p) => ({ key: p.key, label: p.labelZh, hint: p.hintZh }))
}

export type { IntentRow, PersonaRow, RuleRow, VerticalContentTables } from './content.js'
export { digitalPack } from './digital/index.js'
export { DIGITAL_TABLES } from './digital/tables.js'
export { goodsPack } from './goods/index.js'
export { GOODS_TABLES } from './goods/tables.js'
export * from './render.js'
export * from './types.js'
