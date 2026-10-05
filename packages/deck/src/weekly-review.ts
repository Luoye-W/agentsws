/**
 * WP224（docs/91 §2.2 #1、§5 #9）：**本周经营一页纸**——把各岗位面板上已有的数汇成一页。
 *
 * 结构（改写自 agency-agents 的高管摘要五段，见 `weekly-review` 技能首行出处）：
 * 情况 / 发现 / 影响 / 建议 / 下一步。每条发现带**一个数和出处**，全文 ≤ 500（汉字按字）。
 *
 * 四条纪律：
 *
 * 1. **数字只从面板来**：跑的是各岗位面板上那几个命名查询（`runQuery`），或面板读的同一份
 *    投影；这里不新算一个面板上没有的数。
 * 2. **取不到就写「没接」，不估**：没人担这条职责、源没连、还没出过数——三种情况各说各的理由，
 *    进 `not_connected`，一页纸上照样列出来。
 * 3. **影响与建议只由数推出**：哪条规则触发了才写哪条；没有数就没有那一句（不写空话）。
 * 4. **纯函数**：同输入同输出；谁的面板、哪个时刻，由调用方给。
 */
import type {
  Iso8601,
  WeeklyReviewFinding,
  WeeklyReviewGap,
  WeeklyReviewPanel,
  WeeklyReviewPayload,
} from '@agentsws/contracts'
import { ADS_PLATFORMS, WEEKLY_REVIEW_MAX_LENGTH } from '@agentsws/contracts'
import { runQuery } from './queries.js'
import type { QueryContext, ScalarResult, TableResult } from './types.js'

/** 一页纸要用到的几张面板上下文（谁担着那条职责就有那一张；没人担就没有）。 */
export interface WeeklyReviewInput {
  now: Iso8601
  brand?: string
  /**
   * 底：老板（`common.owner`）那一面的上下文。店铺订单、投放 / 社媒 / 红人的投影不分职责，
   * 从它读。
   */
  base: QueryContext
  /** 「内容与搜索」（`dtc.content`）担着的人那一面：按页收入那张周报卡只发给他。 */
  content?: QueryContext
  /** 客服（`dtc.support`）担着的人那一面：回信草稿只在他的队列里。 */
  support?: QueryContext
  /** 这个品牌里有人担着的职责（判「没人担」用）。 */
  held: readonly string[]
}

const DAY = 86_400_000

