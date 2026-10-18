/**
 * WP406（私有 docs/107 §4 / §5 / §15，Luoye 10-19 定）：**用户端收官方岗位更新**——每周一张「岗位更新」卡、
 * 第三栏挑着看、三栏对照、整批 / 单项退回、岗位三档设置、公司模式谁能点、没订阅时那一行小字。
 *
 * 底子全照 docs/90（`content-updates.ts`）：签名、验哈希、按段三方合并、保留上一版一份、退回。
 * 来源只认「官方订阅」（`content-official.ts`，令牌动作集 `content`）；验签只认
 * `OFFICIAL_CONTENT_SIGNING_PUBLIC_KEYS`。
 *
 * 分寸（docs/107 §5.2）：
 * - **每个岗位每周最多一张汇总卡**；一周内后来的条目并进还没处理的那张，不另出；标「急」的单出一张；
 * - 用户没开的岗位不出；没订阅不出卡（只在岗位设定里一行小字，关掉 30 天不提）；
 * - 更新只换最底下那一层；你改的、AI 学的全在上面，**原样不动**。和你改过的同一段撞了才问。
 */
import type { Iso8601, PersonId, WorkspaceId } from './common.js'
import type { ContentItemKind, LocalizedText } from './content-updates.js'

/** 卡的种类（`ApprovalKind` 里那一格）。 */
export const CONTENT_DIGEST_CARD_KIND = 'content_update_digest' as const

/** 卡上那三个按钮里由服务端接住的两个（「挑着看」只开第三栏，不定这张卡）。 */
export const CONTENT_DIGEST_OPTIONS = ['apply_all', 'skip'] as const
export type ContentDigestOption = (typeof CONTENT_DIGEST_OPTIONS)[number]

/** 订阅状态本机记几天：过期只暂停查新，已有内容不动（docs/107 §7）。 */
export const OFFICIAL_SUBSCRIPTION_CACHE_DAYS = 7
/** 没订阅那一行小字关掉之后多少天不再提（与 docs/105 推荐的分寸一致）。 */
export const CONTENT_NUDGE_QUIET_DAYS = 30
/** 第三栏「退回」最多留几批（老的滚掉；每一项自己的上一版照 docs/90 另留一份）。 */
export const CONTENT_BATCH_HISTORY_MAX = 20

/**
 * 岗位设置三档（按品牌、按岗位存）：
 * - `ask` 每次问我（默认）；
 * - `auto_clean` 没撞的自动应用（撞了的照样出卡问）；
 * - `off` 这个岗位不再更新（不出卡、不查它的条目；已应用的照旧能用、能退回）。
 */
export const POSITION_UPDATE_POLICIES = ['ask', 'auto_clean', 'off'] as const
export type PositionUpdatePolicy = (typeof POSITION_UPDATE_POLICIES)[number]
export const DEFAULT_POSITION_UPDATE_POLICY: PositionUpdatePolicy = 'ask'

/**
 * 一项和「你的」关系（卡上每项右边那几个字）：
 * - `untouched` 没改过；
 * - `kept` 你改过、和新版不冲突，会保留；
 * - `clash` 撞了（你改过的那一段 / 那一条新版也改了）——「全部应用」时先保留你的、标出来。
 */
export type ContentDigestMine = 'untouched' | 'kept' | 'clash'

/** 卡上的一项。 */
export interface ContentDigestItem {
  /** 清单里的条目 id（`role_content:dtc.store`、`skill:listing-check`…）。 */
  item_id: string
  kind: ContentItemKind
  name: string
  version: string
  /** 现在用的版本（随软件带的或上次应用的；新加的没有）。 */
  from_version?: string
  title: LocalizedText
  /** 一句改了什么（清单里那句）。 */
  summary: LocalizedText
  mine: ContentDigestMine
  /** 新加的（以前没有这一项）。 */
  added?: boolean
  urgent?: boolean
}

