/**
 * Extracted from KefuAgent `src/lib/support/knowledge/provenance.ts`
 * （溯源等级派生、时效分层、prompt 渲染与条款），rewritten for agentsws（48 §4 #6）。
 *
 * **一条铁律**：`unverified` 不阻断使用。出处不明只影响**排序**与 prompt 里怎么说，
 * 任何"因为缺出处就不检索 / 不注入 / 下架"的实现都是违约——用户手打进去的那条
 * 「我们周末不发货」没有出处，但它是真的，而且往往是最要紧的那条。
 * `quarantined` 是唯一真正拦截的状态，而且只能由人显式产生。
 */
import type {
  FactCard,
  Iso8601,
  KnowledgeProvenanceGrade,
  KnowledgeVerificationState,
} from '@agentsws/contracts'

/** source_url 渲染上限。 */
export const PROMPT_SOURCE_URL_MAX_CHARS = 120
/** 「未记录」——`last_verified_at` 为空时 prompt 里如实这么写。 */
export const LAST_VERIFIED_UNKNOWN = '未记录'

/**
 * 溯源等级是**读取时派生值，不占一格**：
 * - 有 `source_content_hash`（这条卡是从一个登记过的源派生的，内容变了追得到）→ `tracked`
 * - 出处里有文档 / 网页 / 邮件的 ref（有出处，但逐页追不了）→ `cited`
 * - 只有人说的 / 模型推的 → `unverified`
 */
export function resolveProvenanceGrade(
  card: Pick<FactCard, 'provenance' | 'source_content_hash'>,
): KnowledgeProvenanceGrade {
  if (card.source_content_hash !== undefined && card.source_content_hash !== '') return 'tracked'
  const cited = card.provenance.some(
    (p) =>
      (p.source === 'document' || p.source === 'web' || p.source === 'email') &&
      p.ref.trim() !== '',
  )
  return cited ? 'cited' : 'unverified'
}

/** 缺省等价于 `fresh`——WP56 之前写进去的卡一张都不用改。 */
export const verificationOf = (
  card: Pick<FactCard, 'verification_state'>,
): KnowledgeVerificationState => card.verification_state ?? 'fresh'

export interface VerificationRankInput {
  verification_state?: KnowledgeVerificationState
  provenance_grade: KnowledgeProvenanceGrade
}

/**
 * 层号越小越优先；`quarantined` 返回 `null` = 调用方**必须**排除。
 *
 * 分层顺序（冻结）：`tracked+fresh`(0) > `cited+fresh`(1) > `unverified+fresh`(2) >
 * 任意 `stale`(3)。
 */
export function verificationTierRank(x: VerificationRankInput): number | null {
  const state = x.verification_state ?? 'fresh'
  if (state === 'quarantined') return null
  if (state === 'stale') return 3
  if (x.provenance_grade === 'tracked') return 0
  if (x.provenance_grade === 'cited') return 1
  return 2
}

/**
 * 分层稳定排序，**层内保序**（context 档按更新时间倒序、lexical 档按既有打分，
 * 分层只作为主键叠在上面）。`quarantined` 被排除。
 *
 * 降权为什么就够用：装箱函数按给定顺序装预算、超了就截断——库装得下时分层只影响
 * 顺序；装不下时 `stale` 与 `unverified` 自动最先被挤出去。
 */
export function rankByVerification<T extends VerificationRankInput>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index, tier: verificationTierRank(item) }))
    .filter((e): e is { item: T; index: number; tier: number } => e.tier !== null)
    .sort((a, b) => (a.tier === b.tier ? a.index - b.index : a.tier - b.tier))
    .map((e) => e.item)
}

/* ------------------------------------------------------------------ */
/* prompt 渲染                                                          */
/* ------------------------------------------------------------------ */

export interface ProvenanceForPrompt {
  source_url: string | null
  /** `YYYY-MM-DD` 或 `未记录`。**绝不拿 `created_at` 顶替**。 */
  last_verified_at: string
  verification: 'fresh' | 'stale'
  provenance: KnowledgeProvenanceGrade
}

