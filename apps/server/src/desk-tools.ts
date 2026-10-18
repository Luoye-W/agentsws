/**
 * WP421（自查 general 组，决策 1266–1270）：公关 / 内容与搜索 / B2B / 设计这几条职责的**读数与起草工具**的执行器
 * （名字 / 描述 / 参数在 `@agentsws/stand-ins` 的 `runtime/desk-tools.ts`）。
 *
 * 这里一行业务逻辑都不另写：读的是与界面同一份库（公关库、搜索报告卡、GEO 看板、B2B 库、设计需求单），
 * 起草落到与 `/v1/pr/*`、`/v1/b2b/*`、`/v1/design/*` 同一个端口上（出卡，人批了才算数）。只做三件事：
 *
 * 1. **判职责**：`deskToolsFor(role_id)` 那一张表里没有这个工具 → `blocked`；
 * 2. **白名单出参**：给模型看的只有人话那几格（联系人没有邮箱、稿子不带联系人邮箱）；
 * 3. **照实说**：装配没好、库是空的、还没接通，都回一句中文 `message`，不当成 0。
 */
import type { B2bActor, B2bPort, DesignActor, PrActor, PrPort } from '@agentsws/api'
import type {
  ApprovalItem,
  B2bAccount,
  B2bContact,
  B2bQuote,
  B2bSample,
  ExportShipment,
  GeoMetricsView,
  RunRequest,
  TradeShow,
  TradeShowLead,
} from '@agentsws/contracts'
import { designDutyOfRole } from '@agentsws/contracts'
import {
  B2B_RECORD_KINDS,
  type B2bRecordKind,
  baseRoleId,
  type DeskToolData,
  DRAFT_FORUM_POST_TOOL,
  DRAFT_PRESS_RELEASE_TOOL,
  deskToolsFor,
  GET_BRAND_SYSTEM_TOOL,
  LIST_B2B_RECORDS_TOOL,
  LIST_DESIGN_REQUESTS_TOOL,
  LIST_FORUM_POSTS_TOOL,
  LIST_PRESS_RELEASES_TOOL,
  QUERY_GEO_METRICS_TOOL,
  QUERY_SEO_TODAY_TOOL,
  REQUEST_DESIGN_TOOL,
  SAVE_B2B_CONTACTS_TOOL,
  type ToolExecution,
  type ToolExecutor,
} from '@agentsws/stand-ins'
import type { B2bStore } from './b2b-store.js'
import type { DesignServiceAssembly } from './design.js'

export interface DeskToolsOptions {
  /** 公关端口（与 `/v1/pr/*` 同一份）；没装配回 `undefined`。 */
  pr?(): PrPort | undefined
  /** 公司档案里的名字 / 对外邮箱 / 简介（新闻稿的联系人与简介格；没有就留空让人补）。 */
  company?(): { name?: string; email?: string; boilerplate?: string } | undefined
  /** 最近的搜索报告卡（`seo_report`；按这次运行的人现查）。 */
  seoReports?(actor: RunRequest['actor']): Promise<readonly ApprovalItem[]>
  /** GEO 看板的数（与面板同一份）。 */
  geoMetrics?(): Promise<GeoMetricsView | undefined>
  /** B2B 库与端口（与 `/v1/b2b/*` 同一份）。 */
  b2b?(): { store: B2bStore; port: B2bPort } | undefined
  /** 设计岗（与 `/v1/design/*` 同一份）。 */
  design?(): Pick<DesignServiceAssembly, 'port' | 'brandSystem'> | undefined
}

const bareOf = (name: string): string =>
  name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
const day = (iso: string | undefined): string => (iso === undefined ? '' : iso.slice(0, 10))
const ok = (data: DeskToolData): ToolExecution => ({ status: 'ok', data })
const notReady = (what: string): ToolExecution =>
  ok({ ok: false, message: `这个进程没装${what}那一摊，读不到。` })

