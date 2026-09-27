/**
 * WP158：Search Console 与 GA4 真读数的**纯逻辑**那一半（docs/82）。
 *
 * 这里没有一跳网络：请求体怎么拼、上游返回怎么认、日期窗口怎么切、错误怎么翻成人话。
 * 真去问上游的是服务端（经 OpenConnector 的只读 Action，令牌只在连接器里）。
 *
 * 形状照 OpenConnector v1.6.5 的 provider 定义（`google_search_console` /
 * `google_analytics`），它们又是 Google 官方 API 的一层归一：
 * GSC `rows[].keys` 按请求的维度顺序；GA4 行的 `metrics` 是按表头名做键的**字符串**。
 * 认不出来就当没有——**不编一行、不补一个 0**。
 */
import type { GscRow, SitePage } from '@agentsws/contracts'
import { pathKey } from './attribution.js'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 上游的数可能是数，也可能是字符串（GA4 一律字符串）；转不了回 `undefined`。 */
function numberOf(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** OpenConnector 的结果可能包在 `data` 里（执行口的外壳），剥一层。 */
function unwrapData(payload: unknown): unknown {
  return isRecord(payload) && payload.data !== undefined && !('rows' in payload)
    ? payload.data
    : payload
}

/* ------------------------------------------------------------------ */
/* 日期窗口                                                             */
/* ------------------------------------------------------------------ */

/** Search Console 的日期按太平洋时间算（官方文档）。 */
export const GSC_TIME_ZONE = 'America/Los_Angeles'
/** 没探到最新完整日时，往前退几天（GSC 最近两三天的数还没定稿）。 */
export const GSC_FINAL_LAG_DAYS = 3
/** 一周几天（seo-core 的"近 7 天 vs 上一个 7 天"）。 */
export const WEEK_DAYS = 7

export interface DateWindow {
  /** 含，YYYY-MM-DD。 */
  start: string
  /** 含，YYYY-MM-DD。 */
  end: string
}

/** 某一时刻在某个时区里是哪一天（YYYY-MM-DD）。时区名认不出就按 UTC。 */
export function dateInZone(ms: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ms))
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
    return `${get('year')}-${get('month')}-${get('day')}`
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}

