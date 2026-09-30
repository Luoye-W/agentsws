/**
 * WP209：技能页与知识库页「先分类、再展开」的判定——**纯函数**，页面与第三栏共用一份。
 *
 * 技能：按岗位分组（真源是服务端 `SkillSummary.positions`，职责 yml 反查 + frontmatter），
 * 这里只负责排序、搜索、筛选、按当前岗位 / 职责过滤。
 *
 * 知识：按类型分组（产品事实 / 政策 / 物流与时效 / B2B 事实卡 / 品牌话术 / 其它），
 * 类型从 `subject` 与 `layer` 判；状态（已生效 / 待确认 / 已过期 / 冲突）与来源
 * （上传 / Agent 提议 / 手填）也在这里判。**上传的文档**是另一张表（`KnowledgeSource`），
 * 页面把它们单独成组。
 */
import type { KnowledgeCardRow, SkillSummary } from './api'

type Lang = 'zh' | 'en'

// ── 技能 ────────────────────────────────────────────────────────────────

export const COMMON_GROUP = 'common'

/** 服务端没回 `positions` 时（老服务进程）的顺序兜底：照派工单列的那几个岗位。 */
export const POSITION_ORDER: readonly string[] = [
  'customer-care',
  'kol-marketing',
  'social-media',
  'b2b',
  'ads',
  'site',
  'design',
  'pr',
  'web-ops',
]

export interface SkillGroup {
  id: string
  name: { zh: string; en: string }
  /** 本人在这个岗位下有职责（排前面、默认展开）。 */
  mine: boolean
  skills: SkillSummary[]
}

export function skillLabel(skill: SkillSummary, lang: Lang): string {
  return skill.display_name?.[lang] ?? skill.name
}

export function skillSummaryLine(skill: SkillSummary, lang: Lang): string | undefined {
  return skill.summary?.[lang]
}

/** 这个技能归在几个真岗位下（不算「通用」）；两个以上界面标「共用」。 */
export function sharedAcross(skill: SkillSummary): number {
  return (skill.positions ?? []).filter((p) => p.id !== COMMON_GROUP).length
}

/**
 * 分组：本人的岗位在前（`mine`）、通用其次、其余岗位在后（页面把它们折进「没开的岗位」）。
 * 岗位之间的顺序照服务端回的顺序（岗位模板顺序），认不出的放最后。
 */
export function groupSkills(skills: readonly SkillSummary[]): {
  mine: SkillGroup[]
  common: SkillGroup | undefined
  others: SkillGroup[]
} {
  const groups = new Map<string, SkillGroup>()
  const order: string[] = []
  for (const skill of skills) {
    const refs =
      skill.positions === undefined || skill.positions.length === 0
        ? [{ id: COMMON_GROUP, name: { zh: '通用', en: 'General' }, mine: false }]
        : skill.positions
    for (const ref of refs) {
      let group = groups.get(ref.id)
      if (group === undefined) {
        group = { id: ref.id, name: ref.name, mine: ref.mine, skills: [] }
        groups.set(ref.id, group)
        order.push(ref.id)
      }
      group.mine = group.mine || ref.mine
      group.skills.push(skill)
    }
  }
  const rank = (id: string): number => {
    const i = POSITION_ORDER.indexOf(id)
    return i < 0 ? POSITION_ORDER.length + order.indexOf(id) : i
  }
  const all = [...groups.values()].filter((g) => g.id !== COMMON_GROUP)
  all.sort((a, b) => rank(a.id) - rank(b.id))
  return {
    mine: all.filter((g) => g.mine),
    common: groups.get(COMMON_GROUP),
    others: all.filter((g) => !g.mine),
  }
}

export interface SkillFilters {
  query?: string
  onlyProposals?: boolean
  onlyMine?: boolean
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFKC')
}

/** 搜：名字（id + 中英显示名）、一句话、原描述、段落标题与正文、三层改动里的正文、职责名。 */
export function skillMatches(skill: SkillSummary, query: string): boolean {
  const q = norm(query.trim())
  if (q === '') return true
  const hay = [
    skill.name,
    skill.display_name?.zh,
    skill.display_name?.en,
    skill.summary?.zh,
    skill.summary?.en,
    skill.description,
    ...skill.sections.flatMap((s) => [s.heading, s.body]),
    ...skill.overlays.flatMap((o) => o.ops.flatMap((op) => [op.heading, op.body])),
    ...(skill.roles ?? []).flatMap((r) => [r.name.zh, r.name.en]),
  ]
  return hay.some((h) => h !== undefined && norm(h).includes(q))
}

