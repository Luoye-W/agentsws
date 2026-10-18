/**
 * WP404（docs/107 §3 / §12 一期 A）：**岗位内容**的形状——职责 / 岗位里哪些字段算「内容」、能被一层层覆盖。
 *
 * 一条职责 yml 里其实有两样东西：
 *
 * - **骨架**：权限、工具、连接、自动化档位、阈值、出卡规则、浏览器范围、首页块、通知……是程序和安全底线，
 *   **随软件版本走**（docs/90 §2 的分界线不变）；
 * - **内容**：给模型读、给人看的文字——名字、一句话说明、角色定位、快捷问题、示例任务、意图词。
 *
 * 不物理拆 yml：开源仓的 yml 原样当「基础版」，内容层是叠在上面的一份只含白名单字段的数据
 * （`applyRoleContent` / `applyPositionContent`，在 `@agentsws/roles`）。内容层里出现白名单外的字段
 * **整份拒收**——一个拼错的键被静默忽略，比报错危险得多（与 `collectUnknownKeys` 同一条纪律）。
 *
 * 这一单只把「内容」和「骨架」分清、让内容能叠；不接云、不出卡（那是 WP406）。
 */
import type { RoleId } from './common.js'
import type { PersonaText, RoleQuickPrompt, RoleTaskExample } from './roles.js'

/** 内容文件的格式版本。读不懂的大版本整份不收。 */
export const ROLE_CONTENT_SCHEMA = 'agentsws.role-content/1' as const

/**
 * 职责里算「内容」的字段（白名单）。其余字段一律是骨架：
 * `id` `version` `domain` `scopes` `connectors` `actions` `automation` `thresholds` `skills`
 * `home_blocks` `notifications` `handover` `requires` `browser_scope` `browser_extension`
 * `web_tools` `mode` `status`，以及 `grounding` 每一条的 `tool` / `prefetch`。
 */
export const ROLE_CONTENT_FIELDS = [
  'name',
  'description',
  'persona',
  'quick_prompts',
  'task_examples',
  'grounding',
] as const

/** `grounding` 里每一条能被内容层改的那几格（`name` 是对齐用的键，不是改的东西）。 */
export const ROLE_GROUNDING_CONTENT_FIELDS = ['name', 'intent_terms', 'cue_terms'] as const

/** 岗位里算「内容」的字段：名字、角色定位、挂哪几条职责与默认勾哪几条（只是组合，不改权限）。 */
export const POSITION_CONTENT_FIELDS = ['name', 'persona', 'roles'] as const

export type RoleContentField = (typeof ROLE_CONTENT_FIELDS)[number]
export type PositionContentField = (typeof POSITION_CONTENT_FIELDS)[number]

/**
 * 一条意图规则的内容那一半：按 `name` 对齐到骨架里同名的那一条，只换两张词表。
 * 骨架里没有这个 `name` → 整份拒收（内容层不能凭空多出一条要调工具的规则）。
 */
export interface RoleGroundingContent {
  name: string
  intent_terms?: string[]
  cue_terms?: string[]
}

/** 职责的内容层。每一格都可选：没写的那一格照基础版。写了的那一格**整格替换**（按条合并是 WP406 的事）。 */
export interface RoleContent {
  name?: { zh: string; en: string }
  description?: string
  persona?: PersonaText
  quick_prompts?: RoleQuickPrompt[]
  task_examples?: RoleTaskExample[]
  grounding?: RoleGroundingContent[]
}

/** 岗位的内容层。 */
export interface PositionContent {
  name?: { zh: string; en: string }
  persona?: PersonaText
  roles?: { role: RoleId; default: boolean }[]
}

/** 一份职责内容文件（`scripts/extract-role-content.mjs` 抽出来的、WP407 内容仓里放的就是这个）。 */
export interface RoleContentFile {
  schema: typeof ROLE_CONTENT_SCHEMA
  kind: 'role'
  id: RoleId
  content: RoleContent
}

/** 一份岗位内容文件。 */
export interface PositionContentFile {
  schema: typeof ROLE_CONTENT_SCHEMA
  kind: 'position'
  id: string
  content: PositionContent
}

/* ── 规则表（docs/107 §3「规则表要先外置」）──────────────────────────────── */

/**
 * 外置成数据文件的一张规则表里的一行：**每一行都有稳定 id**——冻结那一刻按原文定一次、存进数据，
 * 之后改字不改 id（「你删过的那条不再加回来」靠它）。
 */
export interface ContentTableRow {
  id: string
}

/**
 * 一张外置的规则表（`*.content.json`）。`table` 是全仓唯一的表名（`seo.claim_rules` …），
 * 按品牌覆盖时拿它对齐。判法代码留在原处，只从读取口拿表（`readContentTable`，在 `@agentsws/core`）。
 */
export interface ContentTableFile<Row extends ContentTableRow = ContentTableRow> {
  $comment?: string | string[]
  table: string
  rows: Row[]
}