/** 日期加减天数（按日历日，不受夏令时影响）。 */
export function addDays(date: string, n: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`)
  return new Date(ms + n * 86_400_000).toISOString().slice(0, 10)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 按「日期」维度探出来的**最近一个有数的完整日**（`rows[].keys[0]` 是日期）。
 * `firstIncompleteDate` 给了就只认它之前的那些天（`dataState: all` 时才会给）。
 */
export function latestFinalDate(payload: unknown): string | undefined {
  const body = unwrapData(payload)
  if (!isRecord(body) || !Array.isArray(body.rows)) return undefined
  const meta = isRecord(body.metadata) ? body.metadata : {}
  const incomplete =
    typeof meta.firstIncompleteDate === 'string' ? meta.firstIncompleteDate : undefined
  let best: string | undefined
  for (const r of body.rows) {
    if (!isRecord(r) || !Array.isArray(r.keys)) continue
    const d = String(r.keys[0] ?? '')
    if (!DATE_RE.test(d)) continue
    if ((numberOf(r.impressions) ?? 0) <= 0) continue
    if (incomplete !== undefined && d >= incomplete) continue
    if (best === undefined || d > best) best = d
  }
  return best
}

export interface GscWeeks {
  current: DateWindow
  previous: DateWindow
}

/**
 * 本周与上周两段（等长、都已定稿）：以最新完整日为终点往前 7 天；没探到就用太平洋时间的
 * 今天往前 3 天当终点。**不从今天往回数**——本周那段夹着两三个还没出数的日子，每个词都会
 * 被误判成「在掉」。
 */
export function gscWeeks(input: { now_ms: number; latest_final?: string | undefined }): GscWeeks {
  const today = dateInZone(input.now_ms, GSC_TIME_ZONE)
  const floor = addDays(today, -1)
  const latest =
    input.latest_final !== undefined && DATE_RE.test(input.latest_final)
      ? input.latest_final
      : undefined
  // 探出来的日子不许比「昨天」还新（时钟偏了也不越界）
  const end = latest !== undefined && latest <= floor ? latest : addDays(today, -GSC_FINAL_LAG_DAYS)
  const start = addDays(end, -(WEEK_DAYS - 1))
  return {
    current: { start, end },
    previous: { start: addDays(start, -WEEK_DAYS), end: addDays(start, -1) },
  }
}

/** 探最新完整日的那一次请求：近 10 天、按日期。 */
export function gscProbeRequest(site_url: string, now_ms: number): Record<string, unknown> {
  const today = dateInZone(now_ms, GSC_TIME_ZONE)
  return {
    siteUrl: site_url,
    startDate: addDays(today, -10),
    endDate: addDays(today, -1),
    dimensions: ['date'],
    type: 'web',
    rowLimit: 20,
  }
}

/* ------------------------------------------------------------------ */
/* Search Console：搜索分析的行                                          */
/* ------------------------------------------------------------------ */

export type GscDimension = 'date' | 'query' | 'page' | 'country' | 'device'

/** 一次「搜索分析」要多少行、翻几页（单次上限 25 000）。 */
export const GSC_ROW_LIMIT = 25_000
export const GSC_MAX_PAGES = 2

/** 按维度取数的那一次请求（点击、曝光、点击率、平均排名都在返回里）。 */
export function gscQueryRequest(input: {
  site_url: string
  window: DateWindow
  dimensions: readonly GscDimension[]
  start_row?: number
  row_limit?: number
}): Record<string, unknown> {
  return {
    siteUrl: input.site_url,
    startDate: input.window.start,
    endDate: input.window.end,
    dimensions: [...input.dimensions],
    type: 'web',
    rowLimit: input.row_limit ?? GSC_ROW_LIMIT,
    ...(input.start_row === undefined || input.start_row === 0
      ? {}
      : { startRow: input.start_row }),
  }
}

/** 一行，按维度名取值。 */
export interface GscKeyedRow {
  keys: Partial<Record<GscDimension, string>>
  clicks: number
  impressions: number
  ctr: number
  position: number
}

/** `query_search_analytics` 的返回 → 按维度名认好的行（缺数的行丢掉，不补 0）。 */
export function searchAnalyticsRows(
  payload: unknown,
  dimensions: readonly GscDimension[],
): GscKeyedRow[] {
  const body = unwrapData(payload)
  if (!isRecord(body) || !Array.isArray(body.rows)) return []
  const out: GscKeyedRow[] = []
  for (const r of body.rows) {
    if (!isRecord(r) || !Array.isArray(r.keys)) continue
    const clicks = numberOf(r.clicks)
    const impressions = numberOf(r.impressions)
    const position = numberOf(r.position)
    if (clicks === undefined || impressions === undefined || position === undefined) continue
    const keys: Partial<Record<GscDimension, string>> = {}
    const raw: unknown[] = r.keys
    dimensions.forEach((d, i) => {
      const v = raw[i]
      if (typeof v === 'string' && v !== '') keys[d] = v
    })
    const ctr = numberOf(r.ctr) ?? (impressions > 0 ? clicks / impressions : 0)
    out.push({ keys, clicks, impressions, ctr, position })
  }
  return out
}

/**
 * 本周与上周「查询 × 页面」对上 → seo-core 的 `GscRow`。
 *
 * `previous_complete`：上周那一份**翻完了**（没撞行数上限）。翻完了，本周有、上周没有的那一对
 * 上周就是真的 0 次点击；没翻完就不知道——不写 `clicks_prev_week`（契约：拉不到不填 0）。
 */
export function joinWeeks(
  current: readonly GscKeyedRow[],
  previous: readonly GscKeyedRow[] | undefined,
  previous_complete: boolean,
): GscRow[] {
  const key = (r: GscKeyedRow): string => `${r.keys.query ?? ''}\u0000${r.keys.page ?? ''}`
  const prev = new Map<string, number>()
  for (const r of previous ?? []) prev.set(key(r), (prev.get(key(r)) ?? 0) + r.clicks)
  const out: GscRow[] = []
  for (const r of current) {
    if (r.keys.query === undefined || r.keys.page === undefined) continue
    const p = prev.get(key(r))
    const known = p !== undefined ? p : previous !== undefined && previous_complete ? 0 : undefined
    out.push({
      query: r.keys.query,
      page: r.keys.page,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
      ...(known === undefined ? {} : { clicks_prev_week: known }),
    })
  }
  return out
}

/** 汇总后的一行（查询词表 / 落地页表）。 */
export interface GscRollup {
  key: string
  clicks: number
  impressions: number
  /** 0–1。 */
  ctr: number
  /** 按曝光加权的平均排名（一个词在十页上各排多少，按各自的曝光摊）。 */
  position: number
}

const round = (v: number, digits: number): number => {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

/**
 * 按查询或按页面汇总（点击、曝光相加；点击率重算；平均排名按曝光加权）。
 * 排序：点击降序、曝光降序、字面。
 */
export function gscRollup(rows: readonly GscRow[], by: 'query' | 'page'): GscRollup[] {
  const acc = new Map<string, { clicks: number; impressions: number; weighted: number }>()
  for (const r of rows) {
    const k = by === 'query' ? r.query : r.page
    const cur = acc.get(k) ?? { clicks: 0, impressions: 0, weighted: 0 }
    cur.clicks += r.clicks
    cur.impressions += r.impressions
    cur.weighted += r.position * Math.max(r.impressions, 0)
    acc.set(k, cur)
  }
  return [...acc.entries()]
    .map(([key, v]) => ({
      key,
      clicks: v.clicks,
      impressions: v.impressions,
      ctr: v.impressions > 0 ? round(v.clicks / v.impressions, 4) : 0,
      position: v.impressions > 0 ? round(v.weighted / v.impressions, 1) : 0,
    }))
    .sort(
      (a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.key.localeCompare(b.key),
    )
}

/* ------------------------------------------------------------------ */
/* Search Console：站点属性与页面                                        */
/* ------------------------------------------------------------------ */

/** 一个可选的站点属性（下拉里的一项）。 */
export interface GscSiteOption {
  /** Search Console 存的原样（`https://www.x.com/` 或 `sc-domain:x.com`），原样传回去。 */
  site_url: string
  /** 域名属性 / 网址前缀属性。 */
  kind: 'domain' | 'url_prefix'
  /** 给人看的：域名属性写"x.com（整个域名）"，网址前缀写那个地址。 */
  label: string
}

