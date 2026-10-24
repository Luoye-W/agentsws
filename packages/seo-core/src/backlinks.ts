/**
 * WP450（docs/109 §5.2 #10）：**外链体检**——读云上外链概况与外链行，看来源域名数变化、锚文本过度集中、可疑来源；
 * 竞品有而我们没有的来源站列 Top 10（交公关：站外提及归公关）。
 *
 * 全是规则，数一个不经模型手。阈值是数据（{@link BACKLINK_RULES}），都是**复核用的线**，不是「被惩罚」的判定：
 * 外链库只看得到它爬到的那部分（比真实少），权重和垃圾分都是估算——卡上与面板里照写「估算」，**不写数据从哪来**。
 *
 * 方法借 claude-seo（MIT，github.com/AgriciDaniel/claude-seo @ 4b99de2）`skills/seo-backlinks`：
 * 锚文本分五类与「完全匹配 > 15% 要复核」、单个来源域名占比 > 25%、来源域名季度跌 > 20%、竞品差距按「链了几家竞品」排。
 * 只借方法，代码自己写；不出「拒绝外链」（disavow）文件——那一步要人判断，我们只列可疑来源。
 */
import type {
  BacklinkAnchorKind,
  BacklinkAnchorShare,
  BacklinkGapSite,
  BacklinkIssue,
  BacklinkIssueRule,
  BacklinkRow,
  BacklinkSummary,
} from '@agentsws/contracts'
import { normalizeQuery } from './signals.js'

/** 规则表（数据）：每条一个线、一个严重度。 */
export const BACKLINK_RULES: Record<
  BacklinkIssueRule,
  { high?: number; medium: number; note_zh: string }
> = {
  // 来源域名数比上一次少了多少（%）
  domains_drop: { high: 20, medium: 10, note_zh: '来源域名比上次少了' },
  // 单个非品牌、非网址的锚文本占比（%）
  anchor_concentration: { high: 40, medium: 25, note_zh: '锚文本过度集中在一个词上' },
  // 完全匹配关键词的锚文本合计占比（%）
  exact_anchor_high: { high: 30, medium: 15, note_zh: '完全匹配关键词的锚文本偏多' },
  // 可疑来源的外链占比（%）
  suspicious_sources: { high: 20, medium: 5, note_zh: '有可疑来源' },
  // 整站外链垃圾分（0–100，估算）
  spam_score_high: { high: 60, medium: 30, note_zh: '外链整体垃圾分偏高' },
  // 单个来源域名占全部外链的比例（%）
  single_domain_heavy: { high: 50, medium: 25, note_zh: '外链太集中在一个站上' },
}

/** 一个来源站的垃圾分到这条线算可疑（0–100，估算）。 */
export const SUSPICIOUS_SPAM_SCORE = 60
/** 同一个来源站这么多条链接、且锚文本全是同一个关键词 → 可疑（像买来的）。 */
export const SUSPICIOUS_SAME_ANCHOR_LINKS = 10
/** 竞品差距列几个。 */
export const GAP_TOP = 10

const GENERIC_ANCHORS = new Set([
  'click here',
  'here',
  'learn more',
  'read more',
  'more',
  'website',
  'this',
  'this site',
  'link',
  'source',
  'visit',
  'shop now',
  'hier',
  'mehr',
  'ici',
  '这里',
  '点击这里',
  '链接',
  '官网',
  '了解更多',
])

/** 网址 → 不带 `www.` 的主机名（认不出回原样小写）。 */
export function backlinkDomain(urlOrDomain: string): string {
  const s = urlOrDomain.trim().toLowerCase()
  try {
    return new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, '')
  } catch {
    return s.replace(/^www\./, '').split('/')[0] ?? s
  }
}