const RELEASE_STATUS_ZH: Readonly<Record<string, string>> = {
  draft: '草稿',
  approved: '已批（还没发）',
  distributed: '已发',
  withdrawn: '撤回了',
}
const POST_STATUS_ZH: Readonly<Record<string, string>> = {
  draft: '待批',
  approved: '已批（等人去发）',
  published: '已发',
  blocked: '被拦下',
  removed: '被删了',
}
const QUOTE_STATUS_ZH: Readonly<Record<string, string>> = {
  draft: '草稿',
  pending_approval: '等批',
  sent: '已发',
  accepted: '对方接受',
  rejected: '对方拒了',
  expired: '过期',
}
const SAMPLE_STATUS_ZH: Readonly<Record<string, string>> = {
  to_ship: '待寄',
  shipped: '已寄',
  delivered: '已签收',
  feedback: '有反馈',
}
const SHOW_STATUS_ZH: Readonly<Record<string, string>> = {
  considering: '在考虑',
  registered: '已报名',
  preparing: '在准备',
  on_site: '在展会',
  done: '结束',
  skipped: '不去了',
}
const SHIPMENT_STATUS_ZH: Readonly<Record<string, string>> = {
  in_production: '生产中',
  ready: '待出运',
  booked: '已订舱',
  shipped: '已出运',
  arrived: '已到港',
  closed: '结束',
}
const DESIGN_STATUS_ZH: Readonly<Record<string, string>> = {
  queued: '排队',
  briefed: '出了 brief',
  generating: '在出图',
  delivered: '交付了',
  cancelled: '取消了',
}

export function createDeskToolExecutor(options: DeskToolsOptions): ToolExecutor {
  return async ({ name, input, request }): Promise<ToolExecution> => {
    const tool = bareOf(name)
    if (!deskToolsFor(request.actor.role_id).includes(tool))
      return { status: 'blocked', reason: `这条职责用不了「${tool}」。` }
    const actor = {
      workspace_id: request.workspace_id,
      person_id: request.actor.person_id,
      assignment_id: request.actor.assignment_id,
      role_id: request.actor.role_id,
    } as PrActor & B2bActor & DesignActor
    try {
      switch (tool) {
        case LIST_PRESS_RELEASES_TOOL:
          return await listReleases(options, actor, input)
        case DRAFT_PRESS_RELEASE_TOOL:
          return await draftRelease(options, actor, input)
        case LIST_FORUM_POSTS_TOOL:
          return await listForumPosts(options, actor, input)
        case DRAFT_FORUM_POST_TOOL:
          return await draftForumPost(options, actor, input)
        case QUERY_SEO_TODAY_TOOL:
          return await seoToday(options, request)
        case QUERY_GEO_METRICS_TOOL:
          return await geoMetrics(options)
        case LIST_B2B_RECORDS_TOOL:
          return listB2b(options, input)
        case SAVE_B2B_CONTACTS_TOOL:
          return await saveContacts(options, actor, input)
        case LIST_DESIGN_REQUESTS_TOOL:
          return await listDesignRequests(options, actor, input)
        case GET_BRAND_SYSTEM_TOOL:
          return brandSystem(options, request.actor.role_id)
        case REQUEST_DESIGN_TOOL:
          return await requestDesign(options, actor, input, request)
      }
    } catch (e) {
      return { status: 'error', reason: e instanceof Error ? e.message : String(e) }
    }
    return { status: 'error', reason: `not_a_desk_tool:${tool}` }
  }
}

/* ── 公关：新闻稿 / 外部论坛 ─────────────────────────────────────────── */