/** `content_update_digest` 卡的 payload：「<岗位> · 本周更新 · N 项」。 */
export interface ContentDigestCardPayload {
  form: typeof CONTENT_DIGEST_CARD_KIND
  workspace_id: WorkspaceId
  position_id: string
  position_name: LocalizedText
  /** 这一周（ISO 周，`2026-W42`）：一周一张、跳过的下周带上都按它算。 */
  week: string
  /** 急件单出的那一张。 */
  urgent: boolean
  /** AI 一句建议（品牌默认模型；没模型就没有这一格，卡上不写）。 */
  advice?: string
  items: ContentDigestItem[]
  /** 收下这批时的清单序号。 */
  serial: number
  /** 选项两处都写（卡片投影读 payload.options）。 */
  options?: { id: ContentDigestOption; label: string }[]
}

/* ------------------------------------------------------------------ */
/* 挑着看：一项拆成几段 / 几条                                          */
/* ------------------------------------------------------------------ */

/** 一段 / 一条在新版里怎么变了。 */
export type ContentPartChange = 'added' | 'changed' | 'removed'

/** 撞了时三个选法（`use_ai` = 用 AI 合好的这版，点了才用）。 */
export const CONTENT_CLASH_CHOICES = ['use_new', 'keep_mine', 'use_ai'] as const
export type ContentClashChoice = (typeof CONTENT_CLASH_CHOICES)[number]

/**
 * 一项里的一段（角色定位的一段、技能的一节）或一条（快捷问题、规则表的一行）。
 * `key` 在这一项里唯一（`persona.zh.how`、`quick_prompts.qp-3`、`section.pricing`、`row.claim-12`…）。
 */
export interface ContentPart {
  key: string
  /** 给人看的名字（段的小标题 / 这一条的开头几个字）。 */
  label: string
  change: ContentPartChange
  /** 原来（现在用的底版里这一段 / 这一条）。 */
  before?: string
  /** 新版。 */
  after?: string
  /** 你的（你改过才有）。 */
  mine?: string
  /** 你改过这一段 / 这一条（不管撞没撞）。 */
  edited?: boolean
  /** 撞了：新版也改了你改过的这一段。 */
  clash?: boolean
  /** 撞了的这一段已经选过的（应用后改主意也走同一个口）。 */
  chosen?: ContentClashChoice
  /** 能让 AI 合一版（是一段文字；规则表的一行、快捷问题这种结构化的一条只给「用新版 / 保留我的」）。 */
  mergeable?: boolean
}

/** `GET …/items/:item_id/diff`：这一项按段 / 按条的改动。 */
export interface ContentItemDiffView {
  item_id: string
  kind: ContentItemKind
  title: LocalizedText
  from_version?: string
  to_version: string
  /** 这一项已经应用了（应用后看「撞了先保留你的」那几处也是这一张）。 */
  applied: boolean
  parts: ContentPart[]
}

/** `POST …/apply`：挑着应用（不给 `item_ids` = 这个岗位等着的全部）。 */
export interface ContentApplyInput {
  item_ids?: string[]
  /** 撞了的那几处怎么选（键 `<item_id>#<part key>`；没写的先保留你的）。 */
  choices?: Record<string, ContentClashChoice>
  /** 选了 `use_ai` 的那几处用哪一版（就是 `ai-merge` 回的那一版，人可能又改过）。 */
  ai_texts?: Record<string, string>
}

/** `POST …/ai-merge`：给模型三方原文出一版（只出，不落；点了「用 AI 合好的这版」才用）。 */
export interface ContentAiMergeInput {
  item_id: string
  part_key: string
}

export interface ContentAiMergeResult {
  /** 没接上模型 / 模型没给出来：没有这一格，界面说一句「这会儿合不了」。 */
  text?: string
}

/** `POST …/rollback`：整批退回上一批（不给 `item_id`）或单项退回。 */
export interface ContentRollbackInput {
  item_id?: string
}

/* ------------------------------------------------------------------ */
/* 第三栏「设定 · 岗位更新」那一页                                      */
/* ------------------------------------------------------------------ */

/**
 * 订阅在本机看来的样子：
 * - `active` 订着、能收新的；
 * - `cached` 这会儿问不到云（断网），按本机记着的 7 天内照常；
 * - `paused` 本机记的过了 7 天还问不到——只暂停查新，已有的不动；
 * - `none` 没订阅（或退订到期、欠费停了）；
 * - `unlinked` 这台没关联 Agents 工坊账号；
 * - `reauth` 老令牌缺 `content` 动作集、自动补签也没成：重新登录一次。
 */
