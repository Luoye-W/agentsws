/**
 * 45 H2：Join 向导的**对照**——个人包里的三类对象逐条与公司已有的比，出
 * `same / similar / missing`，凑成一张 `join_mapping` 审批项的 payload。
 *
 * 纯函数：不查库、不建卡、不改任何东西。调用方（`apps/server/src/join.ts`）
 * 把"个人的包"与"公司现在有什么"喂进来，拿回一张表去建卡；批准之后怎么落地
 * 也在那边——这里一个字都不写。
 *
 * 一条纪律：**`similar` 从不自动合**（45 §4）。这里给的 `suggested` 只是界面上
 * 默认勾的那一项，owner 可以逐条改；没人点过的 `similar` 到落地那一步仍然要
 * 按 `chosen` 走，而 `chosen` 只能来自人。
 */
import type {
  JoinConnectionChoice,
  JoinExportBundle,
  JoinMappingPayload,
  JoinObjectComparison,
  JoinObjectKind,
  JoinObjectSide,
  JoinResolution,
  JoinStoreRange,
  JoinVerdict,
  ProductLine,
  ProductLineRule,
  RangeGroup,
  RangeRef,
} from '@agentsws/contracts'
import {
  compareProductLines,
  compareRangeGroups,
  compareStoreRanges,
  type OrgMatch,
  productLineKey,
  rangeGroupKey,
  storeRangeKey,
} from './org-keys.js'

/** 公司那一侧现在有什么（由装配方从 roles store 读出来喂进来）。 */
export interface CompanyOrgSnapshot {
  range_groups: readonly RangeGroup[]
  product_lines: readonly ProductLine[]
  store_ranges: readonly JoinStoreRange[]
}

export interface JoinCompareOptions {
  bundle: JoinExportBundle
  company: CompanyOrgSnapshot
  /** 公司那条有几个岗位挂着（界面上"3 个岗位挂着"）。 */
  holders?: (kind: JoinObjectKind, id: string) => number
  /** 公司里已经连了哪些 service（20 §4.2「目标已有同 service 连接 → 选主」）。 */
  companyServices?: readonly string[]
  /** 这一次 Join 的 id（进卡的去重键）。 */
  join_id: string
  target_workspace_id: string
}

/* ── 人话摘要 ─────────────────────────────────────────────────────── */

const rangeText = (members: readonly RangeRef[]): string =>
  members.length === 0 ? '还没有成员' : members.map((m) => m.id).join('、')

/** 判据说成人话（对照卡上两侧各一行）。 */
export function ruleText(rule: ProductLineRule): string {
  if (rule.platform === 'manual') return `手填 ${rule.product_ids.length} 件商品`
  if (rule.platform === 'amazon') {
    const parts = [
      rule.asins === undefined ? '' : `ASIN ${rule.asins.join('、')}`,
      rule.sku_prefixes === undefined ? '' : `SKU 前缀 ${rule.sku_prefixes.join('、')}`,
      rule.brand === undefined ? '' : `品牌 ${rule.brand}`,
    ].filter((x) => x !== '')
    return parts.length === 0 ? '还没填判据' : parts.join('，')
  }
  const parts = [
    rule.collection_ids === undefined ? '' : `集合 ${rule.collection_ids.join('、')}`,
    rule.tags === undefined ? '' : `标签 ${rule.tags.join('、')}`,
    rule.vendors === undefined ? '' : `供应商 ${rule.vendors.join('、')}`,
    rule.product_types === undefined ? '' : `商品类型 ${rule.product_types.join('、')}`,
  ].filter((x) => x !== '')
  return parts.length === 0 ? '还没填判据' : parts.join('，')
}

function groupSide(g: RangeGroup, holders?: number): JoinObjectSide {
  return {
    id: g.id,
    name: g.name,
    summary: rangeText(g.members),
    members: [...g.members],
    ...(holders === undefined ? {} : { holders }),
  }
}

function lineSide(l: ProductLine, holders?: number): JoinObjectSide {
  return {
    id: l.id,
    name: l.name,
    summary: `挂在 ${l.parent.id}：${ruleText(l.rule)}`,
    parent: { ...l.parent },
    rule: structuredClone(l.rule),
    ...(holders === undefined ? {} : { holders }),
  }
}

function storeSide(s: JoinStoreRange, holders?: number): JoinObjectSide {
  return {
    id: s.range.id,
    name: s.name,
    summary: `${s.platform === 'amazon' ? '亚马逊' : s.platform === 'shopify' ? 'Shopify' : '平台未知'}：${s.external_id}`,
    platform: s.platform,
    ...(holders === undefined ? {} : { holders }),
  }
}

/* ── 建议动作 ─────────────────────────────────────────────────────── */

/**
 * 每种结论给哪些选项（45 H2 表里那三格）。
 *
 * - `same`：**合并**（公司那份成员取并集，个人那份变别名）。给一个"保留两条"
 *   的后路，因为唯一键也有判错的时候（同名的两个品牌）。
 * - `similar`：三个选项，默认"同一个，取并集"——但这是**默认勾**，不是自动执行。
 * - `missing`：在公司新建，或"这条不带进公司"。
 * - 店铺范围没有成员可并，`same` 就是"用公司那条"（个人那条变别名）。
 */