async function listReleases(
  options: DeskToolsOptions,
  actor: PrActor,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  const port = options.pr?.()
  if (port === undefined) return notReady('公关')
  const status = str(input.status) as 'draft' | 'approved' | 'distributed' | 'withdrawn' | undefined
  const { rows } = await port.releases(actor, status === undefined ? {} : { status })
  if (rows.length === 0)
    return ok({
      ok: true,
      message: '还没有新闻稿。跟我说要发什么，我起草一篇出卡给你看。',
      rows: [],
    })
  return ok({
    ok: true,
    message: `一共 ${rows.length} 篇新闻稿。`,
    lines: rows
      .slice(0, 20)
      .map(
        (r) =>
          `「${r.headline}」· ${RELEASE_STATUS_ZH[r.status] ?? r.status} · ${r.cited_count}/${r.figure_count} 个数字有出处${r.embargo_until === undefined ? '' : ` · 禁发到 ${day(r.embargo_until)}`}`,
      ),
    rows: rows.slice(0, 20).map((r) => ({
      id: r.id,
      headline: r.headline,
      status: RELEASE_STATUS_ZH[r.status] ?? r.status,
      figure_count: r.figure_count,
      cited_count: r.cited_count,
      ...(r.embargo_until === undefined ? {} : { embargo_until: r.embargo_until }),
      updated_at: r.updated_at,
    })),
  })
}

async function draftRelease(
  options: DeskToolsOptions,
  actor: PrActor,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  const port = options.pr?.()
  if (port === undefined) return notReady('公关')
  const headline = str(input.headline)
  const body = str(input.body)
  if (headline === undefined || body === undefined)
    return { status: 'error', reason: '标题和正文都要有。' }
  const company = options.company?.() ?? {}
  const facts = Array.isArray(input.facts_cited)
    ? input.facts_cited
        .map((f) => (f !== null && typeof f === 'object' ? (f as Record<string, unknown>) : {}))
        .map((f) => ({ figure: str(f.figure), fact_card_id: str(f.fact_card_id) }))
        .filter(
          (f): f is { figure: string; fact_card_id: string } =>
            f.figure !== undefined && f.fact_card_id !== undefined,
        )
    : []
  const embargo = str(input.embargo_until)
  const staged = await port.draftRelease(actor, {
    headline,
    dek: str(input.dek) ?? '',
    body,
    boilerplate: str(input.boilerplate) ?? company.boilerplate ?? '',
    // 联系人不编：公司档案里有就用，没有就空着（卡上会提示补）
    contact: { name: company.name ?? '', email: company.email ?? '' },
    facts_cited: facts,
    // 引语不让模型编：一律留空，由人在卡上补
    quotes: [],
    ...(embargo === undefined ? {} : { embargo_until: embargo }),
  })
  if (!staged.staged)
    return ok({
      ok: false,
      message: `稿子起好了，但没出成卡：${staged.message ?? '被规矩拦下了'}。`,
    })
  return ok({
    ok: true,
    message:
      '新闻稿草稿出卡了，等你看。引语我没有写（要本人原话），联系人与公司简介按公司档案填的，空的请在卡上补。批了以后还不会自动发出去（分发渠道还没接通），卡上给你可复制的全文。',
    ...(staged.approval_item_id === undefined ? {} : { approval_item_id: staged.approval_item_id }),
    kind: 'press_release',
    ...(staged.change_id === undefined ? {} : { change_id: staged.change_id }),
  })
}

async function listForumPosts(
  options: DeskToolsOptions,
  actor: PrActor,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  const port = options.pr?.()
  if (port === undefined) return notReady('公关')
  const platform = str(input.platform)
  const { rows } = await port.externalPosts(actor, platform === undefined ? {} : { platform })
  const forum = rows.filter((r) => r.platform.toLowerCase() !== 'reddit')
  if (forum.length === 0)
    return ok({ ok: true, message: '外部论坛上还没有我们提过的帖子。', rows: [] })
  return ok({
    ok: true,
    message: `外部论坛上一共 ${forum.length} 条。`,
    lines: forum.slice(0, 20).map((r) => {
      const why = r.status === 'blocked' ? `（${r.rules_checked.reasons.join('；')}）` : ''
      return `${r.platform} · ${r.venue} · ${POST_STATUS_ZH[r.status] ?? r.status}${why}`
    }),
    rows: forum.slice(0, 20).map((r) => ({
      id: r.id,
      platform: r.platform,
      venue: r.venue,
      status: POST_STATUS_ZH[r.status] ?? r.status,
      ...(r.url === undefined ? {} : { url: r.url }),
    })),
  })
}