export type OfficialSubscriptionState =
  | 'active'
  | 'cached'
  | 'paused'
  | 'none'
  | 'unlinked'
  | 'reauth'

export interface OfficialSubscriptionLocalView {
  state: OfficialSubscriptionState
  /** 每月几积分（云上回的；取不到就不给）。 */
  credits_per_month?: number
  /** 上次问到云的时刻。 */
  checked_at?: Iso8601
  /** 本机记的状态到哪天为止算数（`checked_at` + 7 天）。 */
  valid_until?: Iso8601
  current_cycle_end?: Iso8601
  cancel_at_period_end?: boolean
  /** 一句人话（暂停 / 重新登录 / 欠费时）。 */
  note?: string
}

/** 这个岗位上一项现在的样子（应用过的那几项，「单项退回」用）。 */
export interface ContentAppliedItem {
  item_id: string
  kind: ContentItemKind
  title: LocalizedText
  version: string
  /** 退回去是哪一版（没有就是随软件带的那一版，写 `undefined`）。 */
  previous_version?: string
  applied_at: Iso8601
  /** 应用后还有几处撞了、先保留了你的。 */
  kept_clashes?: number
}

/** 应用过的一批（「整批退回」退的就是最近一批）。 */
export interface ContentAppliedBatch {
  batch_id: string
  applied_at: Iso8601
  by: 'auto' | 'person'
  person_id?: PersonId
  item_ids: string[]
}

/** 没订阅时那一行小字（`OfficialContentSummary` 里这个岗位那一格）。 */
export interface ContentNudgeView {
  count: number
  urgent: boolean
  titles: LocalizedText[]
}

export interface PositionContentUpdatesView {
  position_id: string
  policy: PositionUpdatePolicy
  subscription: OfficialSubscriptionLocalView
  /**
   * 这个人能不能应用 / 退回（公司模式只有品牌负责人与这个岗位的负责人，服务端一处判）。
   * `false` 时界面只说「有更新，等负责人看」。
   */
  can_apply: boolean
  /** 等着的（还没应用、也没被设成不再更新的）几项。 */
  pending: ContentDigestItem[]
  /** 那张卡（有就给，第三栏「挑着看」跟着它）。 */
  card_id?: string
  /** 这周点过「这次跳过」（下周的卡一起带上）。 */
  skipped_this_week?: boolean
  applied: ContentAppliedItem[]
  last_batch?: ContentAppliedBatch
  /** 没订阅、云上本周有更新、也没被关掉 30 天时才有。 */
  nudge?: ContentNudgeView
  /** 上次查新的时刻与结果（出错时一句人话）。 */
  last_checked_at?: Iso8601
  last_error?: string
}

/** ISO 周（周一开始，`2026-W42`）：一周一张卡、跳过的下周带上都按它分。 */
export function isoWeekOf(at: Iso8601 | Date): string {
  const d = new Date(typeof at === 'string' ? Date.parse(at) : at.getTime())
  const day = (d.getUTCDay() + 6) % 7
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3))
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1)
  const week = 1 + Math.floor((thursday.getTime() - yearStart) / (7 * 86_400_000))
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** 撞了的那一处在 `choices` / `ai_texts` 里的键。 */
export const contentChoiceKey = (item_id: string, part_key: string): string =>
  `${item_id}#${part_key}`

/**
 * 公司模式下谁能应用 / 退回官方更新（docs/107 §5.3，C9）：**品牌负责人或这个岗位的负责人**。
 * 个人 / 同事互联模式没有审批流：本人说了算。服务端照它判一处（照 `canEditMemory` 的写法），界面只读结论。
 */
export function canApplyContentUpdates(input: {
  /** 有没有审批流（公司模式）。 */
  company: boolean
  /** 这个人是不是品牌负责人（持有 `common.owner`）。 */
  is_owner: boolean
  person_id: PersonId | string
  /** 这个岗位的负责人（`Position.supervisor_person_id`）。 */
  position_supervisor?: PersonId | string | undefined
}): { ok: boolean; reason?: string } {
  if (!input.company) return { ok: true }
  if (input.is_owner) return { ok: true }
  if (input.position_supervisor !== undefined && input.position_supervisor === input.person_id)
    return { ok: true }
  return { ok: false, reason: '有更新，等负责人看' }
}
