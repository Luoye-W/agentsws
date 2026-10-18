/**
 * WP404（docs/107 §3）：客服垂直包的**文字内容是数据**——每个垂直包三份（`persona` / `rules` / `intents`
 * `.content.json`，每一行带稳定 id），这里把行拼回 `VerticalPack` 里那几格原来的形状。
 *
 * 拼出来的对象与外置前**逐字节相同**（键的顺序也一样：行里除了 `id` / `kind` / `set` / `notes` 之外的格子
 * 原样展开）。`notes` 是原代码里的注释，判法不读。
 *
 * 按品牌可覆盖：`readContentTable(表, { brand })`；没登记覆盖源时就是随软件带的那一份，
 * 包在模块加载时拼一次（`goodsPack` / `digitalPack`），与外置前一样是常量。
 */
import type { ContentTableFile } from '@agentsws/contracts'
import { builtinContentTable, readContentTable } from '@agentsws/core'
import type {
  ChatPlanMissingInfoRule,
  VerticalChatClassifierRule,
  VerticalChatRules,
  VerticalEmailRules,
  VerticalPersona,
  VerticalPersonaKey,
} from './types.js'

/** 一个垂直包的三张表。 */
export interface VerticalContentTables {
  persona: ContentTableFile<PersonaRow>
  rules: ContentTableFile<RuleRow>
  intents: ContentTableFile<IntentRow>
}

export interface PersonaRow {
  id: VerticalPersonaKey
  text: string
}

export interface RuleRow {
  id: string
  set: 'chat' | 'chat_boundary' | 'email_agent' | 'email_rewrite' | 'triage_scope'
  /** 原文。没有 = 「同现状」，取 `same_as` 那个包里同一个 id 的那一行。 */
  text?: string
  same_as?: string
  notes?: string[]
}

export type IntentRow =
  | { id: string; kind: 'label' | 'opening'; intent: string; text: string }
  | ({ id: string; kind: 'classifier'; notes?: string[] } & VerticalChatClassifierRule)
  | { id: string; kind: 'normalize_enum_line'; text: string }
  | ({ id: string; kind: 'missing_info'; notes?: string[] } & ChatPlanMissingInfoRule)
  | {
      id: string
      kind: 'plan_text'
      field: 'defaultNextQuestionZh' | 'handoffReplyEn'
      text: string
      notes?: string[]
    }

/** 随软件带的三张表（模块加载时校验一次：缺 id / id 重名直接抛）。 */
export function verticalTables(files: {
  persona: unknown
  rules: unknown
  intents: unknown
}): VerticalContentTables {
  return {
    persona: builtinContentTable<PersonaRow>(files.persona as ContentTableFile<PersonaRow>),
    rules: builtinContentTable<RuleRow>(files.rules as ContentTableFile<RuleRow>),
    intents: builtinContentTable<IntentRow>(files.intents as ContentTableFile<IntentRow>),
  }
}

const isPersonaRow = (r: unknown): r is PersonaRow => typeof (r as PersonaRow).text === 'string'
const isRuleRow = (r: unknown): r is RuleRow =>
  typeof (r as RuleRow).set === 'string' &&
  (typeof (r as RuleRow).text === 'string' || typeof (r as RuleRow).same_as === 'string')
const isIntentRow = (r: unknown): r is IntentRow => typeof (r as IntentRow).kind === 'string'

/** 这一次用的三张表的行（按品牌可覆盖）。 */
export function verticalRows(
  tables: VerticalContentTables,
  brand?: string,
): { persona: readonly PersonaRow[]; rules: readonly RuleRow[]; intents: readonly IntentRow[] } {
  return {
    persona: readContentTable(tables.persona, { brand, accepts: isPersonaRow }),
    rules: readContentTable(tables.rules, { brand, accepts: isRuleRow }),
    intents: readContentTable(tables.intents, { brand, accepts: isIntentRow }),
  }
}

/** persona 那一格：站点名 → 开场那一句（键的顺序 = 行的顺序）。 */
export function personaFromRows(rows: readonly PersonaRow[]): VerticalPersona {
  const out: Partial<Record<VerticalPersonaKey, string>> = {}
  for (const r of rows) out[r.id] = r.text
  return out as VerticalPersona
}