/** 锚文本的种类：品牌 / 网址 / 通用（「点这里」）/ 完全匹配关键词 / 其它。 */
export function anchorKind(
  anchor: string | undefined,
  ctx: { brand_terms: readonly string[]; domains: readonly string[]; keywords: readonly string[] },
): BacklinkAnchorKind {
  const a = normalizeQuery(anchor ?? '')
  if (a === '' || /^(https?:\/\/|www\.)/.test(a) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(a))
    return 'url'
  if (ctx.domains.some((d) => d !== '' && a.includes(backlinkDomain(d)))) return 'url'
  if (ctx.brand_terms.some((t) => t.trim() !== '' && a.includes(normalizeQuery(t)))) return 'brand'
  if (GENERIC_ANCHORS.has(a)) return 'generic'
  if (ctx.keywords.some((k) => normalizeQuery(k) === a)) return 'exact'
  return 'other'
}

/** 锚文本分布（按出现次数，前 10）。 */
export function anchorShares(
  rows: readonly BacklinkRow[],
  ctx: { brand_terms: readonly string[]; domains: readonly string[]; keywords: readonly string[] },
): BacklinkAnchorShare[] {
  if (rows.length === 0) return []
  const count = new Map<string, { anchor: string; count: number }>()
  for (const r of rows) {
    const key = normalizeQuery(r.anchor ?? '')
    const cur = count.get(key)
    count.set(key, { anchor: cur?.anchor ?? (r.anchor ?? '').trim(), count: (cur?.count ?? 0) + 1 })
  }
  return [...count.values()]
    .sort((a, b) => b.count - a.count || a.anchor.localeCompare(b.anchor))
    .slice(0, 10)
    .map((x) => ({
      anchor: x.anchor,
      kind: anchorKind(x.anchor, ctx),
      count: x.count,
      share: Math.round((x.count / rows.length) * 1000) / 1000,
    }))
}

/** 可疑来源：来源站垃圾分过线，或同一站一大把链接、锚文本全是同一个关键词。 */
export function suspiciousSources(
  rows: readonly BacklinkRow[],
  ctx: { keywords: readonly string[] },
): { domain: string; why: string }[] {
  const byDomain = new Map<string, BacklinkRow[]>()
  for (const r of rows) {
    const d = backlinkDomain(r.domain_from || r.url_from)
    byDomain.set(d, [...(byDomain.get(d) ?? []), r])
  }
  const out: { domain: string; why: string }[] = []
  for (const [domain, list] of byDomain) {
    const spam = Math.max(...list.map((r) => r.spam_score ?? 0))
    if (spam >= SUSPICIOUS_SPAM_SCORE) {
      out.push({ domain, why: `垃圾分 ${String(spam)}（估算）` })
      continue
    }
    const anchors = new Set(list.map((r) => normalizeQuery(r.anchor ?? '')))
    const only = [...anchors][0]
    if (
      list.length >= SUSPICIOUS_SAME_ANCHOR_LINKS &&
      anchors.size === 1 &&
      only !== undefined &&
      ctx.keywords.some((k) => normalizeQuery(k) === only)
    )
      out.push({
        domain,
        why: `同一个站 ${String(list.length)} 条链接，锚文本全是「${only}」`,
      })
  }
  return out.sort((a, b) => a.domain.localeCompare(b.domain))
}

/**
 * 竞品差距：链了竞品、没链我们的来源站。按链了几家竞品、再按权重排，前 10；可疑的、我们自己与竞品自己的域名不算。
 */