async function draftForumPost(
  options: DeskToolsOptions,
  actor: PrActor,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  const port = options.pr?.()
  if (port === undefined) return notReady('公关')
  const platform = str(input.platform)
  const venue = str(input.venue)
  const body = str(input.body)
  if (platform === undefined || venue === undefined || body === undefined)
    return { status: 'error', reason: '平台、版块和正文都要有。' }
  if (platform.toLowerCase() === 'reddit')
    return {
      status: 'blocked',
      reason: 'Reddit 归「外部版块」那条职责（插件代发），这里只管别的论坛 / 问答站。',
    }
  const title = str(input.title)
  const staged = await port.proposeExternalPost(actor, {
    platform,
    venue,
    kind: input.kind === 'post' ? 'post' : input.kind === 'comment' ? 'comment' : 'answer',
    ...(title === undefined ? {} : { title }),
    body,
  })
  if (!staged.staged)
    return ok({ ok: false, message: `没出成卡：${staged.message ?? '被规矩拦下了'}。` })
  return ok({
    ok: true,
    message:
      '帖子草稿出卡了。卡上写了版规读没读到；批了以后要你自己复制去发（论坛发帖还没接自动执行）。',
    ...(staged.approval_item_id === undefined ? {} : { approval_item_id: staged.approval_item_id }),
  })
}

/* ── 内容与搜索 / GEO ──────────────────────────────────────────────────── */

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : [])

/** 比较胜率至少要几条样本才出百分比。 */
export const MIN_WIN_SAMPLES = 5

const SIGNAL_ZH: Readonly<Record<string, string>> = {
  almost_there: '快到首页了',
  no_clicks: '有展示没人点',
  decaying: '在掉',
  untargeted: '没专门页',
  wrong_intent: '意图不对',
  ai_mode: '长问句',
}

async function seoToday(options: DeskToolsOptions, request: RunRequest): Promise<ToolExecution> {
  if (options.seoReports === undefined) return notReady('搜索报告')
  const items = [...(await options.seoReports(request.actor))].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  )
  const latest = (variant: string): Record<string, unknown> | undefined => {
    const hit = items.find((i) => rec(i.payload).variant === variant)
    return hit === undefined ? undefined : rec(hit.payload)
  }
  const daily = latest('daily')
  const geo = latest('weekly_geo')
  const picks = arr(daily?.picks)
  const gaps = arr(geo?.gaps)
  const lines = [
    ...picks.map(
      (p) =>
        `${SIGNAL_ZH[String(p.signal)] ?? String(p.signal)} · ${String(p.query ?? '')} · ${String(p.page ?? '')} → ${String(p.suggestion ?? '')}`,
    ),
    ...gaps
      .slice(0, 5)
      .map((g) => `AI 回答里缺位：${String(g.question ?? '')} → ${String(g.suggestion ?? '')}`),
  ]
  const notes = Array.isArray(daily?.notes) ? daily.notes.map(String) : []
  const message =
    daily === undefined
      ? '今天早上还没读过 Search Console（每天 08:00 读一次；没连 Search Console 就读不到）。'
      : picks.length === 0
        ? `今天没有值得动的${notes[0] === undefined ? '' : `：${notes[0]}`}。`
        : `今天值得动的 ${picks.length} 件事（来自 Search Console，数字照抄）：`
  return ok({ ok: daily !== undefined, message, lines, picks, gaps })
}