export function filterSkills(
  skills: readonly SkillSummary[],
  filters: SkillFilters,
): SkillSummary[] {
  return skills.filter(
    (s) =>
      (filters.onlyProposals !== true || s.pending_proposals > 0) &&
      (filters.onlyMine !== true || s.in_use === true) &&
      skillMatches(s, filters.query ?? ''),
  )
}

/**
 * 第三栏「设定 → 技能」：只列当前岗位 / 职责在用的那几个。
 *
 * - 岗位层：`positions` 里有这个岗位，或者它的某条职责挂在这个岗位下（只归了「通用」的那种）；
 * - 职责层：`roles` 里有这条职责。
 *
 * 服务端没回分组那几格（老进程）时一个都判不出来——那就原样全给，别让面板空着。
 */
export function skillsForScope(
  skills: readonly SkillSummary[],
  scope: { tier: 'position' | 'role'; scope_id: string },
): SkillSummary[] {
  const known = skills.some((s) => s.positions !== undefined || s.roles !== undefined)
  if (!known) return [...skills]
  return skills.filter((s) =>
    scope.tier === 'position'
      ? (s.positions ?? []).some((p) => p.id === scope.scope_id) ||
        // 挂在大半岗位上、只归了「通用」的技能（如品牌话术）：这个岗位的职责在用它，就算这个岗位的
        (s.roles ?? []).some((r) => r.position_ids.includes(scope.scope_id))
      : (s.roles ?? []).some((r) => r.role_id === scope.scope_id),
  )
}

// ── 知识 ────────────────────────────────────────────────────────────────

export const KNOWLEDGE_GROUPS = [
  'product',
  'policy',
  'logistics',
  'b2b',
  'brand_voice',
  'uploads',
  'other',
] as const
export type KnowledgeGroupId = (typeof KNOWLEDGE_GROUPS)[number]

export const KNOWLEDGE_STATUSES = ['active', 'pending', 'expired', 'conflict'] as const
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number]

export type KnowledgeOrigin = 'upload' | 'agent' | 'manual'

/** B2B 六类（`packages/b2b-core` 的 `B2B_FACT_CATEGORIES`；工作台不依赖那个包，这里抄 id）。 */
export const B2B_CATEGORIES = [
  'product_lines',
  'pricing_moq',
  'certifications',
  'delivery',
  'sample_policy',
  'after_sales',
] as const

export type PolicyKind = 'returns' | 'shipping' | 'privacy' | 'terms' | 'warranty'

const LOGISTICS =
  /(logistic|carrier|cutoff|cut_off|transit|lead_time|tracking|lost_package|delivery_time|dispatch|handling_time|物流|时效|发货|配送)/
const SHIPPING_FEE = /(shipping|postage|运费)/
const RETURNS = /(return|refund|exchange|\brma\b|退|换)/
const PRIVACY = /(privacy|gdpr|cookie|隐私)/
const TERMS = /(terms|\btos\b|condition|条款)/
const WARRANTY = /(warranty|guarantee|保修|质保)/
const PRODUCT = /(product|\bsku|\bspecs?\b|catalog|\bmodel|price|variant|产品|商品|型号|规格)/
const BRAND_VOICE = /(\btone\b|phrasing|\bvoice\b|brand_voice|话术|口吻)/

function keyOf(card: KnowledgeCardRow): string {
  return norm(`${card.subject.type} ${card.subject.key}`)
}

/** `b2b:pricing_moq` → `pricing_moq`；不是 B2B 事实卡回 undefined。 */
export function b2bCategoryOf(card: KnowledgeCardRow): string | undefined {
  const key = card.subject.key
  if (!key.startsWith('b2b:')) return undefined
  const id = key.slice(4)
  return (B2B_CATEGORIES as readonly string[]).includes(id) ? id : undefined
}

/** 政策卡是哪一份：退换 / 运费 / 隐私 / 条款 / 保修（认不出回 undefined）。 */
export function policyKindOf(card: KnowledgeCardRow): PolicyKind | undefined {
  const k = keyOf(card)
  if (WARRANTY.test(k)) return 'warranty'
  if (RETURNS.test(k)) return 'returns'
  if (PRIVACY.test(k)) return 'privacy'
  if (TERMS.test(k)) return 'terms'
  if (SHIPPING_FEE.test(k)) return 'shipping'
  return undefined
}