export function backlinkGap(input: {
  ours: readonly BacklinkRow[]
  competitors: ReadonlyMap<string, readonly BacklinkRow[]>
  our_domains: readonly string[]
  top?: number
}): BacklinkGapSite[] {
  const mine = new Set(input.ours.map((r) => backlinkDomain(r.domain_from || r.url_from)))
  const skip = new Set([
    ...input.our_domains.map(backlinkDomain),
    ...[...input.competitors.keys()].map(backlinkDomain),
  ])
  const sites = new Map<string, { competitors: Set<string>; rating?: number; spam: number }>()
  for (const [comp, rows] of input.competitors)
    for (const r of rows) {
      const d = backlinkDomain(r.domain_from || r.url_from)
      if (mine.has(d) || skip.has(d)) continue
      const cur = sites.get(d) ?? { competitors: new Set<string>(), spam: 0 }
      cur.competitors.add(backlinkDomain(comp))
      if (r.domain_rating !== undefined) cur.rating = Math.max(cur.rating ?? 0, r.domain_rating)
      cur.spam = Math.max(cur.spam, r.spam_score ?? 0)
      sites.set(d, cur)
    }
  return [...sites.entries()]
    .filter(([, s]) => s.spam < SUSPICIOUS_SPAM_SCORE)
    .sort(
      ([da, a], [db, b]) =>
        b.competitors.size - a.competitors.size ||
        (b.rating ?? 0) - (a.rating ?? 0) ||
        da.localeCompare(db),
    )
    .slice(0, input.top ?? GAP_TOP)
    .map(([domain, s]) => ({
      domain,
      competitors: [...s.competitors].sort(),
      ...(s.rating === undefined ? {} : { domain_rating: s.rating }),
    }))
}

const pct = (v: number): string => `${String(Math.round(v * 10) / 10)}%`

function level(rule: BacklinkIssueRule, value: number): 'high' | 'medium' | undefined {
  const r = BACKLINK_RULES[rule]
  if (r.high !== undefined && value >= r.high) return 'high'
  if (value >= r.medium) return 'medium'
  return undefined
}

export interface BacklinkAuditInput {
  ours?: BacklinkSummary
  previous?: { referring_domains?: number; backlinks?: number }
  rows: readonly BacklinkRow[]
  competitors: ReadonlyMap<string, readonly BacklinkRow[]>
  brand_terms: readonly string[]
  our_domains: readonly string[]
  /** 我们在乎的词（Search Console 的非品牌词 / 关注词）：认「完全匹配」锚文本。 */
  keywords: readonly string[]
}

export interface BacklinkAuditResult {
  change?: { referring_domains: number; pct?: number }
  anchors: BacklinkAnchorShare[]
  suspicious: { domain: string; why: string }[]
  issues: BacklinkIssue[]
  gap: BacklinkGapSite[]
}

