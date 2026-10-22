/**
 * WP448（docs/109 §4.4、§5.1 #2）：**改版回归**——主题发布、App 装卸之后（另每周兜底一次），首页 / 两件商品 / 一个合集 /
 * 一篇文章各抓一份，和上一次的基线比：标题、描述、规范网址、robots / noindex、H1、结构化数据摘要、状态码。
 *
 * 比对规则做成数据（{@link DRIFT_RULES}：每条一个 id、三级严重度、一句人话），判法是同 id 的纯函数。
 * 三级：`critical` 严重（出卡，指到是哪次改版）/ `warning` 注意 / `info` 知道一下（后两级进简报）。
 * 基线快照由 `@agentsws/site-core` 的 `driftSnapshotOf` 从页面读出来；这里只比，不抓、不经模型。
 *
 * 规则思路借 claude-seo（MIT，github.com/AgriciDaniel/claude-seo @ 4b99de2）`skills/seo-drift` 与其
 * `references/comparison-rules.md`（17 条、三级）；我们按 Shopify 店改写、去掉了要额外抓数的几条（Lighthouse 分、
 * Open Graph、整页内容摘要），加了商品页专有的两条（Product 结构化数据没了、价格从结构化数据里掉了）。
 */
import type { DriftFinding, DriftSeverity, DriftSnapshot } from '@agentsws/contracts'

export interface DriftRule {
  severity: DriftSeverity
  label: string
}

/** 规则表版本（改了严重度就改日期）。 */
export const DRIFT_RULES_VERSION = '2026-10-22'

/** 比对规则（数据）：id → 严重度与一句人话。判法在 {@link DRIFT_CHECKS}。 */
export const DRIFT_RULES = {
  status_error: { severity: 'critical', label: '页面打不开了' },
  noindex_added: { severity: 'critical', label: '被设成了不让收录（noindex）' },
  canonical_removed: { severity: 'critical', label: '规范网址没了' },
  canonical_changed: { severity: 'critical', label: '规范网址改了' },
  title_removed: { severity: 'critical', label: '标题没了' },
  h1_removed: { severity: 'critical', label: 'H1 没了' },
  schema_removed: { severity: 'critical', label: '结构化数据整个没了' },
  product_schema_removed: { severity: 'critical', label: '商品页的 Product 结构化数据没了' },
  redirected: { severity: 'warning', label: '页面开始跳转' },
  title_changed: { severity: 'warning', label: '标题改了' },
  description_removed: { severity: 'warning', label: '描述没了' },
  description_changed: { severity: 'warning', label: '描述改了' },
  h1_changed: { severity: 'warning', label: 'H1 大改' },
  schema_type_removed: { severity: 'warning', label: '结构化数据少了一类' },
  product_price_removed: { severity: 'warning', label: '结构化数据里的价格没了' },
  noindex_removed: { severity: 'info', label: '恢复成可以收录' },
  schema_added: { severity: 'info', label: '新加了结构化数据' },
  schema_modified: { severity: 'info', label: '结构化数据内容有变' },
  h1_reworded: { severity: 'info', label: 'H1 小改' },
  product_price_changed: { severity: 'info', label: '结构化数据里的价格变了' },
} as const satisfies Record<string, DriftRule>

export type DriftRuleId = keyof typeof DRIFT_RULES

/** H1 改了多少算「大改」：字面相似度低于它（二元组 Dice 系数，0–1）。 */
export const H1_SIMILARITY_MIN = 0.5

const ok2xx = (s: number): boolean => s >= 200 && s < 300
const noindex = (r: string | undefined): boolean => r !== undefined && /\b(noindex|none)\b/.test(r)
const key = (u: string | undefined): string | undefined => {
  if (u === undefined) return undefined
  try {
    const x = new URL(u)
    return `${x.host.toLowerCase().replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '') || '/'}`
  } catch {
    return u.trim().replace(/\/+$/, '').toLowerCase()
  }
}
const isProduct = (t: string): boolean => t === 'Product' || t === 'ProductGroup'