/**
 * 一张卡归哪一类。先认最确定的：`b2b:` 前缀 → 话术层 → 物流时效词 → 政策 → 产品；
 * 历史案例（47 J2）与认不出的进「其它」。
 */
export function knowledgeGroupOf(card: KnowledgeCardRow): Exclude<KnowledgeGroupId, 'uploads'> {
  if (card.subject.key.startsWith('b2b:') || card.subject.type === 'b2b_fact') return 'b2b'
  if (card.layer === 'historical_case') return 'other'
  const k = keyOf(card)
  if (card.layer === 'phrasing' || BRAND_VOICE.test(k)) return 'brand_voice'
  if (LOGISTICS.test(k)) return 'logistics'
  if (card.layer === 'policy' || card.subject.type === 'policy' || policyKindOf(card) !== undefined)
    return 'policy'
  if (card.subject.type === 'product' || PRODUCT.test(k)) return 'product'
  return 'other'
}

/**
 * 状态四档，重的压轻的：冲突 > 已过期 > 待确认 > 已生效。
 *
 * - 冲突：卡上记着和别的卡打架（`conflicts`）；
 * - 已过期：退役了、过了 `valid.until`、源页改了还没人复核（`stale`）、被人停用（`quarantined`）；
 * - 待确认：还是提议（`proposed`），人没点头；
 * - 其余：已生效。
 */
export function knowledgeStatusOf(card: KnowledgeCardRow, now: Date = new Date()): KnowledgeStatus {
  if ((card.conflicts ?? []).length > 0) return 'conflict'
  const until = card.valid?.until
  if (
    card.status === 'retired' ||
    (until !== undefined && Date.parse(until) < now.getTime()) ||
    card.verification_state === 'stale' ||
    card.verification_state === 'quarantined'
  )
    return 'expired'
  if (card.status === 'proposed') return 'pending'
  return 'active'
}

/** 来源三档：出处是一份文档 → 上传；Agent 建的 → Agent 提议；其余 → 手填。 */
export function knowledgeOriginOf(card: KnowledgeCardRow): KnowledgeOrigin {
  const p = card.provenance ?? []
  if (p.some((x) => x.source === 'document' || x.ref.startsWith('blob://'))) return 'upload'
  if (card.created_by?.kind === 'agent' || p.some((x) => x.source === 'agent_inference'))
    return 'agent'
  return 'manual'
}

/** 适用范围的键：`brand:b1`；空范围（整个品牌通用）回 `[]`。 */
export function scopeKeysOf(card: KnowledgeCardRow): string[] {
  return (card.scope ?? []).map((s) => `${s.kind}:${s.id}`)
}

/** 所有卡上出现过的范围（下拉里的选项），按出现顺序去重。 */
export function scopeOptions(cards: readonly KnowledgeCardRow[]): { kind: string; id: string }[] {
  const seen = new Map<string, { kind: string; id: string }>()
  for (const c of cards) for (const s of c.scope ?? []) seen.set(`${s.kind}:${s.id}`, s)
  return [...seen.values()]
}

export const SCOPE_ALL = '*'
export const SCOPE_GENERAL = ''

export interface KnowledgeFilters {
  query?: string
  /** `*` = 全部；`''` = 只看通用（没限范围的）；`brand:b1` = 这个范围的（加上通用的）。 */
  scope?: string
  status?: KnowledgeStatus | 'all'
}

export function knowledgeMatches(card: KnowledgeCardRow, query: string): boolean {
  const q = norm(query.trim())
  if (q === '') return true
  return [card.statement, card.subject.key, ...(card.provenance ?? []).map((p) => p.locator)].some(
    (h) => h !== undefined && norm(h).includes(q),
  )
}

export function filterKnowledge(
  cards: readonly KnowledgeCardRow[],
  filters: KnowledgeFilters,
  now: Date = new Date(),
): KnowledgeCardRow[] {
  const scope = filters.scope ?? SCOPE_ALL
  const status = filters.status ?? 'all'
  return cards.filter((c) => {
    if (status !== 'all' && knowledgeStatusOf(c, now) !== status) return false
    if (scope !== SCOPE_ALL) {
      const keys = scopeKeysOf(c)
      // 选了某个范围：那个范围的 + 通用的（通用的在哪个范围下都算数）
      if (scope === SCOPE_GENERAL ? keys.length > 0 : keys.length > 0 && !keys.includes(scope))
        return false
    }
    return knowledgeMatches(c, filters.query ?? '')
  })
}