/** 一次外链体检（见文件头）。 */
export function auditBacklinks(input: BacklinkAuditInput): BacklinkAuditResult {
  const ctx = {
    brand_terms: input.brand_terms,
    domains: input.our_domains,
    keywords: input.keywords,
  }
  const issues: BacklinkIssue[] = []
  const push = (rule: BacklinkIssueRule, value: number, text: string): void => {
    const sev = level(rule, value)
    if (sev !== undefined) issues.push({ rule, severity: sev, text })
  }
  let change: BacklinkAuditResult['change']
  const now = input.ours?.referring_domains
  const before = input.previous?.referring_domains
  if (now !== undefined && before !== undefined) {
    const diff = now - before
    change = {
      referring_domains: diff,
      ...(before > 0 ? { pct: Math.round((diff / before) * 1000) / 10 } : {}),
    }
    if (before > 0 && diff < 0)
      push(
        'domains_drop',
        (-diff / before) * 100,
        `来源域名 ${String(before)} → ${String(now)}，少了 ${pct((-diff / before) * 100)}（估算）`,
      )
  }
  const spam = input.ours?.spam_score
  if (spam !== undefined)
    push('spam_score_high', spam, `外链整体垃圾分 ${String(spam)}（估算，0–100）`)
  const anchors = anchorShares(input.rows, ctx)
  const top = anchors.find((a) => a.kind === 'exact' || a.kind === 'other')
  if (top !== undefined)
    push(
      'anchor_concentration',
      top.share * 100,
      `${pct(top.share * 100)} 的外链锚文本都是「${top.anchor}」`,
    )
  if (input.rows.length > 0) {
    const exact = input.rows.filter((r) => anchorKind(r.anchor, ctx) === 'exact').length
    push(
      'exact_anchor_high',
      (exact / input.rows.length) * 100,
      `完全匹配关键词的锚文本占 ${pct((exact / input.rows.length) * 100)}（复核线 15%）`,
    )
    const byDomain = new Map<string, number>()
    for (const r of input.rows) {
      const d = backlinkDomain(r.domain_from || r.url_from)
      byDomain.set(d, (byDomain.get(d) ?? 0) + 1)
    }
    const [heavy, n] = [...byDomain.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
    push(
      'single_domain_heavy',
      (n / input.rows.length) * 100,
      `${pct((n / input.rows.length) * 100)} 的外链来自 ${heavy}`,
    )
  }
  const suspicious = suspiciousSources(input.rows, ctx)
  if (suspicious.length > 0 && input.rows.length > 0) {
    const bad = new Set(suspicious.map((s) => s.domain))
    const share =
      (input.rows.filter((r) => bad.has(backlinkDomain(r.domain_from || r.url_from))).length /
        input.rows.length) *
      100
    push(
      'suspicious_sources',
      share,
      `${String(suspicious.length)} 个可疑来源站，占外链 ${pct(share)}；先看清楚再决定要不要处理，别急着拒绝`,
    )
  }
  const gap = backlinkGap({
    ours: input.rows,
    competitors: input.competitors,
    our_domains: input.our_domains,
  })
  const order = { high: 0, medium: 1, low: 2 }
  issues.sort((a, b) => order[a.severity] - order[b.severity])
  return { ...(change === undefined ? {} : { change }), anchors, suspicious, issues, gap }
}

/** 交公关那件事的正文：竞品有而我们没有的来源站（Top 10）。 */
export function backlinkGapBrief(gap: readonly BacklinkGapSite[]): string[] {
  return [
    '这些站链了竞品、还没链我们（外链体检每月一次，数据是估算）：',
    ...gap.map(
      (g, i) =>
        `${String(i + 1)}. ${g.domain}——链了 ${g.competitors.join('、')}${
          g.domain_rating === undefined ? '' : `（权重约 ${String(g.domain_rating)}）`
        }`,
    ),
    '建议：先看这个站链竞品的那一页是什么（测评、清单、采访还是资源页），再想我们凭什么被收进去；不买链接、不批量群发。',
  ]
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const txt = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

/** 云上 `seo.backlink_summary` 回的那一行 → 概况（认不出回 `undefined`）。 */
export function backlinkSummaryOf(
  items: readonly Record<string, unknown>[],
  at: string,
): BacklinkSummary | undefined {
  const r = items[0]
  if (r === undefined) return undefined
  const target = txt(r.target)
  if (target === undefined) return undefined
  const pick = (k: string): Record<string, number> => {
    const v = num(r[k])
    return v === undefined ? {} : { [k]: v }
  }
  return {
    target,
    ...pick('rank'),
    ...pick('backlinks'),
    ...pick('referring_domains'),
    ...pick('referring_main_domains'),
    ...pick('broken_backlinks'),
    ...pick('spam_score'),
    at,
  }
}

/** 云上 `seo.backlinks` 回的行 → 外链（没有来源地址的丢掉）。 */
export function backlinkRowsOf(items: readonly Record<string, unknown>[]): BacklinkRow[] {
  const out: BacklinkRow[] = []
  for (const r of items) {
    const url_from = txt(r.url_from)
    if (url_from === undefined) continue
    const dr = num(r.domain_rating)
    const spam = num(r.spam_score)
    const to = txt(r.url_to)
    const anchor = typeof r.anchor === 'string' ? r.anchor : undefined
    out.push({
      url_from,
      domain_from: backlinkDomain(txt(r.domain_from) ?? url_from),
      ...(to === undefined ? {} : { url_to: to }),
      ...(anchor === undefined ? {} : { anchor }),
      ...(dr === undefined ? {} : { domain_rating: dr }),
      ...(spam === undefined ? {} : { spam_score: spam }),
      ...(r.nofollow === true ? { nofollow: true } : {}),
    })
  }
  return out
}