const toDateOnly = (value: Iso8601 | undefined): string | null => {
  if (value === undefined || value === '') return null
  const t = Date.parse(value)
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10)
}

/**
 * 每条知识追加的四个溯源字段（形态冻结；邮件草稿与聊天回答两处共用这一个函数，
 * 不许各自映射一遍——两处各写一遍就会只改一边）。
 *
 * `last_verified_at` 为空时写 `未记录`：**它是"没人核实过"，不是"今天核实的"**。
 * 拿创建日期冒充核实日期，等于把"我们从没查过"写成"我们刚查过"。
 */
export function buildProvenanceForPrompt(card: FactCard): ProvenanceForPrompt {
  const first = card.provenance.find((p) => p.source === 'web' || p.source === 'document')
  let url = first?.ref.trim() ?? null
  if (url !== null && url.length > PROMPT_SOURCE_URL_MAX_CHARS)
    url = `${url.slice(0, PROMPT_SOURCE_URL_MAX_CHARS - 1)}…`
  const state = verificationOf(card)
  return {
    source_url: url === '' ? null : url,
    last_verified_at: toDateOnly(card.last_verified_at) ?? LAST_VERIFIED_UNKNOWN,
    verification: state === 'stale' ? 'stale' : 'fresh',
    provenance: resolveProvenanceGrade(card),
  }
}

/** 提示词条款（两处 prompt 组装一字不差地共用这一份）。 */
export const PROVENANCE_PROMPT_CLAUSES: readonly string[] = [
  '每条知识带 source_url（出处）与 last_verified_at（最后核实日期）：涉及退款 / 退货天数、保修月数、运费承担、赔偿上限、发货时效这类数值时，你引用的是该出处在 last_verified_at 那天的口径。',
  'last_verified_at 写着「未记录」的，就是**没人核实过**——不要说成"最近核实过"，也不要拿知识的创建日期当核实日期。',
  'provenance="unverified" 的条目出处不明：可以用来做一般性说明，但不得作为数值 / 期限 / 金额承诺的依据；客户问的正好是这类数值而手上只有 unverified 的条目时，转人工。',
  'verification="stale" 表示源页已变更、还没人复核：不得作为退款 / 保修 / 赔偿口径的唯一依据；有 fresh 的以 fresh 为准；只有 stale 可依据时转人工。',
  '知识内部优先级：商户已确认的业务边界 > tracked+fresh > cited+fresh > unverified+fresh > stale。',
  'source_url 是给你和运营看的溯源信息，不要写进对客回复，也不要据它推断页面上没写的内容。',
]

/* ------------------------------------------------------------------ */
/* 承诺类：永不自动激活                                                 */
/* ------------------------------------------------------------------ */

/**
 * 承诺类来源文件名（知识包 v1 的三个文件键；我们自己的 markdown 也认这几个词）。
 *
 * 判定按**来源文件名或层**，不按正文里写了什么——正文是被审对象，不能让它自己
 * 决定要不要被审。
 */
export const COMMITMENT_SOURCE_KEYS: readonly string[] = [
  '03-pricing-and-billing',
  '08-policies',
  '09-boundaries',
  'pricing',
  'policies',
  'policy',
  'boundaries',
  'terms',
]

/**
 * 这条知识是不是**承诺类**（定价 / 政策 / 边界）。
 *
 * 承诺类**永不自动激活**：它进来只能是 `proposed`，激活得有人点头（19 §2）。
 * 理由很直白——AI 把"退款 30 天"自动发布成生效口径，错的那一条会被逐字念给客户听，
 * 而客户会照着它要钱。
 */
export function isCommitmentCard(card: {
  layer: FactCard['layer']
  provenance: readonly { ref: string }[]
  subject?: { key: string }
}): boolean {
  if (card.layer === 'policy') return true
  const refs = [
    ...card.provenance.map((p) => p.ref.toLowerCase()),
    (card.subject?.key ?? '').toLowerCase(),
  ]
  return refs.some((ref) => COMMITMENT_SOURCE_KEYS.some((key) => ref.includes(key)))
}
