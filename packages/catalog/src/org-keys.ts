/**
 * 45 H2 / H4：三类组织对象的**唯一键**与相似度（品牌 / 产品线 / 店铺范围）。
 *
 * 为什么放在 `@agentsws/catalog` 而不是 `@agentsws/roles`：40 §2 的"建之前先查"
 * 本来就归这个包，五个入口的 `guardSimilar` 也在这儿。45 H4 把入口从五个加到八个，
 * 八个入口一处判定，人只需要在一个地方读懂"系统凭什么说这两条是一回事"。
 * 这个包本来就依赖 `@agentsws/roles`（拿 `RangeGroup` / `ProductLine` 的形状），
 * 反过来让 roles 依赖 catalog 会把词袋与 SQLite 目录库拖进制度层。
 *
 * 三条纪律：
 *
 * 1. **纯函数**：不查库、不认 id 前缀、不认工作区，调用方把两个对象喂进来。
 * 2. **唯一键说得出口**：`same` 是"这两条按定义就是同一个东西"，不是"分数够高"。
 *    没有唯一键的那一格（店铺范围的"相似"）就**不给相似**——宁可当两条，
 *    也不要让人去判两个域名像不像。
 * 3. **相似一律给人选**（45 §4）：这里只回结论与理由，合不合是卡片上按的。
 */
import type {
  JoinPlatform,
  ProductLine,
  ProductLineRule,
  RangeGroup,
  RangeRef,
} from '@agentsws/contracts'
import { parseMarketId } from '@agentsws/contracts'

/** 45 H4 新增的三个查重入口（与 {@link CatalogKind} 的五个并列，凑成八个）。 */
export type OrgObjectKind = 'range_group' | 'product_line' | 'store_range'

/** 一次对照的结论。`none` = 两条不相干，界面上根本不提。 */
export interface OrgMatch {
  verdict: 'same' | 'similar' | 'none'
  /** 0..1，四位小数（`same` 恒为 1）。 */
  similarity: number
  /** 人话理由，界面直接显示。 */
  reasons: string[]
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000
const pct = (n: number): string => `${Math.round(n * 100)}%`
const NONE: OrgMatch = { verdict: 'none', similarity: 0, reasons: [] }

/* ── 名字归一化（品牌的唯一键）──────────────────────────────────────── */

/** 全角 ASCII（Ａ-ｚ、！-～）与全角空格 → 半角。 */
function toHalfWidth(raw: string): string {
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - 0xfee0)
    else if (code === 0x3000) out += ' '
    else out += ch
  }
  return out
}

/** 常见的"这不是名字的一部分"的后缀：品牌乙品牌 = 品牌乙。 */
const NAME_SUFFIXES: readonly string[] = ['品牌', 'brand', '牌子']

/**
 * 品牌名归一化：**全半角 → 小写 → 去掉所有空白与连接号 → 去掉常见后缀**。
 *
 * 归一化后相同 = 唯一键相同 = `same`。刻意不做模糊拼写与音近：
 * 「品牌乙」与「品牌B」归一化后仍然不同，那是**相似**该管的事（靠成员重合），
 * 不该由名字这把钥匙偷偷放行。
 */
export function normalizeName(raw: string): string {
  let s = toHalfWidth(raw).toLowerCase()
  s = s.replace(/[\s\-_·．.]+/gu, '')
  // 后缀可能叠着写（"甲品牌牌子"），剥到不再变为止
  let changed = true
  while (changed) {
    changed = false
    for (const suffix of NAME_SUFFIXES) {
      if (s.length > suffix.length && s.endsWith(suffix)) {
        s = s.slice(0, -suffix.length)
        changed = true
      }
    }
  }
  return s
}

/** 品牌的唯一键。 */
export const rangeGroupKey = (name: string): string => `brand:${normalizeName(name)}`

/* ── 店铺 / 平台账号范围的唯一键 ───────────────────────────────────── */

/**
 * Shopify 的店：**`myshopify` 域名，小写、去协议、去尾斜杠、去 `www.`、去路径与查询**。
 *
 * 只有 handle（没有点）时补成 `<handle>.myshopify.com`——同一家店在向导里可能
 * 一边填了完整域名、另一边填了后台显示的 handle，那是同一家店。
 */