async function geoMetrics(options: DeskToolsOptions): Promise<ToolExecution> {
  const view = await options.geoMetrics?.()
  if (view === undefined) return notReady('AI 回答监测')
  if (view.week === undefined)
    return ok({
      ok: false,
      message: `AI 回答监测还没跑过一轮，没有数可说${view.notes[0] === undefined ? '' : `（${view.notes[0]}）`}。`,
      notes: view.notes,
    })
  const lines = [
    ...(view.brief === undefined ? [] : [view.brief]),
    ...view.brands
      .slice(0, 6)
      .map(
        (b) =>
          `${b.name}：被提到 ${b.mentioned} 次${b.sov === undefined ? '' : `，声量 ${Math.round(b.sov * 100)}%`}`,
      ),
    // 比较胜率：少于 5 条不出百分比（1 条样本就是 100% / 0%，没意义）
    ...(view.quality?.rivals ?? []).slice(0, 4).map((r) => {
      const n = r.wins + r.losses + r.ties
      return n < MIN_WIN_SAMPLES
        ? `和 ${r.name} 比：样本太少（${n} 条），先不算胜率`
        : `和 ${r.name} 比：赢 ${r.wins} 输 ${r.losses} 平 ${r.ties}（胜率 ${Math.round((r.wins / n) * 100)}%）`
    }),
    ...(view.quality?.bad_claims ?? [])
      .slice(0, 3)
      .map(
        (c) =>
          `AI 说错的一句：「${c.said}」${c.official === undefined ? '' : `（官方：${c.official}）`}`,
      ),
    ...view.our_pages
      .slice(0, 3)
      .map((p) => `被引用的我们的页：${p.url ?? p.domain}（${p.citations} 次）`),
  ]
  return ok({
    ok: true,
    message: `AI 回答监测（${view.week} 这一周）：`,
    lines,
    week: view.week,
    notes: view.notes,
  })
}

/* ── B2B ──────────────────────────────────────────────────────────────── */

const KIND_ZH: Readonly<Record<B2bRecordKind, string>> = {
  inquiries: '询盘',
  quotes: '报价',
  samples: '样品',
  accounts: '客户',
  contacts: '联系人',
  shows: '展会',
  leads: '展会线索',
  shipments: '出运单',
}

function listB2b(options: DeskToolsOptions, input: Record<string, unknown>): ToolExecution {
  const b2b = options.b2b?.()
  if (b2b === undefined) return notReady('B2B 库')
  const kind = str(input.kind) as B2bRecordKind | undefined
  if (kind === undefined || !B2B_RECORD_KINDS.includes(kind))
    return { status: 'error', reason: `kind 要是这几种之一：${B2B_RECORD_KINDS.join(' / ')}` }
  const { store } = b2b
  const accounts = store.list<B2bAccount>('b2b_account')
  const nameOf = (id: string | undefined): string =>
    accounts.find((a) => a.id === id)?.name ?? '（没记客户）'
  let lines: string[]
  switch (kind) {
    case 'inquiries':
      lines = store
        .inquiries()
        .slice(0, 30)
        .map(
          (i) =>
            `${day(i.received_at)} · ${i.subject || i.from_domain} · ${i.status === 'new' ? '待回' : i.status === 'replied' ? '回过了' : '关了'}`,
        )
      break
    case 'quotes': {
      const pending = store.drafts({ collection: 'b2b_quote', status: 'submitted' })
      lines = [
        ...store
          .list<B2bQuote>('b2b_quote')
          .map(
            (q) =>
              `${q.number} · ${nameOf(q.account_id)} · 第 ${q.current_version} 版 · ${QUOTE_STATUS_ZH[q.status] ?? q.status}`,
          ),
        ...pending.map(
          (d) =>
            `${String(d.record.number ?? d.record_id)} · ${nameOf(str(d.record.account_id))} · 等批`,
        ),
      ]
      break
    }
    case 'samples':
      lines = store
        .list<B2bSample>('b2b_sample')
        .map(
          (x) =>
            `${nameOf(x.account_id)} · ${x.items.map((i) => `${i.sku}×${i.qty}`).join('、')} · ${SAMPLE_STATUS_ZH[x.status] ?? x.status}${x.status === 'to_ship' ? ` · 要在 ${day(x.ship_by)} 前寄` : ''}${x.tracking_no === undefined ? '' : ` · 单号 ${x.carrier ?? ''} ${x.tracking_no}`}${x.feedback_by === undefined || x.status === 'feedback' ? '' : ` · 等反馈到 ${day(x.feedback_by)}`}`,
        )
      break
    case 'accounts':
      lines = accounts.map(
        (a) =>
          `${a.name}${a.country === undefined ? '' : `（${a.country}）`} · ${a.stage}${a.last_contact_at === undefined ? '' : ` · 上次往来 ${day(a.last_contact_at)}`}`,
      )
      break
    case 'contacts':
      // 没有邮箱：联系人库本来就只有加密库引用
      lines = store
        .list<B2bContact>('b2b_contact')
        .map(
          (c) =>
            `${c.name}${c.title === undefined ? '' : `（${c.title}）`} · ${nameOf(c.account_id)}${c.email_ref === undefined ? ' · 没有邮箱' : ''}`,
        )
      break
    case 'shows':
      lines = store
        .list<TradeShow>('trade_show')
        .map(
          (x) =>
            `${x.name} · ${x.city} · ${day(x.starts_on)}–${day(x.ends_on)} · ${SHOW_STATUS_ZH[x.status] ?? x.status}${x.registration_deadline === undefined ? '' : ` · 报名截止 ${day(x.registration_deadline)}`}`,
        )
      break
    case 'leads':
      lines = store
        .list<TradeShowLead>('trade_show_lead')
        .map((l) => `${l.company} · ${l.name} · ${l.intent} · 跟进截止 ${day(l.follow_up_by)}`)
      break
    case 'shipments':
      lines = store
        .list<ExportShipment>('export_shipment')
        .map(
          (x) =>
            `${x.po_number} · ${nameOf(x.account_id)} · ${SHIPMENT_STATUS_ZH[x.status] ?? x.status}${x.etd === undefined ? '' : ` · ETD ${day(x.etd)}`}${x.payment.balance_received ? '' : ' · 尾款没到'}`,
        )
      break
  }
  return ok({
    ok: true,
    message:
      lines.length === 0
        ? `B2B 库里还没有${KIND_ZH[kind]}。`
        : `B2B 库里的${KIND_ZH[kind]}，一共 ${lines.length} 条：`,
    lines: lines.slice(0, 30),
    count: lines.length,
  })
}