/** 两段字的相似度（字符二元组的 Dice 系数；都空 = 1）。 */
export function similarity(a: string, b: string): number {
  const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const x = norm(a)
  const y = norm(b)
  if (x === y) return 1
  if (x.length < 2 || y.length < 2) return 0
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const gx = grams(x)
  const gy = grams(y)
  let both = 0
  for (const [g, n] of gx) both += Math.min(n, gy.get(g) ?? 0)
  return (2 * both) / (x.length - 1 + (y.length - 1))
}

type Hit = { before?: string; after?: string } | undefined
type Check = (b: DriftSnapshot, c: DriftSnapshot) => Hit

/** 每条规则的判法（同输入同输出）。前一份打不开的页不比（那是「本来就坏」，体检那边会报）。 */
export const DRIFT_CHECKS: Record<DriftRuleId, Check> = {
  status_error: (b, c) =>
    ok2xx(b.status) && c.status >= 400
      ? { before: String(b.status), after: String(c.status) }
      : undefined,
  redirected: (b, c) =>
    ok2xx(b.status) && c.status >= 300 && c.status < 400
      ? { before: String(b.status), after: String(c.status) }
      : undefined,
  noindex_added: (b, c) =>
    !noindex(b.robots) && noindex(c.robots)
      ? { before: b.robots ?? 'index', after: c.robots ?? '' }
      : undefined,
  noindex_removed: (b, c) =>
    noindex(b.robots) && !noindex(c.robots)
      ? { before: b.robots ?? '', after: c.robots ?? 'index' }
      : undefined,
  canonical_removed: (b, c) =>
    b.canonical !== undefined && c.canonical === undefined ? { before: b.canonical } : undefined,
  canonical_changed: (b, c) =>
    b.canonical !== undefined && c.canonical !== undefined && key(b.canonical) !== key(c.canonical)
      ? { before: b.canonical, after: c.canonical }
      : undefined,
  title_removed: (b, c) =>
    b.title !== undefined && c.title === undefined ? { before: b.title } : undefined,
  title_changed: (b, c) =>
    b.title !== undefined && c.title !== undefined && b.title.trim() !== c.title.trim()
      ? { before: b.title, after: c.title }
      : undefined,
  description_removed: (b, c) =>
    b.description !== undefined && c.description === undefined
      ? { before: b.description }
      : undefined,
  description_changed: (b, c) =>
    b.description !== undefined &&
    c.description !== undefined &&
    b.description.trim() !== c.description.trim()
      ? { before: b.description, after: c.description }
      : undefined,
  h1_removed: (b, c) =>
    b.h1.length > 0 && c.h1.length === 0 ? { before: b.h1[0] ?? '' } : undefined,
  h1_changed: (b, c) => {
    const x = b.h1[0]
    const y = c.h1[0]
    return x !== undefined && y !== undefined && similarity(x, y) < H1_SIMILARITY_MIN
      ? { before: x, after: y }
      : undefined
  },
  h1_reworded: (b, c) => {
    const x = b.h1[0]
    const y = c.h1[0]
    if (x === undefined || y === undefined || x.trim() === y.trim()) return undefined
    return similarity(x, y) >= H1_SIMILARITY_MIN ? { before: x, after: y } : undefined
  },
  schema_removed: (b, c) =>
    b.schema.types.length > 0 && c.schema.types.length === 0
      ? { before: b.schema.types.join('、') }
      : undefined,
  product_schema_removed: (b, c) =>
    b.kind === 'product' &&
    b.schema.types.some(isProduct) &&
    c.schema.types.length > 0 &&
    !c.schema.types.some(isProduct)
      ? { before: b.schema.types.join('、'), after: c.schema.types.join('、') }
      : undefined,
  schema_type_removed: (b, c) => {
    if (c.schema.types.length === 0) return undefined
    const gone = b.schema.types.filter((t) => !c.schema.types.includes(t))
    // 商品页的 Product 没了由上一条（严重）说，这条不重复
    const rest = b.kind === 'product' ? gone.filter((t) => !isProduct(t)) : gone
    return rest.length > 0 ? { before: rest.join('、') } : undefined
  },
  schema_added: (b, c) =>
    b.schema.types.length === 0 && c.schema.types.length > 0
      ? { after: c.schema.types.join('、') }
      : undefined,
  schema_modified: (b, c) =>
    b.schema.types.length > 0 &&
    c.schema.types.length > 0 &&
    b.schema.hash !== c.schema.hash &&
    b.schema.types.join() === c.schema.types.join()
      ? {}
      : undefined,
  product_price_removed: (b, c) =>
    b.schema.product_price !== undefined &&
    c.schema.product_price === undefined &&
    c.schema.types.some(isProduct)
      ? { before: b.schema.product_price }
      : undefined,
  product_price_changed: (b, c) =>
    b.schema.product_price !== undefined &&
    c.schema.product_price !== undefined &&
    Number(b.schema.product_price) !== Number(c.schema.product_price)
      ? { before: b.schema.product_price, after: c.schema.product_price }
      : undefined,
}