export function normalizeShopifyDomain(raw: string): string {
  let s = raw.trim().toLowerCase()
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//u, '')
  s = s.replace(/^www\./u, '')
  const cut = s.search(/[/?#]/u)
  if (cut >= 0) s = s.slice(0, cut)
  s = s.replace(/\/+$/u, '')
  if (s !== '' && !s.includes('.')) s = `${s}.myshopify.com`
  return s
}

/**
 * 亚马逊：**`卖家id:站点`**（44 G4 的 `market` id 约定就是这个形状）。
 *
 * 两半各自去空白、大写。只给了账号没给站点时站点留空（`A1B2C3:`），
 * 于是"整个账号"与"账号下的某个站"不会被当成同一条。
 */
export function normalizeAmazonId(raw: string): string {
  const parsed = parseMarketId(raw.trim())
  if (parsed !== undefined)
    return `${parsed.account.replace(/\s+/gu, '').toUpperCase()}:${parsed.site.replace(/\s+/gu, '').toUpperCase()}`
  return `${raw.trim().replace(/\s+/gu, '').toUpperCase()}:`
}

/** 认不出平台时的兜底：去空白、小写，原样当键。 */
const normalizeOther = (raw: string): string => raw.trim().replace(/\s+/gu, '').toLowerCase()

export function normalizeExternalId(platform: JoinPlatform, raw: string): string {
  if (platform === 'shopify') return normalizeShopifyDomain(raw)
  if (platform === 'amazon') return normalizeAmazonId(raw)
  return normalizeOther(raw)
}

/**
 * 一条范围看着像哪个平台。
 *
 * `market` 与 `account` 按 44 G4 的约定归亚马逊（今天只有它有"账号 ⊃ 市场"这一层）；
 * `store` 里带 `myshopify` 或点号的当 Shopify；其余 `other`。
 * 判错了的代价是**当成两条**（不会错合），所以这里宁可保守。
 */
export function platformOfRange(range: RangeRef, hint?: JoinPlatform): JoinPlatform {
  if (hint !== undefined) return hint
  if (range.kind === 'market' || range.kind === 'account') return 'amazon'
  if (range.kind === 'store') return range.id.includes('.') ? 'shopify' : 'other'
  return 'other'
}

/** 店铺 / 平台账号范围的唯一键：**平台 + 归一化 id**。 */
export function storeRangeKey(input: { platform: JoinPlatform; external_id: string }): string {
  return `store:${input.platform}:${normalizeExternalId(input.platform, input.external_id)}`
}

/* ── 产品线的唯一键 ───────────────────────────────────────────────── */

/** 判据摊平成一组 `字段=值`——集合相同 = 同一条产品线。 */
export function ruleCriteria(rule: ProductLineRule): string[] {
  const out: string[] = []
  const push = (field: string, values: readonly string[] | undefined): void => {
    for (const v of values ?? []) {
      const key = `${field}=${v.trim().toLowerCase()}`
      if (v.trim() !== '' && !out.includes(key)) out.push(key)
    }
  }
  if (rule.platform === 'manual') push('product_id', rule.product_ids)
  else if (rule.platform === 'amazon') {
    push('asin', rule.asins)
    push('sku_prefix', rule.sku_prefixes)
    push('brand', rule.brand === undefined ? undefined : [rule.brand])
  } else {
    push('collection_id', rule.collection_ids)
    push('tag', rule.tags)
    push('vendor', rule.vendors)
    push('product_type', rule.product_types)
  }
  return out.sort()
}

/** 产品线的唯一键：**父范围 + 判据平台 + 判据集合**。 */
export function productLineKey(line: { parent: RangeRef; rule: ProductLineRule }): string {
  return `line:${line.parent.kind}:${line.parent.id}|${line.rule.platform}|${ruleCriteria(line.rule).join(',')}`
}

/* ── 三张对照表 ───────────────────────────────────────────────────── */

const rangeKeyOf = (r: RangeRef): string => `${r.kind}:${r.id}`

/** 两组范围的重合度：交集 ÷ **较小那一边**（不是并集）。 */
export function memberOverlap(a: readonly RangeRef[], b: readonly RangeRef[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const left = new Set(a.map(rangeKeyOf))
  const right = new Set(b.map(rangeKeyOf))
  let shared = 0
  for (const k of left) if (right.has(k)) shared += 1
  return round4(shared / Math.min(left.size, right.size))
}

/** 成员重合到这个比例就算"像是同一个品牌"（45 H2 表里写死的 50%）。 */
export const MEMBER_OVERLAP_SIMILAR = 0.5

/**
 * 品牌对照：**名字归一化相同 = `same`；名字不同但成员重合 ≥ 50% = `similar`**。
 *
 * 45 H2 的表把这两条写成"或"，但它们的结论不一样：名字对上是唯一键（能自动合并
 * 成员取并集），成员大半重合只是像（"是同一个品牌，用哪个名字"要人来定）。
 */
export function compareRangeGroups(
  a: { name: string; members: readonly RangeRef[] },
  b: { name: string; members: readonly RangeRef[] },
): OrgMatch {
  if (rangeGroupKey(a.name) === rangeGroupKey(b.name))
    return {
      verdict: 'same',
      similarity: 1,
      reasons: [`名字归一化后一样（${normalizeName(a.name)}）`],
    }
  const overlap = memberOverlap(a.members, b.members)
  if (overlap >= MEMBER_OVERLAP_SIMILAR) {
    const left = new Set(a.members.map(rangeKeyOf))
    const shared = b.members.filter((m) => left.has(rangeKeyOf(m))).map((m) => m.id)
    return {
      verdict: 'similar',
      similarity: overlap,
      reasons: [
        `名字不一样（「${a.name}」/「${b.name}」），但成员重合 ${pct(overlap)}（${shared.join('、')}）`,
      ],
    }
  }
  return NONE
}

/**
 * 产品线对照：**父范围相同 + 判据平台相同**是道门，过不了就是两条不相干的线。
 *
 * 门里面：判据集合相同 = `same`；有重叠但不相等 = `similar`（"合并取并集 /
 * 保留两条 / 以公司为准"）；毫无重叠 = `none`（同一家店里两条互不相干的线）。
 */
export function compareProductLines(
  a: Pick<ProductLine, 'parent' | 'rule'>,
  b: Pick<ProductLine, 'parent' | 'rule'>,
): OrgMatch {
  if (rangeKeyOf(a.parent) !== rangeKeyOf(b.parent)) return NONE
  if (a.rule.platform !== b.rule.platform) return NONE
  const ca = ruleCriteria(a.rule)
  const cb = ruleCriteria(b.rule)
  if (ca.length === 0 && cb.length === 0)
    return { verdict: 'same', similarity: 1, reasons: ['父范围与判据都一样（都还没填判据）'] }
  if (ca.length === cb.length && ca.every((x, i) => x === cb[i]))
    return {
      verdict: 'same',
      similarity: 1,
      reasons: [`挂在同一个范围（${a.parent.id}）、判据一模一样（${ca.join('、')}）`],
    }
  const shared = ca.filter((x) => cb.includes(x))
  if (shared.length === 0) return NONE
  const overlap = round4(shared.length / Math.min(ca.length, cb.length))
  return {
    verdict: 'similar',
    similarity: overlap,
    reasons: [
      `挂在同一个范围（${a.parent.id}）、判据有重叠但不相等（都有 ${shared.join('、')}，重合 ${pct(overlap)}）`,
    ],
  }
}

/**
 * 店铺 / 平台账号范围对照：**只有 `same` 与 `none`**。
 *
 * 45 H2 的表里这一格的"相似"是一横杠——域名与卖家 id 是身份证，不是名字；
 * 让人去判两个域名像不像只会判错。
 *
 * 一条例外：**有一边的平台是 `other`（没认出来）时，按原样 id 比**。
 * 公司这边的店铺范围是从岗位与品牌成员里**推**出来的（没有一张店铺表），
 * 推不出平台的一律 `other`；导入的包却可能自报 `shopify`。同一个 `store_a`
 * 因此会算出两把不同的键——那不是两家店，是我们对同一家店知道得多少不一样。
 */
export function compareStoreRanges(
  a: { platform: JoinPlatform; external_id: string },
  b: { platform: JoinPlatform; external_id: string },
): OrgMatch {
  const known = a.platform === b.platform
  const ka = storeRangeKey(a)
  const kb = storeRangeKey(b)
  if (known) {
    if (ka !== kb) return NONE
    return {
      verdict: 'same',
      similarity: 1,
      reasons: [
        `同一个${a.platform === 'amazon' ? '卖家账号 / 站点' : '店铺域名'}（${ka.split(':').slice(2).join(':')}）`,
      ],
    }
  }
  if (a.platform !== 'other' && b.platform !== 'other') return NONE
  if (normalizeOther(a.external_id) !== normalizeOther(b.external_id)) return NONE
  return {
    verdict: 'same',
    similarity: 1,
    reasons: [`同一个店铺 / 账号 id（${normalizeOther(a.external_id)}；有一边没认出是哪个平台）`],
  }
}

/* ── 45 H4：建之前先查（查重入口从五个变八个）───────────────────────── */

/**
 * 一条待判定的组织对象。三类共用一个形状，于是"建之前查"与"建之后扫"用的是
 * 同一把尺子——判据只写一遍，两处的行为不可能漂移。
 */
export type OrgCandidate =
  | { kind: 'range_group'; name: string; members: readonly RangeRef[] }
  | { kind: 'product_line'; name: string; parent: RangeRef; rule: ProductLineRule }
  | { kind: 'store_range'; name: string; platform: JoinPlatform; external_id: string }

/** 库里已经有的一条（比 {@link OrgCandidate} 多出"是谁的、几个岗位挂着"）。 */
export type OrgExisting = OrgCandidate & {
  id: string
  /** 谁建的（没有就是老数据 / 系统种的）。 */
  created_by?: string
  /** 几个岗位挂着它。 */
  holders?: number
}

/** 唯一键：同一把键 = 同一个东西，只允许存在一份（45 H4 第一句）。 */
export function orgUniqueKey(candidate: OrgCandidate): string {
  if (candidate.kind === 'range_group') return rangeGroupKey(candidate.name)
  if (candidate.kind === 'product_line') return productLineKey(candidate)
  return storeRangeKey(candidate)
}

/** 两条**同类**对象对照（不同类一律 `none`——kind 是道门，与 40 §2.2 一致）。 */
export function matchOrgObjects(a: OrgCandidate, b: OrgCandidate): OrgMatch {
  if (a.kind !== b.kind) return NONE
  if (a.kind === 'range_group' && b.kind === 'range_group') return compareRangeGroups(a, b)
  if (a.kind === 'product_line' && b.kind === 'product_line') return compareProductLines(a, b)
  if (a.kind === 'store_range' && b.kind === 'store_range') return compareStoreRanges(a, b)
  return NONE
}

/** 查重命中的一条。 */
export interface OrgSimilarHit {
  id: string
  kind: OrgObjectKind
  name: string
  verdict: 'same' | 'similar'
  similarity: number
  reasons: string[]
  created_by?: string
  holders: number
}

/**
 * 建之前先查（45 H4「建之前」那一半）。
 *
 * 排序：`same` 永远排在 `similar` 前面，同一档按相似度降序、再按名字——
 * 同样的输入永远出同样的一张卡，界面上第一条就是"最该直接用的那个"。
 * `exclude_id` 是改一条已有对象时把它自己排掉（不然它永远和自己一模一样）。
 */
export function findOrgSimilar(
  candidate: OrgCandidate,
  existing: readonly OrgExisting[],
  options: { exclude_id?: string; limit?: number } = {},
): OrgSimilarHit[] {
  const hits: OrgSimilarHit[] = []
  for (const other of existing) {
    if (other.id === options.exclude_id) continue
    const match = matchOrgObjects(candidate, other)
    if (match.verdict === 'none') continue
    hits.push({
      id: other.id,
      kind: other.kind,
      name: other.name,
      verdict: match.verdict,
      similarity: match.similarity,
      reasons: match.reasons,
      ...(other.created_by === undefined ? {} : { created_by: other.created_by }),
      holders: other.holders ?? 0,
    })
  }
  hits.sort(
    (a, b) =>
      (a.verdict === b.verdict ? 0 : a.verdict === 'same' ? -1 : 1) ||
      b.similarity - a.similarity ||
      a.name.localeCompare(b.name),
  )
  return options.limit === undefined ? hits : hits.slice(0, options.limit)
}

/**
 * 建之后扫（45 H4「建之后」那一半，夜间任务用）：**两两**比，每对只出一次。
 *
 * 顺序稳定（按对里两条 id 排过序再按 kind / key 排），于是同一对每晚算出来的
 * 去重键都一样——出过卡的第二天不会再出一张。
 */
export function findOrgDuplicatePairs(
  existing: readonly OrgExisting[],
  options: { limit?: number } = {},
): {
  kind: OrgObjectKind
  unique_key: string
  a: OrgExisting
  b: OrgExisting
  verdict: 'same' | 'similar'
  similarity: number
  reasons: string[]
}[] {
  const out: {
    kind: OrgObjectKind
    unique_key: string
    a: OrgExisting
    b: OrgExisting
    verdict: 'same' | 'similar'
    similarity: number
    reasons: string[]
  }[] = []
  for (let i = 0; i < existing.length; i += 1) {
    for (let j = i + 1; j < existing.length; j += 1) {
      const left = existing[i]
      const right = existing[j]
      if (left === undefined || right === undefined) continue
      const match = matchOrgObjects(left, right)
      if (match.verdict === 'none') continue
      // 对里两条按 id 排定，谁先扫到都是同一对
      const [a, b] = left.id <= right.id ? [left, right] : [right, left]
      out.push({
        kind: left.kind,
        unique_key: orgUniqueKey(a),
        a,
        b,
        verdict: match.verdict,
        similarity: match.similarity,
        reasons: match.reasons,
      })
    }
  }
  out.sort(
    (x, y) =>
      x.kind.localeCompare(y.kind) ||
      (x.verdict === y.verdict ? 0 : x.verdict === 'same' ? -1 : 1) ||
      y.similarity - x.similarity ||
      `${x.a.id}|${x.b.id}`.localeCompare(`${y.a.id}|${y.b.id}`),
  )
  return options.limit === undefined ? out : out.slice(0, options.limit)
}