/** `list_sites` → 可选的站点（没验证过所有权的读不到数，不列）。 */
export function gscSiteOptions(payload: unknown): GscSiteOption[] {
  const body = unwrapData(payload)
  const list = isRecord(body) && Array.isArray(body.sites) ? body.sites : []
  const out: GscSiteOption[] = []
  for (const s of list) {
    if (!isRecord(s) || typeof s.siteUrl !== 'string' || s.siteUrl.trim() === '') continue
    if (s.permissionLevel === 'siteUnverifiedUser') continue
    const site_url = s.siteUrl.trim()
    const domain = site_url.startsWith('sc-domain:')
    out.push({
      site_url,
      kind: domain ? 'domain' : 'url_prefix',
      label: domain ? `${site_url.slice('sc-domain:'.length)}（整个域名）` : site_url,
    })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

/** 页面地址 → 店里的哪种页（Shopify 的路径约定；认不出就是"其它"）。 */
export function pageKindOf(url: string): SitePage['kind'] {
  const path = pathKey(url) ?? ''
  if (path === '/') return 'home'
  if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?products\//.test(path)) return 'product'
  if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?collections\//.test(path)) return 'collection'
  if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?blogs\/[^/]+\/[^/]+/.test(path)) return 'article'
  if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?pages\//.test(path)) return 'page'
  return 'other'
}

/**
 * 网址检查的结果 → 收录状况（`SitePage.index_status`）。
 *
 * 认 Google 原样的 `indexStatusResult`：`verdict` PASS 且规范网址对得上 = 已收录；
 * `coverageState` 里写着 redirect = 在跳转；Google 选的规范网址与我们声明的不一样 = 规范网址不对；
 * FAIL / NEUTRAL 且不是上面两种 = 没收录。认不出回 `undefined`（不知道 ≠ 没问题）。
 */
export function indexStatusOf(inspection: unknown): SitePage['index_status'] | undefined {
  const body = unwrapData(inspection)
  const result = isRecord(body) && isRecord(body.inspectionResult) ? body.inspectionResult : body
  const idx =
    isRecord(result) && isRecord(result.indexStatusResult) ? result.indexStatusResult : undefined
  if (idx === undefined) return undefined
  const coverage = typeof idx.coverageState === 'string' ? idx.coverageState.toLowerCase() : ''
  const verdict = typeof idx.verdict === 'string' ? idx.verdict.toUpperCase() : ''
  const google = typeof idx.googleCanonical === 'string' ? idx.googleCanonical : undefined
  const user = typeof idx.userCanonical === 'string' ? idx.userCanonical : undefined
  if (coverage.includes('redirect')) return 'redirect'
  if (
    coverage.includes('canonical') ||
    (google !== undefined && user !== undefined && pathKey(google) !== pathKey(user))
  )
    return 'canonical_mismatch'
  if (verdict === 'PASS') return 'indexed'
  if (verdict === 'FAIL' || verdict === 'NEUTRAL') return 'not_indexed'
  return undefined
}

/**
 * 从 GSC 行里认出店里有哪些页（按曝光排序），带上网址检查查到的收录状况。
 *
 * 标题 Search Console 不给——这里不编；`pageTargets` 在没有标题时按网址里的 handle 比
 * （Shopify 的 handle 就是标题转出来的）。
 */
export function sitePagesFrom(
  rows: readonly GscRow[],
  index_status: Readonly<Record<string, SitePage['index_status']>> = {},
): SitePage[] {
  const byPage = gscRollup(rows, 'page').sort((a, b) => b.impressions - a.impressions)
  return byPage.map((r) => {
    const status = index_status[r.key]
    return {
      url: r.key,
      kind: pageKindOf(r.key),
      ...(status === undefined ? {} : { index_status: status }),
    }
  })
}

/** 每天最多检查几页（每站点每天 2 000 次的额度，留足余量）。 */
export const INSPECT_MAX_PAGES = 10

/* ------------------------------------------------------------------ */
/* GA4：媒体资源与报表                                                   */
/* ------------------------------------------------------------------ */

/** 一个可选的 GA4 媒体资源。 */
export interface Ga4PropertyOption {
  /** 数字 id（`properties/123` 里的 123）。 */
  property_id: string
  label: string
}

/** `list_properties` → 可选的媒体资源。 */
export function ga4PropertyOptions(payload: unknown): Ga4PropertyOption[] {
  const body = unwrapData(payload)
  const list = isRecord(body) && Array.isArray(body.properties) ? body.properties : []
  const out: Ga4PropertyOption[] = []
  for (const p of list) {
    if (!isRecord(p)) continue
    const fromName =
      typeof p.property === 'string' ? /properties\/(\d+)/.exec(p.property)?.[1] : undefined
    const id = typeof p.propertyId === 'string' && p.propertyId !== '' ? p.propertyId : fromName
    if (id === undefined) continue
    const name = typeof p.displayName === 'string' && p.displayName !== '' ? p.displayName : id
    const account =
      typeof p.accountDisplayName === 'string' && p.accountDisplayName !== ''
        ? `（${p.accountDisplayName}）`
        : ''
    out.push({ property_id: id, label: `${name}${account}` })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

/** 只看自然搜索来的会话（docs/82 §6：这张表回答"搜索带来的人买没买"）。 */
const ORGANIC_ONLY = {
  filter: {
    fieldName: 'sessionDefaultChannelGroup',
    stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
  },
}

/** 按落地页：会话、关键事件、购买、购买收入（自然搜索）。 */
export function ga4LandingRequest(
  property_id: string,
  window: DateWindow,
): Record<string, unknown> {
  return {
    propertyId: property_id,
    dateRanges: [{ startDate: window.start, endDate: window.end }],
    dimensions: ['landingPage'],
    metrics: ['sessions', 'keyEvents', 'ecommercePurchases', 'purchaseRevenue'],
    dimensionFilter: ORGANIC_ONLY,
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 1000,
  }
}

/** 全站总量，本周与上周两段（不带维度：活跃用户按段去重，不能按天相加）。 */
export function ga4TotalsRequest(
  property_id: string,
  current: DateWindow,
  previous: DateWindow,
): Record<string, unknown> {
  return {
    propertyId: property_id,
    dateRanges: [
      { startDate: current.start, endDate: current.end, name: 'current' },
      { startDate: previous.start, endDate: previous.end, name: 'previous' },
    ],
    metrics: ['activeUsers', 'sessions', 'ecommercePurchases', 'purchaseRevenue'],
  }
}

/** 事件表：事件名、次数、其中算关键事件的次数（前 20）。 */
export function ga4EventsRequest(property_id: string, window: DateWindow): Record<string, unknown> {
  return {
    propertyId: property_id,
    dateRanges: [{ startDate: window.start, endDate: window.end }],
    dimensions: ['eventName'],
    metrics: ['eventCount', 'keyEvents'],
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 20,
  }
}

interface ReportRow {
  dims: Record<string, string>
  mets: Record<string, string>
}

/**
 * 报表的行（OpenConnector 归一过的 `dimensions` / `metrics` 按名做键；也认 Google 原样的
 * `dimensionHeaders` + `dimensionValues[{ value }]`）。
 */
function reportRows(payload: unknown): { rows: ReportRow[]; currency?: string } {
  const body = unwrapData(payload)
  const report = isRecord(body) && isRecord(body.report) ? body.report : body
  if (!isRecord(report)) return { rows: [] }
  const names = (h: unknown): string[] =>
    Array.isArray(h) ? h.map((x) => (isRecord(x) && typeof x.name === 'string' ? x.name : '')) : []
  const dimNames = names(report.dimensionHeaders)
  const metNames = names(report.metricHeaders)
  const cellOf = (v: unknown): string =>
    typeof v === 'string' ? v : isRecord(v) && typeof v.value === 'string' ? v.value : ''
  const zip = (keys: string[], values: unknown): Record<string, string> => {
    const out: Record<string, string> = {}
    if (Array.isArray(values))
      values.forEach((v, i) => {
        const k = keys[i]
        if (k !== undefined && k !== '') out[k] = cellOf(v)
      })
    return out
  }
  const strRec = (v: unknown): Record<string, string> | undefined =>
    isRecord(v)
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? x : String(x)]),
        )
      : undefined
  const rows: ReportRow[] = []
  for (const r of Array.isArray(report.rows) ? report.rows : []) {
    if (!isRecord(r)) continue
    rows.push({
      dims: strRec(r.dimensions) ?? zip(dimNames, r.dimensionValues),
      mets: strRec(r.metrics) ?? zip(metNames, r.metricValues),
    })
  }
  const meta = isRecord(report.metadata) ? report.metadata : {}
  const currency = typeof meta.currencyCode === 'string' ? meta.currencyCode : undefined
  return currency === undefined ? { rows } : { rows, currency }
}