/** 分组（不含「上传的文档」——那是另一张表）；空组不回。 */
export function groupKnowledge(
  cards: readonly KnowledgeCardRow[],
): { id: Exclude<KnowledgeGroupId, 'uploads'>; cards: KnowledgeCardRow[] }[] {
  const by = new Map<string, KnowledgeCardRow[]>()
  for (const c of cards) {
    const g = knowledgeGroupOf(c)
    by.set(g, [...(by.get(g) ?? []), c])
  }
  return KNOWLEDGE_GROUPS.filter((g) => g !== 'uploads' && by.has(g)).map((g) => ({
    id: g as Exclude<KnowledgeGroupId, 'uploads'>,
    cards: by.get(g) ?? [],
  }))
}

export function countByStatus(
  cards: readonly KnowledgeCardRow[],
  now: Date = new Date(),
): Record<KnowledgeStatus, number> {
  const out: Record<KnowledgeStatus, number> = { active: 0, pending: 0, expired: 0, conflict: 0 }
  for (const c of cards) out[knowledgeStatusOf(c, now)] += 1
  return out
}

/**
 * 第三栏「设定 → 知识」：这个岗位先看哪几类（同一套分组，按岗位挑）。
 * 职责层用它所属岗位的那一份；认不出的岗位给全部。
 */
const POSITION_KNOWLEDGE: Readonly<Record<string, readonly KnowledgeGroupId[]>> = {
  'customer-care': ['policy', 'logistics', 'product', 'brand_voice', 'uploads'],
  b2b: ['b2b', 'product', 'logistics', 'uploads'],
  'kol-marketing': ['brand_voice', 'product', 'uploads'],
  'social-media': ['brand_voice', 'product', 'policy', 'uploads'],
  ads: ['brand_voice', 'product', 'uploads'],
  design: ['brand_voice', 'product', 'uploads'],
  pr: ['brand_voice', 'policy', 'uploads'],
  site: ['product', 'policy', 'logistics', 'uploads'],
  'web-ops': ['product', 'policy', 'logistics', 'brand_voice', 'uploads'],
}

export function knowledgeGroupsForPosition(position_id: string | undefined): KnowledgeGroupId[] {
  const hit = position_id === undefined ? undefined : POSITION_KNOWLEDGE[position_id]
  return hit === undefined ? [...KNOWLEDGE_GROUPS] : [...hit]
}

/**
 * 一条适用范围在屏幕上怎么说（与 `lib/ranges.ts` 的 `rangeText` 同一条规矩：内部 id 不上屏）。
 *
 * - `brand`：id 是工作区 id → 「整个品牌」；
 * - 范围组（店铺组）认得的 id → 组名；
 * - `market`：`账号:站点` → 站点（`amz_na:US` → `US`）；
 * - 其余原样（店铺 / 账号的 id 本来就是用户认得的店名）。
 */
export function scopeLabel(
  ref: { kind: string; id: string },
  groups: readonly { id: string; name: string }[],
  t: (key: string) => string,
): string {
  if (ref.kind === 'brand') return t('range.kind.brand')
  const named = groups.find((g) => g.id === ref.id)?.name
  if (named !== undefined) return named
  if (ref.kind === 'market') {
    const at = ref.id.indexOf(':')
    if (at > 0 && at < ref.id.length - 1) return ref.id.slice(at + 1)
  }
  return ref.id
}

/**
 * 事实卡正文在屏幕上的样子：从文档导进来的常以 `# 标题` 开头——标题单拎出来，
 * 其余并成一行（列表里只看个大概，全文在导出 / 第三栏里看）。
 */
export function statementParts(statement: string): { title?: string; body: string } {
  const lines = statement
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  const first = lines[0] ?? ''
  if (/^#{1,6}\s/.test(first)) {
    return {
      title: first.replace(/^#{1,6}\s+/, ''),
      body: lines.slice(1).join(' ').replace(/\*\*/g, ''),
    }
  }
  return { body: lines.join(' ').replace(/\*\*/g, '') }
}