const SEVERITY_ORDER: Record<DriftSeverity, number> = { critical: 0, warning: 1, info: 2 }

const clip = (s: string | undefined): string | undefined =>
  s === undefined ? undefined : s.length > 120 ? `${s.slice(0, 117)}…` : s

/**
 * 基线 vs 这一次：逐页、逐条规则比。按网址对上（这次没抓到的页不比，由调用方记一句）。
 * 前一份本身打不开的页只看「恢复了没有」以外的什么都不比。严重的排前面。
 */
export function compareDrift(
  baseline: readonly DriftSnapshot[],
  current: readonly DriftSnapshot[],
): DriftFinding[] {
  const out: DriftFinding[] = []
  const finding = (id: DriftRuleId, b: DriftSnapshot, hit: NonNullable<Hit>): DriftFinding => {
    const before = clip(hit.before)
    const after = clip(hit.after)
    return {
      rule: id,
      severity: DRIFT_RULES[id].severity,
      url: b.url,
      kind: b.kind,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      detail: DRIFT_RULES[id].label,
    }
  }
  for (const b of baseline) {
    const c = current.find((x) => key(x.url) === key(b.url))
    if (c === undefined || c.status === 0) continue
    if (!ok2xx(b.status)) continue
    // 打不开 / 开始跳转了：其余几样都读不准，只报这一条
    const gate = (['status_error', 'redirected'] as const).find(
      (id) => DRIFT_CHECKS[id](b, c) !== undefined,
    )
    if (gate !== undefined) {
      out.push(finding(gate, b, DRIFT_CHECKS[gate](b, c) ?? {}))
      continue
    }
    for (const id of Object.keys(DRIFT_RULES) as DriftRuleId[]) {
      if (id === 'status_error' || id === 'redirected') continue
      const hit = DRIFT_CHECKS[id](b, c)
      if (hit !== undefined) out.push(finding(id, b, hit))
    }
  }
  return out.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.url.localeCompare(b.url) ||
      a.rule.localeCompare(b.rule),
  )
}

const PAGE_WORD: Record<DriftSnapshot['kind'], string> = {
  home: '首页',
  product: '商品页',
  collection: '合集页',
  article: '文章',
}

/** 一条回归 → 一行人话（卡上、事项里、简报里都用它）。 */
export function driftLine(f: DriftFinding): string {
  let path = f.url
  try {
    path = new URL(f.url).pathname
  } catch {
    // 不是完整地址就原样
  }
  const change =
    f.before !== undefined && f.after !== undefined
      ? `：${f.before} → ${f.after}`
      : f.before !== undefined
        ? `（原来：${f.before}）`
        : f.after !== undefined
          ? `：${f.after}`
          : ''
  return `${PAGE_WORD[f.kind]} ${path} ${f.detail}${change}`
}

/** 三级各几条（简报那一行）。 */
export function driftCounts(findings: readonly DriftFinding[]): Record<DriftSeverity, number> {
  const out: Record<DriftSeverity, number> = { critical: 0, warning: 0, info: 0 }
  for (const f of findings) out[f.severity] += 1
  return out
}
