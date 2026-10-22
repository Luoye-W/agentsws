/**
 * WP385（决策 1076）：`query_site_health` 的执行器（名字 / 描述 / 参数在 `@agentsws/stand-ins` 的 `runtime/site-health.ts`）。
 *
 * 只读：读这个品牌最近一次体检的结论、上一次算的 AI 来源流量（实测）与体检设置，挑给模型看的那几格。
 * **不现跑体检**、不产生 staged / applied；只有一种「等」：体检正在跑（刚改完设置、或人在报表上点了），
 * 等它跑完再回（最多 {@link WAIT_MS}），免得模型拿上一次的结论当新的。
 */
import type { SiteHealthRun } from '@agentsws/contracts'
import { driftLine } from '@agentsws/seo-core'
import { issueLine, techIssueLine } from '@agentsws/site-core'
import {
  isSiteHealthRole,
  QUERY_SITE_HEALTH_TOOL,
  type SiteHealthQueryData,
  type ToolExecutor,
} from '@agentsws/stand-ins'
import type { SiteHealthService } from './site-health.js'

export interface SiteHealthToolsOptions {
  /** 这个工作区（品牌）的体检服务；没装配回 `undefined`。 */
  service(
    workspace_id: string,
  ): Promise<SiteHealthService | undefined> | SiteHealthService | undefined
  /** 体检正在跑时最多等多久（毫秒；默认 {@link WAIT_MS}）。 */
  waitMs?: number
}

/** 正在跑的体检最多等这么久（渲染对比慢，一般一两分钟内跑完）。 */
export const WAIT_MS = 90_000
/** 商品不一致给模型看几条（多的只报个数）。 */
const MAX_ISSUES = 12

type Part =
  | 'all'
  | 'crawlers'
  | 'raw_html'
  | 'products'
  | 'chatgpt_shopping'
  | 'ai_traffic'
  | 'settings'
  | 'tech'
  | 'drift'
const PARTS: readonly Part[] = [
  'all',
  'crawlers',
  'raw_html',
  'products',
  'chatgpt_shopping',
  'ai_traffic',
  'settings',
  'tech',
  'drift',
]

const bare = (name: string): string =>
  name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name

/** 一句话结论（给模型转述；数字照抄）。 */
function headline(run: SiteHealthRun | undefined, running: boolean): string {
  if (run === undefined)
    return running ? '体检正在跑，还没跑完。' : '还没体检过（每周一自动跑，报表块右上角也能点）。'
  if (run.status === 'failed') return `上次体检没跑成：${run.notes.join('；') || '没读到网站'}。`
  const blocked = run.crawlers.filter(
    (c) => c.purpose !== 'training' && (c.state === 'blocked' || c.state === 'partial'),
  ).length
  const jsOnly = run.raw_html.filter((r) => r.verdict === 'js_only').length
  const issues = run.products.issues.filter((i) => i.severity !== 'low').length
  const parts = [
    blocked === 0 ? 'AI 搜索类爬虫都进得来' : `${String(blocked)} 个 AI 爬虫被挡`,
    // 没读到商品就没得比：不说「都看得到」
    ...(run.raw_html.length === 0
      ? []
      : [jsOnly === 0 ? '关键事实不开 JS 也看得到' : `${String(jsOnly)} 处关键事实只靠 JS`]),
    run.products.checked === 0
      ? '商品这次没读'
      : issues === 0
        ? `抽查 ${String(run.products.checked)} 件商品信息都对得上`
        : `抽查 ${String(run.products.checked)} 件，${String(issues)} 处对不上`,
  ]
  const at = (run.finished_at ?? run.started_at).slice(0, 10)
  return `${running ? '（新一次体检还在跑，下面是上一次的）' : ''}${at} 体检：${parts.join('；')}。`
}