/** GA4 按落地页的一行（自然搜索）。 */
export interface Ga4LandingRow {
  /** 落地页路径（GA4 `landingPage`，不含查询串）。 */
  page: string
  sessions: number
  key_events: number
  purchases: number
  revenue: number
  /** 购买 ÷ 会话（0–1）；没有会话就没有。 */
  conversion_rate?: number
}

/** 落地页报表 → 行（`(not set)` 那一行归不上任何页，丢掉）。 */
export function ga4LandingRows(payload: unknown): { rows: Ga4LandingRow[]; currency?: string } {
  const { rows, currency } = reportRows(payload)
  const out: Ga4LandingRow[] = []
  for (const r of rows) {
    const page = r.dims.landingPage ?? r.dims.landingPagePlusQueryString
    if (page === undefined || page === '' || page === '(not set)') continue
    const sessions = numberOf(r.mets.sessions)
    if (sessions === undefined) continue
    const purchases = numberOf(r.mets.ecommercePurchases) ?? numberOf(r.mets.transactions) ?? 0
    out.push({
      page,
      sessions,
      key_events: numberOf(r.mets.keyEvents) ?? numberOf(r.mets.conversions) ?? 0,
      purchases,
      revenue: round(numberOf(r.mets.purchaseRevenue) ?? numberOf(r.mets.totalRevenue) ?? 0, 2),
      ...(sessions > 0 ? { conversion_rate: round(purchases / sessions, 4) } : {}),
    })
  }
  return currency === undefined ? { rows: out } : { rows: out, currency }
}