export function optionsFor(kind: JoinObjectKind, verdict: JoinVerdict): JoinResolution[] {
  if (verdict === 'missing') return ['create_in_company', 'skip']
  if (kind === 'store_range') return ['adopt_company', 'keep_both']
  if (verdict === 'same') return ['merge_union', 'keep_both']
  return ['merge_union', 'adopt_company', 'keep_both']
}

export function suggestionFor(kind: JoinObjectKind, verdict: JoinVerdict): JoinResolution {
  const first = optionsFor(kind, verdict)[0]
  return first ?? 'keep_both'
}

function comparison(
  kind: JoinObjectKind,
  unique_key: string,
  mine: JoinObjectSide,
  best: { match: OrgMatch; side: JoinObjectSide } | undefined,
): JoinObjectComparison {
  const verdict: JoinVerdict =
    best === undefined ? 'missing' : best.match.verdict === 'same' ? 'same' : 'similar'
  const base: JoinObjectComparison = {
    kind,
    unique_key,
    verdict,
    mine,
    reasons: best?.match.reasons ?? ['公司里还没有这一条'],
    suggested: suggestionFor(kind, verdict),
    options: optionsFor(kind, verdict),
  }
  if (best === undefined) return base
  return {
    ...base,
    theirs: best.side,
    ...(verdict === 'similar' ? { similarity: best.match.similarity } : {}),
  }
}

/** 一堆候选里挑最像的那条（`same` 永远压过 `similar`）。 */
function pickBest<T>(
  candidates: readonly T[],
  compare: (candidate: T) => OrgMatch,
  side: (candidate: T) => JoinObjectSide,
): { match: OrgMatch; side: JoinObjectSide } | undefined {
  let best: { match: OrgMatch; side: JoinObjectSide } | undefined
  for (const candidate of candidates) {
    const match = compare(candidate)
    if (match.verdict === 'none') continue
    if (best === undefined) {
      best = { match, side: side(candidate) }
      continue
    }
    const better =
      (match.verdict === 'same' && best.match.verdict !== 'same') ||
      (match.verdict === best.match.verdict && match.similarity > best.match.similarity)
    if (better) best = { match, side: side(candidate) }
  }
  return best
}

/**
 * 一整个包的对照。顺序固定（品牌 → 产品线 → 店铺范围，各自按名字），
 * 于是同样的输入永远出同样的一张卡（14 §6 的去重键才算得稳）。
 */
export function compareJoinBundle(options: JoinCompareOptions): JoinMappingPayload {
  const { bundle, company } = options
  const holders = options.holders ?? ((): number => 0)
  const objects: JoinObjectComparison[] = []

  for (const mine of [...bundle.range_groups].sort((a, b) => a.name.localeCompare(b.name))) {
    objects.push(
      comparison(
        'range_group',
        rangeGroupKey(mine.name),
        groupSide(mine),
        pickBest(
          company.range_groups,
          (c) => compareRangeGroups(mine, c),
          (c) => groupSide(c, holders('range_group', c.id)),
        ),
      ),
    )
  }

  for (const mine of [...bundle.product_lines].sort((a, b) => a.name.localeCompare(b.name))) {
    objects.push(
      comparison(
        'product_line',
        productLineKey(mine),
        lineSide(mine),
        pickBest(
          company.product_lines,
          (c) => compareProductLines(mine, c),
          (c) => lineSide(c, holders('product_line', c.id)),
        ),
      ),
    )
  }

  for (const mine of [...bundle.store_ranges].sort((a, b) =>
    a.external_id.localeCompare(b.external_id),
  )) {
    objects.push(
      comparison(
        'store_range',
        storeRangeKey(mine),
        storeSide(mine),
        pickBest(
          company.store_ranges,
          (c) => compareStoreRanges(mine, c),
          (c) => storeSide(c, holders('store_range', c.range.id)),
        ),
      ),
    )
  }

  const services = new Set(options.companyServices ?? [])
  const connections: JoinConnectionChoice[] = bundle.connections.map((c) => ({
    connection_id: c.connection_id,
    service: c.service,
    label: c.label,
    // 45 H2 第三条：凭据**不**自动转移，开关默认关着
    transfer: false,
    ...(services.has(c.service) ? { company_has_same_service: true } : {}),
  }))

  const counts: Record<JoinVerdict, number> = { same: 0, similar: 0, missing: 0 }
  for (const o of objects) counts[o.verdict] += 1

  return {
    join_id: options.join_id,
    source_workspace_id: bundle.workspace_id,
    target_workspace_id: options.target_workspace_id,
    person_id: bundle.person_id,
    objects,
    connections,
    counts,
  }
}

/** 一句话摘要（进审批项的 `summary`，界面上不展开也看得懂）。 */
export function joinSummary(payload: JoinMappingPayload): string {
  const { same, similar, missing } = payload.counts
  const transfer = payload.connections.length
  return `要并进公司的有 ${payload.objects.length} 条：一样 ${same} 条（直接合）、像但不确定 ${similar} 条（要你选）、公司还没有 ${missing} 条（新建）。另有 ${transfer} 条个人连接——**默认不交给公司**，要交的逐条打开开关。`
}