export function siteHealthQueryData(
  svc: Pick<SiteHealthService, 'latest' | 'lastTraffic' | 'settings'> &
    Partial<Pick<SiteHealthService, 'driftView'>>,
  part: Part,
  running: boolean,
): SiteHealthQueryData {
  const run = svc.latest()
  const want = (p: Part): boolean => part === 'all' || part === p
  const data: SiteHealthQueryData = { ok: true, message: headline(run, running) }
  if (running) data.running = true
  if (run !== undefined) {
    data.checked_at = run.finished_at ?? run.started_at
    data.status = run.status
    if (run.origin !== undefined) data.origin = run.origin
    if (run.notes.length > 0) data.notes = run.notes
    if (run.dispatched !== undefined)
      data.dispatched = { matter_id: run.dispatched.matter_id, issues: run.dispatched.issues }
    if (want('crawlers'))
      data.crawlers = {
        blocked: run.crawlers
          .filter(
            (c) => c.purpose !== 'training' && (c.state === 'blocked' || c.state === 'partial'),
          )
          .map((c) => ({
            token: c.token,
            ...(c.platform === undefined ? {} : { platform: c.platform }),
            purpose: c.purpose,
            state: c.state,
            ...(c.rule === undefined ? {} : { rule: c.rule }),
          })),
        training_blocked: run.crawlers
          .filter(
            (c) => c.purpose === 'training' && (c.state === 'blocked' || c.state === 'partial'),
          )
          .map((c) => c.token),
        allowed: run.crawlers.filter((c) => c.state === 'allowed').length,
      }
    if (want('raw_html'))
      data.raw_html = run.raw_html
        .filter((r) => r.verdict === 'js_only' || r.verdict === 'missing')
        .map((r) => ({ url: r.url, fact: r.fact, verdict: r.verdict }))
    if (want('products')) {
      const sorted = [...run.products.issues].sort((a, b) => rank(a.severity) - rank(b.severity))
      data.products = {
        checked: run.products.checked,
        issues: sorted
          .slice(0, MAX_ISSUES)
          .map((i) => ({ line: issueLine(i), severity: i.severity })),
        ...(sorted.length > MAX_ISSUES ? { more: sorted.length - MAX_ISSUES } : {}),
      }
    }
    if (want('chatgpt_shopping') && run.chatgpt_shopping !== undefined)
      data.chatgpt_shopping = {
        verdict: run.chatgpt_shopping.verdict,
        missing: run.chatgpt_shopping.fields
          .filter((f) => f.state !== 'ok' && f.requirement !== 'optional')
          .map((f) => f.field),
      }
    // WP448：技术体检（只列有问题的）
    if (want('tech') && run.tech !== undefined) {
      const sorted = [...run.tech.issues].sort((a, b) => rank(a.severity) - rank(b.severity))
      data.tech = {
        indexing: run.tech.indexing,
        speed: run.tech.speed,
        issues: sorted
          .slice(0, MAX_ISSUES)
          .map((i) => ({ line: techIssueLine(i), severity: i.severity, owner: i.owner })),
        ...(sorted.length > MAX_ISSUES ? { more: sorted.length - MAX_ISSUES } : {}),
        ...(run.tech.dispatched === undefined
          ? {}
          : {
              dispatched: run.tech.dispatched.map((d) => ({
                owner: d.owner,
                matter_id: d.matter_id,
              })),
            }),
      }
    }
  }
  // WP448：最近一次改版回归
  const drift = want('drift') ? svc.driftView?.().last : undefined
  if (drift !== undefined)
    data.drift = {
      at: drift.finished_at ?? drift.started_at,
      trigger: drift.trigger.label ?? drift.trigger.kind,
      ...(drift.trigger.change_id === undefined ? {} : { change_id: drift.trigger.change_id }),
      status: drift.status,
      findings: drift.findings
        .slice(0, MAX_ISSUES)
        .map((f) => ({ line: driftLine(f), severity: f.severity })),
      ...(drift.dispatched === undefined ? {} : { dispatched: drift.dispatched.matter_id }),
    }
  const t = svc.lastTraffic()
  if (want('ai_traffic') && t !== undefined)
    data.ai_traffic = {
      measured: true,
      since: t.since,
      until: t.until,
      currency: t.currency,
      ai_orders: t.ai_orders,
      ai_revenue: t.ai_revenue,
      total_orders: t.total_orders,
      visits: t.visits,
      rows: t.rows.map((r) => ({
        platform: r.platform,
        orders: r.orders,
        revenue: r.revenue,
        ...(r.visits === undefined ? {} : { visits: r.visits }),
      })),
      ...(t.previous === undefined ? {} : { previous: t.previous }),
    }
  if (want('settings')) {
    const s = svc.settings()
    data.settings = {
      ...(s.feed_url === undefined ? {} : { feed_url: s.feed_url }),
      listings: (s.listings ?? []).map((l) => ({ ...l })),
      crawlers_added: (s.crawlers_add ?? []).map((c) => c.token),
      crawlers_removed: [...(s.crawlers_remove ?? [])],
      referrers_added: (s.referrers_add ?? []).map((r) => r.platform),
      referrers_removed: [...(s.referrers_remove ?? [])],
    }
  }
  return data
}

const rank = (s: string): number => (s === 'high' ? 0 : s === 'medium' ? 1 : 2)

export function createSiteHealthToolExecutor(options: SiteHealthToolsOptions): ToolExecutor {
  return async (call) => {
    if (bare(call.name) !== QUERY_SITE_HEALTH_TOOL)
      return { status: 'error', reason: `unsupported_tool：${call.name}` }
    const req = call.request
    if (!isSiteHealthRole(req.actor.role_id))
      return { status: 'blocked', reason: '体检结论只给网站运营（店铺管理、SEO 与 GEO）。' }
    const svc = await options.service(req.workspace_id)
    if (svc === undefined) return { status: 'error', reason: '这个品牌没装网站体检。' }
    const raw = typeof call.input.part === 'string' ? call.input.part.trim() : 'all'
    const part = (PARTS as readonly string[]).includes(raw) ? (raw as Part) : 'all'
    // 正在跑就等它跑完（最多 waitMs）；只是等，不另起一次
    const inflight = svc.running()
    let running = false
    if (inflight !== undefined) {
      const wait = options.waitMs ?? WAIT_MS
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = await Promise.race([
        inflight.then(
          () => true,
          () => true,
        ),
        new Promise<false>((r) => {
          timer = setTimeout(() => r(false), wait)
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
      running = !done
    }
    return { status: 'ok', data: siteHealthQueryData(svc, part, running) }
  }
}