/** 全站一段时间的总量。 */
export interface Ga4Totals {
  active_users: number
  sessions: number
  purchases: number
  revenue: number
}

/** 总量报表 → 本周 / 上周（没有那一段就没有那一格）。 */
export function ga4Totals(payload: unknown): {
  current?: Ga4Totals
  previous?: Ga4Totals
  currency?: string
} {
  const { rows, currency } = reportRows(payload)
  const out: { current?: Ga4Totals; previous?: Ga4Totals; currency?: string } = {}
  for (const r of rows) {
    // 两段日期时 GA4 自动加一个 `dateRange` 维度；只有一段时没有它，就当本周
    const which = r.dims.dateRange === 'previous' ? 'previous' : 'current'
    const active = numberOf(r.mets.activeUsers)
    if (active === undefined) continue
    out[which] = {
      active_users: active,
      sessions: numberOf(r.mets.sessions) ?? 0,
      purchases: numberOf(r.mets.ecommercePurchases) ?? 0,
      revenue: round(numberOf(r.mets.purchaseRevenue) ?? 0, 2),
    }
  }
  if (currency !== undefined) out.currency = currency
  return out
}

/** 事件表的一行。 */
export interface Ga4EventRow {
  event: string
  count: number
  key_events: number
}

export function ga4Events(payload: unknown): Ga4EventRow[] {
  return reportRows(payload)
    .rows.map((r) => ({
      event: r.dims.eventName ?? '',
      count: numberOf(r.mets.eventCount) ?? 0,
      key_events: numberOf(r.mets.keyEvents) ?? 0,
    }))
    .filter((r) => r.event !== '')
}