/**
 * 一行规则的原文。「同现状」的那几行按 id 去另一个包里取——取不到当场抛
 * （与外置前 `goodsChatRule('4')` 那几个取材函数同一条纪律：宁可加载时红，不让一条边界静默消失）。
 */
function ruleText(row: RuleRow, others: Readonly<Record<string, readonly RuleRow[]>>): string {
  if (row.text !== undefined) return row.text
  const from = row.same_as === undefined ? undefined : others[row.same_as]
  const hit = from?.find((r) => r.id === row.id)
  if (hit?.text === undefined)
    throw new Error(
      `客服规则 ${row.id}：${String(row.same_as)} 包里找不到这一条，「同现状」条目无从取材`,
    )
  return hit.text
}

/** 聊天规则那一格。`boundaryRuleIndex`（第 11 条插在哪儿）是结构，由调用方给。 */
export function chatRulesFromRows(
  rows: readonly RuleRow[],
  boundaryRuleIndex: number,
  others: Readonly<Record<string, readonly RuleRow[]>> = {},
): VerticalChatRules {
  const boundary = rows.find((r) => r.set === 'chat_boundary')
  if (boundary === undefined) throw new Error('客服规则：缺「商家额外边界」那一条模板')
  return {
    numbered: rows.filter((r) => r.set === 'chat').map((r) => ruleText(r, others)),
    boundaryRuleIndex,
    boundaryRuleTemplate: ruleText(boundary, others),
  }
}

/** 邮件规则那一格。 */
export function emailRulesFromRows(
  rows: readonly RuleRow[],
  others: Readonly<Record<string, readonly RuleRow[]>> = {},
): VerticalEmailRules {
  return {
    emailAgent: rows.filter((r) => r.set === 'email_agent').map((r) => ruleText(r, others)),
    emailRewrite: rows.filter((r) => r.set === 'email_rewrite').map((r) => ruleText(r, others)),
  }
}

/** 分流范围（判定为客服邮件 / 非客服邮件的那两句）。 */
export function triageScopeFromRows(rows: readonly RuleRow[]): {
  include: string
  exclude: string
} {
  const of = (id: string): string => {
    const r = rows.find((x) => x.id === id)
    if (r?.text === undefined) throw new Error(`客服规则：缺 ${id}`)
    return r.text
  }
  return { include: of('triage_scope.include'), exclude: of('triage_scope.exclude') }
}

/** 去掉行自己的那几格（id / kind / notes），剩下的按原顺序就是外置前那个对象。 */
function body<T>(row: Record<string, unknown>): T {
  const { id: _id, kind: _kind, notes: _notes, ...rest } = row
  return rest as T
}

/** 意图标签（`labelsZh`）。 */
export function labelsFromRows(rows: readonly IntentRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) if (r.kind === 'label') out[r.intent] = r.text
  return out
}

/** 分类器判据（顺序即优先级）。 */
export function classifierRulesFromRows(
  rows: readonly IntentRow[],
): readonly VerticalChatClassifierRule[] {
  return rows
    .filter((r) => r.kind === 'classifier')
    .map((r) => body<VerticalChatClassifierRule>(r as unknown as Record<string, unknown>))
}

/** 开场引导策略。 */
export function openingStrategiesFromRows(rows: readonly IntentRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) if (r.kind === 'opening') out[r.intent] = r.text
  return out
}

/** 归一化 prompt 的铁律第 5 条。 */
export function normalizeEnumLineFromRows(rows: readonly IntentRow[]): string {
  const r = rows.find((x) => x.kind === 'normalize_enum_line')
  if (r === undefined || r.kind !== 'normalize_enum_line')
    throw new Error('客服意图表：缺归一化那一行')
  return r.text
}

/** 缺料清单（顺序即拼装顺序）。 */
export function missingInfoFromRows(rows: readonly IntentRow[]): ChatPlanMissingInfoRule[] {
  return rows
    .filter((r) => r.kind === 'missing_info')
    .map((r) => body<ChatPlanMissingInfoRule>(r as unknown as Record<string, unknown>))
}

/** 计划里那两句文案（`defaultNextQuestionZh` / `handoffReplyEn`）。 */
export function planTextFromRows(
  rows: readonly IntentRow[],
  field: 'defaultNextQuestionZh' | 'handoffReplyEn',
): string {
  for (const r of rows) if (r.kind === 'plan_text' && r.field === field) return r.text
  throw new Error(`客服意图表：缺计划文案 ${field}`)
}