const money = (v: number, currency: string): string =>
  `${currency} ${v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

const pct = (v: number): string => `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10}%`

/** 本地日期（`YYYY-MM-DD`）。 */
function localDate(ms: number, tz: number): string {
  return new Date(ms + tz * 60_000).toISOString().slice(0, 10)
}

/** 这一周的周一（本地）。 */
export function mondayOf(now: Iso8601, tzOffsetMinutes: number): string {
  const local = new Date(Date.parse(now) + tzOffsetMinutes * 60_000)
  const dow = (local.getUTCDay() + 6) % 7
  return new Date(local.getTime() - dow * DAY).toISOString().slice(0, 10)
}

/** 多长：汉字按字、英文与数字按词（docs/91 §5 #9：「≤ 500 词」改成中文字数）。 */
export function reviewLength(text: string): number {
  const cjk = text.match(/[㐀-鿿]/g)?.length ?? 0
  const words = text.replace(/[㐀-鿿]/g, ' ').match(/[A-Za-z0-9][\w.%+-]*/g)?.length ?? 0
  return cjk + words
}

const PANEL_LABEL: Record<WeeklyReviewPanel, string> = {
  store_sales: '店铺销售',
  ads_roas: '广告两口径',
  ads_break_even: '盈亏线',
  content_revenue: '内容按页收入',
  social_30d: '社媒近 30 天',
  kol_attribution: '红人归因',
  support_volume: '客服量',
}

const scalarOf = (ctx: QueryContext, name: string): ScalarResult | undefined => {
  const r = runQuery(name, ctx, 'last_7d')
  return r.status === 'ok' ? (r.data as ScalarResult) : undefined
}
const tableOf = (ctx: QueryContext, name: string): TableResult | undefined => {
  const r = runQuery(name, ctx, 'last_7d')
  return r.status === 'ok' ? (r.data as TableResult) : undefined
}
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

interface Reading {
  finding?: WeeklyReviewFinding
  gap?: WeeklyReviewGap
  /** 给影响 / 建议用的结构化信号。 */
  signal?: Record<string, number | string>
}

const gap = (panel: WeeklyReviewPanel, reason: string): Reading => ({
  gap: { panel, label: PANEL_LABEL[panel], reason },
})

function readStore(input: WeeklyReviewInput): Reading {
  const ctx = input.base
  const sales = scalarOf(ctx, 'sales.total')
  if (sales === undefined) return gap('store_sales', '店铺没连')
  const orders = scalarOf(ctx, 'orders.count')
  const cur = sales.currency ?? ctx.base_currency
  const change =
    sales.previous === 0 ? undefined : ((sales.value - sales.previous) / sales.previous) * 100
  return {
    finding: {
      panel: 'store_sales',
      text: `销售额 ${money(sales.value, cur)}${orders === undefined ? '' : `、${orders.value} 单`}${
        change === undefined ? '（前 7 天没有数，比不了）' : `，比前 7 天 ${pct(change)}`
      }`,
      value: money(sales.value, cur),
      source: '网站运营 · 销售额 / 订单数（近 7 天，对比前 7 天）',
    },
    signal: { change: change ?? 'none' },
  }
}

function readAds(input: WeeklyReviewInput): Reading[] {
  const ctx = input.base
  const holds = ADS_PLATFORMS.filter((p) => input.held.includes(`ads.${p.id}`))
  if (holds.length === 0) return [gap('ads_roas', '没人担投放')]
  const out: Reading[] = []
  // 两口径：每个平台那一格（面板按职责的平台筛，这里逐个平台跑同一个查询）
  const parts: string[] = []
  let first: string | undefined
  for (const p of holds) {
    const r = runQuery('ads.roas_two_views', { ...ctx, role_id: `ads.${p.id}` }, 'last_7d')
    if (r.status !== 'ok') continue
    const s = r.data as ScalarResult
    if (s.spark.length === 0) continue
    parts.push(`${p.zh} 订单口径 ${s.value}（平台说 ${s.previous}）`)
    first ??= `ROAS ${s.value}`
  }
  out.push(
    parts.length === 0
      ? gap('ads_roas', '还没有归因数（平台口径与订单口径都没对上）')
      : {
          finding: {
            panel: 'ads_roas',
            text: `广告 ROAS：${parts.join('；')}`,
            value: first ?? '',
            source: '投放 · ROAS 两口径（各平台面板，不合并）',
          },
        },
  )
  // 盈亏线：高于止损线、低于盈亏线的 campaign 有几条（campaign 表上那个提示图标）
  const be = ctx.ads?.break_even
  if (be !== undefined) {
    if (be.break_even_roas === undefined) out.push(gap('ads_break_even', '没填毛利率'))
    else {
      const line = be.break_even_roas
      const below = (ctx.ads?.campaigns ?? []).filter(
        (c) => c.roas !== undefined && c.roas >= be.fixed_line && c.roas < line,
      )
      out.push({
        finding: {
          panel: 'ads_break_even',
          text: `${below.length} 条 campaign 的 ROAS 高于止损线 ${be.fixed_line}、低于盈亏线 ${line}`,
          value: `${below.length} 条`,
          source: `投放 · campaign 表的盈亏线一列（${be.note}）`,
        },
        signal: { below: below.length, line },
      })
    }
  }
  return out
}

function readContent(input: WeeklyReviewInput): Reading {
  if (!input.held.includes('dtc.content') || input.content === undefined)
    return gap('content_revenue', '没人担「内容与搜索」')
  const t = tableOf(input.content, 'seo.page_revenue')
  if (t === undefined) return gap('content_revenue', '店铺没连')
  if (t.rows.length === 0) return gap('content_revenue', '还没出过按页收入周报')
  const revenue = t.rows.reduce((a, r) => a + num(r.revenue), 0)
  const top = [...t.rows].sort((a, b) => num(b.revenue) - num(a.revenue))[0]
  const cur = input.content.base_currency
  return {
    finding: {
      panel: 'content_revenue',
      text: `自然搜索带来的页面收入 ${money(revenue, cur)}${
        top === undefined || num(top.revenue) === 0 ? '' : `，最多的是 ${String(top.page)}`
      }`,
      value: money(revenue, cur),
      source: '内容与搜索 · 按页收入（最近一张周报）',
    },
  }
}

function readSocial(input: WeeklyReviewInput): Reading {
  const social = input.base.social
  if (social === undefined || !input.held.some((r) => r.startsWith('social.')))
    return gap('social_30d', '没人担社媒')
  const rows = social.performance
  if (rows.length === 0) return gap('social_30d', '近 30 天没有发帖数据')
  const impressions = rows.reduce((a, r) => a + (r.impressions ?? r.views ?? 0), 0)
  const followers = rows.reduce((a, r) => a + (r.new_followers ?? 0), 0)
  return {
    finding: {
      panel: 'social_30d',
      text: `社媒近 30 天发了 ${rows.length} 条，曝光 ${impressions.toLocaleString('en-US')}、新增关注 ${followers}`,
      value: `${rows.length} 条`,
      source: '社媒运营 · 近 30 天表现（各渠道面板相加）',
    },
  }
}

function readKol(input: WeeklyReviewInput): Reading {
  if (!input.held.some((r) => r.startsWith('kol.'))) return gap('kol_attribution', '没人担红人营销')
  const t = tableOf(input.base, 'kol.attribution')
  if (t === undefined) return gap('kol_attribution', '红人源没连')
  if (t.rows.length === 0) return gap('kol_attribution', '还没有归到红人的订单')
  const revenue = t.rows.reduce((a, r) => a + num(r.revenue), 0)
  const orders = t.rows.reduce((a, r) => a + num(r.orders), 0)
  const cur = String(t.rows[0]?.currency ?? input.base.base_currency)
  return {
    finding: {
      panel: 'kol_attribution',
      text: `红人链接带来 ${orders} 单、${money(revenue, cur)}`,
      value: money(revenue, cur),
      source: '红人营销 · 归因（按追踪链接，累计）',
    },
  }
}

function readSupport(input: WeeklyReviewInput): Reading {
  if (!input.held.includes('dtc.support') || input.support === undefined)
    return gap('support_volume', '没人担客服')
  const pending = scalarOf(input.support, 'approvals.pending_replies')
  if (pending === undefined) return gap('support_volume', '审批源没开')
  const handled = pending.spark.reduce((a, b) => a + b, 0)
  return {
    finding: {
      panel: 'support_volume',
      text: `客服近 7 天起草回信 ${handled} 封，现在还压着 ${pending.value} 封待回复`,
      value: `${handled} 封`,
      source: '客服 · 待回复（近 7 天的回信草稿）',
    },
    signal: { pending: pending.value },
  }
}

/** 把几块面板的数汇成一页纸。 */
export function composeWeeklyReview(input: WeeklyReviewInput): WeeklyReviewPayload {
  const tz = input.base.tz_offset_minutes
  const nowMs = Date.parse(input.now)
  const from = localDate(nowMs - 6 * DAY, tz)
  const to = localDate(nowMs, tz)
  const readings = [
    readStore(input),
    ...readAds(input),
    readContent(input),
    readSocial(input),
    readKol(input),
    readSupport(input),
  ]
  const findings = readings.flatMap((r) => (r.finding === undefined ? [] : [r.finding]))
  const not_connected = readings.flatMap((r) => (r.gap === undefined ? [] : [r.gap]))
  const signal = (panel: WeeklyReviewPanel) =>
    readings.find((r) => r.finding?.panel === panel)?.signal

  const brand = input.brand ?? '这个品牌'
  const situation = `${brand} ${from} 到 ${to}：${findings.length} 块面板有数，${not_connected.length} 块没接。`

  const impact: string[] = []
  const recommendations: string[] = []
  const store = signal('store_sales')
  if (typeof store?.change === 'number' && store.change <= -20)
    impact.push(`销售额比前 7 天少了 ${Math.round(Math.abs(store.change))}%。`)
  const be = signal('ads_break_even')
  if (typeof be?.below === 'number' && be.below > 0) {
    impact.push(`${be.below} 条 campaign 按毛利算在亏钱，现在的止损线不会停它们。`)
    recommendations.push(`让投放看一眼这 ${be.below} 条（只提示，不会自动停）。`)
  }
  if (not_connected.some((g) => g.panel === 'ads_break_even'))
    recommendations.push('在「公司 → 品牌」填毛利率，投放面板才算得出盈亏线。')
  const sup = signal('support_volume')
  if (typeof sup?.pending === 'number' && sup.pending > 0)
    recommendations.push(`客服还压着 ${sup.pending} 封待回复，先清掉。`)
  const unheld = not_connected.filter((g) => g.reason.startsWith('没人担'))
  if (unheld.length > 0)
    recommendations.push(
      `${unheld.map((g) => g.label).join('、')}没人担，要看这几块的数先在公司页分配岗位。`,
    )
  const unlinked = not_connected.filter((g) => g.reason.includes('没连'))
  if (unlinked.length > 0)
    recommendations.push(`${unlinked.map((g) => g.label).join('、')}的源没连，去「连接」接上。`)

  const next_steps = [
    ...(recommendations[0] === undefined ? [] : [`这周先做：${recommendations[0]}`]),
    '下一份到点自动出（时间在「设置 → 经营一页纸」里改）。',
  ]

  // ≤ 500：发现最多 6 条、建议最多 4 条；还超就从后往前砍发现（出处那一行不算正文）
  let kept = findings.slice(0, 6)
  const recs = recommendations.slice(0, 4)
  const total = (f: WeeklyReviewFinding[]): number =>
    reviewLength(
      [
        situation,
        ...f.map((x) => x.text),
        ...impact,
        ...recs,
        ...next_steps,
        ...not_connected.map((g) => `${g.label}：没接（${g.reason}）`),
      ].join('\n'),
    )
  while (kept.length > 1 && total(kept) > WEEKLY_REVIEW_MAX_LENGTH) kept = kept.slice(0, -1)

  return {
    kind: 'weekly_review',
    week_of: mondayOf(input.now, tz),
    ...(input.brand === undefined ? {} : { brand: input.brand }),
    situation,
    findings: kept,
    impact,
    recommendations: recs,
    next_steps,
    not_connected,
    length: total(kept),
  }
}