/* ------------------------------------------------------------------ */
/* 出错了怎么说                                                          */
/* ------------------------------------------------------------------ */

export type GoogleReadFailure = 'quota' | 'auth' | 'permission' | 'other'

/**
 * 上游错误 → 四类。OpenConnector 把 Google 的 429 透成 429（适配器映射为 `rate_limited`）；
 * GSC 的配额用尽有时是 403 + `quotaExceeded`，所以先认配额、再认权限。
 */
export function classifyGoogleError(e: unknown): GoogleReadFailure {
  const code =
    isRecord(e) && typeof (e as { code?: unknown }).code === 'string'
      ? (e as { code: string }).code
      : ''
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  if (
    code === 'rate_limited' ||
    code === 'budget_exhausted' ||
    /quota|RESOURCE_EXHAUSTED|rateLimitExceeded|\b429\b/i.test(msg)
  )
    return 'quota'
  if (
    code === 'unauthenticated' ||
    code === 'reauth_required' ||
    /\b401\b|invalid_grant|unauthenticated|token (?:expired|revoked)/i.test(msg)
  )
    return 'auth'
  if (code === 'forbidden' || /\b403\b|permission|forbidden/i.test(msg)) return 'permission'
  return 'other'
}

const SOURCE_NAME = { gsc: 'Search Console', ga4: 'GA4' } as const

/** 给人看的那一句（卡上、面板上、事件的 `note` 里都用它）。 */
export function googleFailureText(
  source: 'gsc' | 'ga4',
  kind: GoogleReadFailure,
  has_previous: boolean,
): string {
  const name = SOURCE_NAME[source]
  const fallback = has_previous ? '先用上一份。' : '这一块先空着。'
  switch (kind) {
    case 'quota':
      return `Google 这边今天读 ${name} 的额度用完了，${fallback}明天早上自动再读。`
    case 'auth':
      return `${name} 的授权过期了，去连接页重新授权一次；${fallback}`
    case 'permission':
      return `这个 Google 账号读不到选中的那个${source === 'gsc' ? '站点' : '媒体资源'}（可能被移出了权限），换一个或重新授权；${fallback}`
    default:
      return `这次没读到 ${name}（Google 那边出错），${fallback}`
  }
}