const csvCell = (v: string | undefined): string =>
  v === undefined ? '' : /[",\n]/u.test(v) ? `"${v.replaceAll('"', '""')}"` : v

async function saveContacts(
  options: DeskToolsOptions,
  actor: B2bActor,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  const b2b = options.b2b?.()
  if (b2b === undefined) return notReady('B2B 库')
  const list_name = str(input.list_name)
  const source_url = str(input.source_url)
  const rows = Array.isArray(input.contacts) ? input.contacts.map(rec) : []
  if (list_name === undefined || rows.length === 0)
    return { status: 'error', reason: '要给这批起个名字，并且至少一条联系人。' }
  if (source_url === undefined)
    return {
      status: 'error',
      reason: '要写来源网址（从哪看到的）——没有来源的名单不能存，后面也不能发开发信。',
    }
  const header = 'company,contact,email,title,country,domain'
  const lines = rows
    .map((r) => [
      str(r.company),
      str(r.name),
      str(r.email),
      str(r.title),
      str(r.country),
      str(r.domain),
    ])
    .filter(([company, , email]) => company !== undefined || email !== undefined)
    .map((cells) => cells.map(csvCell).join(','))
  if (lines.length === 0) return { status: 'error', reason: '每条至少要有公司名或邮箱。' }
  const out = await b2b.port.importCsv(actor, {
    name: list_name,
    csv: [header, ...lines].join('\n'),
    source_url,
  })
  if (!out.staged) return ok({ ok: false, message: `没出成卡：${out.message ?? '被规矩拦下了'}。` })
  return ok({
    ok: true,
    message: `出了一张「导入名单」卡：${out.rows} 条${out.suppressed > 0 ? `（${out.suppressed} 条在退订名单上，不会发）` : ''}。你批了才进库。`,
    ...(out.approval_item_id === undefined ? {} : { approval_item_id: out.approval_item_id }),
  })
}

/* ── 设计 ─────────────────────────────────────────────────────────────── */

async function listDesignRequests(
  options: DeskToolsOptions,
  actor: DesignActor,
  input: Record<string, unknown>,
): Promise<ToolExecution> {
  const design = options.design?.()
  if (design === undefined) return notReady('设计岗')
  const status = str(input.status)
  const duty = designDutyOfRole(baseRoleId(actor.role_id))?.id
  const { rows } = await design.port.requests(actor, {
    ...(duty === undefined ? {} : { duty }),
    ...(status === undefined ? {} : { status: status as never }),
    limit: 50,
  })
  const open =
    status === undefined
      ? rows.filter((r) => r.status !== 'delivered' && r.status !== 'cancelled')
      : rows
  return ok({
    ok: true,
    message:
      open.length === 0
        ? '没有等着做的需求单。'
        : `有 ${open.length} 张需求单${status === undefined ? '还没做完' : ''}：`,
    lines: open
      .slice(0, 20)
      .map(
        (r) =>
          `「${r.title}」· ${r.from_label} 下的 · ${DESIGN_STATUS_ZH[r.status] ?? r.status}${r.due_at === undefined ? '' : ` · ${day(r.due_at)} 要`}`,
      ),
    rows: open.slice(0, 20).map((r) => ({
      id: r.id,
      title: r.title,
      from: r.from_label,
      status: DESIGN_STATUS_ZH[r.status] ?? r.status,
      need: r.need.slice(0, 300),
      ...(r.due_at === undefined ? {} : { due_at: r.due_at }),
    })),
  })
}

function brandSystem(options: DeskToolsOptions, role_id: string): ToolExecution {
  const design = options.design?.()
  if (design === undefined) return notReady('设计岗')
  const duty = designDutyOfRole(baseRoleId(role_id))?.id ?? 'dtc'
  const out = design.brandSystem(duty)
  const sys = out.system
  const lines = [
    ...(sys === undefined
      ? []
      : [
          ...(sys.colors.length === 0 ? [] : [`配色：${sys.colors.join('、')}`]),
          ...(sys.fonts.length === 0 ? [] : [`字体：${sys.fonts.join('、')}`]),
          ...(sys.layout === undefined ? [] : [`版式：${sys.layout}`]),
          ...(sys.forbidden.length === 0 ? [] : [`禁忌：${sys.forbidden.join('、')}`]),
        ]),
    ...(out.design_md === undefined
      ? []
      : [
          ...(out.design_md.colors.length === 0
            ? []
            : [`品牌设计规范里的色板：${out.design_md.colors.join('、')}`]),
          ...(out.design_md.fonts.length === 0
            ? []
            : [`品牌设计规范里的字体：${out.design_md.fonts.join('、')}`]),
        ]),
  ]
  return ok({
    ok: sys !== undefined || out.design_md !== undefined,
    message:
      sys === undefined
        ? `还没设品牌系统${out.design_md === undefined ? '，也没有品牌设计规范' : '（下面是品牌设计规范里抓到的，仅供参考）'}。不要自己编配色。`
        : out.note,
    lines,
  })
}

async function requestDesign(
  options: DeskToolsOptions,
  actor: DesignActor,
  input: Record<string, unknown>,
  request: RunRequest,
): Promise<ToolExecution> {
  const design = options.design?.()
  if (design === undefined) return notReady('设计岗')
  const title = str(input.title)
  const need = str(input.need)
  if (title === undefined || need === undefined)
    return { status: 'error', reason: '要写清楚标题和要什么。' }
  const due = str(input.due_at)
  const variants =
    typeof input.variants === 'number' && Number.isFinite(input.variants)
      ? Math.max(1, Math.min(6, Math.floor(input.variants)))
      : undefined
  const out = await design.port.createRequest(
    { ...actor, role_id: baseRoleId(actor.role_id) },
    {
      title,
      need,
      ...(request.work_item === undefined ? {} : { matter_id: request.work_item.id }),
      ...(due === undefined ? {} : { due_at: due }),
      ...(variants === undefined ? {} : { variants }),
    },
  )
  return ok({
    ok: true,
    message: `需求单下给设计岗的「${out.request.duty_name}」了。设计岗那边会收到；出了图、定了稿，结果会回到这件事上。`,
    request_id: out.request.id,
    ...(out.staged.approval_item_id === undefined
      ? {}
      : { approval_item_id: out.staged.approval_item_id }),
  })
}
