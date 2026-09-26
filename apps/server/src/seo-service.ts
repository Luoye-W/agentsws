/**
 * WP154「内容与搜索」：`dtc.content` 那条职责里 SEO 与 GEO 的**副作用**那一层（每个品牌一份）。
 *
 * 判断全在 `@agentsws/seo-core`（纯函数）；这里只做接线：
 *
 * 1. **每天早上读一遍 Search Console**（定时 `seo.daily_read`，工作区时区 08:00）→
 *    「今天值得动的 5 件事」报告卡（`seo_report`，同日报一样不进队列）+ 每件落成什么：
 *    - 改页面标题 / 开头（`page_seo_edit`）、调内链（`internal_link_edit`）→ 本职责出**改动卡**，
 *      `after` 是机械的第一稿（把查询原样放进标题与 H1 / 用查询做锚文本），人在卡上改或"指导"；
 *    - 加小节（`page_section_add`）要写正文 → 开一件本职责的事项，写好了走同名动作出卡；
 *    - 新页面（SERP 看过、人群对）→ **新页面选题卡**（`seo_topic`），批了才开一件写这一页的事项；
 *    - 跳转 / 规范网址 / 没收录 → 开一件交给「建站」的事项；站外提及 → 开一件交给「公关」的事项。
 * 2. **每周**（周一 08:30）：按页面收入小结（`weekly_revenue`）+ AI 平台可见度（`weekly_geo`）；
 *    站点门面（llms.txt / 结构化数据 / AI 爬虫）开**一次**交给建站的事项。
 * 3. **发布前质检**（`gatePublish`）：账本 stage 之前的改写口——没过就改回草稿、拉回 L1、
 *    卡上逐句说明。
 *
 * 纪律：定时那一轮用**真持有内容与搜索**的那个人的分配去提（定时任务没有"当前用户"）；
 * 没人持有就什么都不做（不替没人管的职责出卡）。搜索数据接口（WP155）没接时 SERP 与 GEO
 * 跳过、卡上一句人话，其余照跑。本文件不打一跳网络——两个口都是注入的。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ApprovalBus,
  ApprovalItem,
  AssignmentId,
  Clock,
  ContentClaimRule,
  EventEnvelope,
  GeoQuestion,
  GscRow,
  Mandate,
  ObjectRef,
  PersonId,
  ProvenanceState,
  RoleId,
  SearchDataPort,
  SeoDailyPayload,
  SeoPick,
  SeoTopicPayload,
  SeoWeeklyGeoPayload,
  SeoWeeklyRevenuePayload,
  SitePage,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  type BrandProfileLike,
  buildDaily,
  checkContentQuality,
  evidenceText,
  type FactLike,
  GEO_PLATFORMS,
  generateGeoQuestions,
  geoGaps,
  type LandingConversion,
  type LandingOrder,
  MAX_GEO_QUESTIONS,
  pageRevenue,
  probeRows,
  qualitySummary,
  type SearchConsolePort,
  SITE_FACADE_NOTE,
  type SignalOptions,
} from '@agentsws/seo-core'
import type { StageInput, StageOutcome } from '@agentsws/txn'

/** 定时那一轮用谁的分配去提。 */
export interface SeoActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  assignment_id: AssignmentId
  role_id: RoleId
}

/** 开事项那一跳（`@agentsws/work` 的 `createMatter` 的最小子集）。 */
export interface SeoMatterPort {
  createMatter(input: {
    kind: 'project'
    title: string
    summary?: string
    position_id?: string
    pinned?: ObjectRef[]
    participants?: PersonId[]
    entry?: 'position' | 'role'
    role_id?: RoleId
    position_template_id?: string
  }): { id: string }
}

export interface SeoBrandInfo extends BrandProfileLike {
  /** 我们自己的域名（SERP 里排除、GEO 里认"引没引我们"）。 */
  domains: string[]
  /** 店铺域名（`landing_site` 是路径时拼成完整地址用）。 */
  shop_host: string
  currency: string
  /** SERP / AI 探测按哪个国家查。 */
  country: string
}

export interface SeoServiceOptions {
  workspace_id: WorkspaceId
  clock: Clock
  random(): number
  approvals: ApprovalBus
  ledger: { stage(input: StageInput): Promise<StageOutcome> }
  /** 05 §4：额度与等级从这条分配来（查不到按最严的一档）。 */
  actionOf(
    assignment_id: AssignmentId,
    action: string,
  ): { mandate: Mandate; level: 'L1' | 'L2' | 'L3' }
  /** 这条职责谁在持有（没人持有 = `undefined`）。 */
  holderOf(role_id: RoleId): SeoActor | undefined
  /** 职责模板里的阈值（`thresholds`）。 */
  thresholds(): Record<string, number>
  work?: SeoMatterPort
  searchConsole(): SearchConsolePort
  searchData(): SearchDataPort
  /** GA4 的落地页转化率；没接 = `undefined`。 */
  ga4?(): Promise<readonly LandingConversion[] | undefined>
  /** 近 7 天的订单（带 Shopify `landing_site`）。 */
  orders(): readonly LandingOrder[]
  /** 品牌档案（名字、域名、币种……）。域名为空时用 Search Console 页面清单里的主机名。 */
  brand(): SeoBrandInfo | Promise<SeoBrandInfo>
  /** 质检要的事实卡与规则表（从知识库投影；没有知识库就是空的）。 */
  knowledge?(actor: SeoActor): Promise<{ facts: FactLike[]; rules: ContentClaimRule[] }>
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 品牌落盘目录（问题清单与"交出去过哪些"记在这里；内存档没有）。 */
  dir?: string
}

export interface SeoDailyOutcome {
  skipped?: string
  approval_item_id?: string
  picks: number
  changes: number
  topics: number
  matters: number
}

export interface SeoServiceAssembly {
  daily(): Promise<SeoDailyOutcome>
  weeklyRevenue(): Promise<{ skipped?: string; approval_item_id?: string; rows: number }>
  weeklyGeo(): Promise<{ skipped?: string; approval_item_id?: string; gaps: number }>
  geoQuestions(): Promise<GeoQuestion[]>
  setGeoQuestions(list: readonly GeoQuestion[]): GeoQuestion[]
  /** 账本 stage 之前的改写口：`publish_post` 要发出去时跑质检。 */
  gatePublish(input: StageInput): Promise<StageInput>
  /** 卡被决定之后（新页面选题批了 → 开一件写这一页的事项）。 */
  onDecided(item: ApprovalItem): Promise<void>
}

/** 状态文件（品牌目录下）。 */
const STATE_FILE = 'seo-state.json'
/** 同一件事交出去之后多久内不再重复开（天）。 */
const HANDOFF_QUIET_DAYS = 14
const DAY_MS = 86_400_000

interface SeoState {
  geo_questions?: GeoQuestion[]
  /** `<lane>|<query>` → 上次交出去的时刻。 */
  handed_off?: Record<string, string>
  /** 站点门面那件事项开过没有。 */
  facade_matter_id?: string
}

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}

const INDEX_WORDS: Record<string, string> = {
  not_indexed: '没被收录',
  redirect: '在跳转',
  canonical_mismatch: '规范网址不对',
}

/** 页面种类 → 账本里的目标类型（文章在博客里，其余都是"页"）。 */
const targetTypeOf = (page: SitePage | undefined): string =>
  page?.kind === 'article' ? 'article' : page?.kind === 'product' ? 'product' : 'page'

/** 把查询写成标题里的样子（每个词首字母大写；中文原样）。 */
export function titleCaseQuery(q: string): string {
  return q
    .trim()
    .split(/\s+/)
    .map((w) => (/^[a-z]/.test(w) ? `${w.charAt(0).toUpperCase()}${w.slice(1)}` : w))
    .join(' ')
}

/**
 * 标题的机械第一稿：查询原样放最前面，原标题跟在后面（≤ 70 字符）。
 * 原标题已经包含查询 → 回 `undefined`（机械改不出更好的，交给人 / 模型在卡上改）。
 */
export function draftTitle(query: string, current: string | undefined): string | undefined {
  const q = titleCaseQuery(query)
  if (current !== undefined && current.toLowerCase().includes(query.trim().toLowerCase()))
    return undefined
  const full = current === undefined || current.trim() === '' ? q : `${q} – ${current.trim()}`
  return full.length <= 70 ? full : `${full.slice(0, 69).trimEnd()}…`
}

export function createSeoService(options: SeoServiceOptions): SeoServiceAssembly {
  const { workspace_id, clock } = options
  let seq = 0
  const nextId = (prefix: string): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `${prefix}_${rand}${seq.toString(36)}`
  }

  // ── 状态（问题清单 + 交出去过哪些）─────────────────────────────────
  let memoryState: SeoState = {}
  const loadState = (): SeoState => {
    if (options.dir === undefined) return memoryState
    try {
      return JSON.parse(readFileSync(join(options.dir, STATE_FILE), 'utf8')) as SeoState
    } catch {
      return {}
    }
  }
  const saveState = (state: SeoState): void => {
    memoryState = state
    if (options.dir === undefined) return
    writeFileSync(join(options.dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  const emit = (type: string, actor: string, payload: Record<string, unknown>): void => {
    options.appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'agent', id: actor },
      correlation: { trace_id: `tr_seo_${clock.now()}` },
      payload,
    })
  }

  /** 品牌档案 + 我们自己的域名（档案里没写就从 Search Console 的页面地址里认）。 */
  const brandOf = async (pages: readonly SitePage[]): Promise<SeoBrandInfo> => {
    const b = await options.brand()
    if (b.domains.length > 0) return b
    const hosts = new Set<string>()
    for (const p of pages) {
      try {
        hosts.add(new URL(p.url).hostname.replace(/^www\./, '').toLowerCase())
      } catch {
        // 地址坏了就不认它
      }
    }
    return { ...b, domains: [...hosts] }
  }

  const signalOptions = (brand: SeoBrandInfo): SignalOptions => {
    const t = options.thresholds()
    const num = (k: string): number | undefined => (typeof t[k] === 'number' ? t[k] : undefined)
    const ctrPct = num('seo_no_clicks_ctr_pct')
    const o: SignalOptions = {
      brand_terms: [brand.name, ...brand.domains.map((d) => d.split('.')[0] ?? d)].filter(
        (x) => x.trim() !== '',
      ),
    }
    const set = (key: keyof SignalOptions, v: number | undefined): void => {
      if (v !== undefined) (o as unknown as Record<string, number>)[key] = v
    }
    set('min_position', num('seo_position_min'))
    set('max_position', num('seo_position_max'))
    set('no_clicks_impressions', num('seo_no_clicks_impressions'))
    set('no_clicks_ctr', ctrPct === undefined ? undefined : ctrPct / 100)
    set('decay_pct', num('seo_decay_pct'))
    set('ai_mode_words', num('seo_ai_mode_words'))
    return o
  }

  const provenanceOf = (run_id: string, seen: ObjectRef[]): ProvenanceState => {
    const grouped: Record<string, string[]> = {}
    for (const ref of seen) grouped[ref.type] = [...(grouped[ref.type] ?? []), ref.id]
    // 这几条动作都写着改前必读：目标那一页是从 Search Console 的页面清单里读全的
    // `read_full` 的键是 `<type>:<id>`（`@agentsws/core` 的 `Provenance.hasFull` 按它认）
    return {
      run_id,
      seen: grouped,
      read_full: seen.map((r) => `${r.type}:${r.id}`),
      recorded_at: clock.now(),
    }
  }

  /** 定时那一轮提一条改动（机械第一稿）。 */
  const stageFix = async (
    actor: SeoActor,
    kind: 'page_seo_edit' | 'internal_link_edit',
    target: ObjectRef,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    title: string,
    summary: string,
  ): Promise<string | undefined> => {
    const run_id = `run_seo_${nextId('r')}`
    const { mandate, level } = options.actionOf(actor.assignment_id, `stage_${kind}`)
    const out = await options.ledger.stage({
      workspace_id,
      role_id: actor.role_id,
      assignment_id: actor.assignment_id,
      run_id,
      change_set_id: `cs_${run_id}`,
      kind,
      target,
      before,
      after,
      notes: [],
      created_by: { kind: 'agent', id: `agent_${actor.role_id}` },
      mandate,
      level,
      provenance: provenanceOf(run_id, [target]),
      approval: {
        title,
        summary,
        recipients: [{ person: actor.person_id, via: 'scope_manager' }],
        proposer: {
          kind: 'agent',
          id: `agent_${actor.role_id}`,
          assignment_id: actor.assignment_id,
        },
        rule: 'scope_manager',
        separation_of_duties: false,
        source_events: [],
      },
    })
    return out.ok ? out.approval.id : undefined
  }

  /** 开一件事项（交给别的岗位，或者本职责自己要写的）。同一件事 14 天内不重复开。 */
  const openMatter = (
    key: string,
    input: Parameters<SeoMatterPort['createMatter']>[0],
  ): string | undefined => {
    if (options.work === undefined) return undefined
    const state = loadState()
    const last = state.handed_off?.[key]
    if (
      last !== undefined &&
      Date.parse(clock.now()) - Date.parse(last) < HANDOFF_QUIET_DAYS * DAY_MS
    )
      return undefined
    const matter = options.work.createMatter(input)
    saveState({ ...state, handed_off: { ...(state.handed_off ?? {}), [key]: clock.now() } })
    return matter.id
  }

  const pinOf = (url: string | undefined, page: SitePage | undefined): ObjectRef[] =>
    url === undefined ? [] : [{ type: targetTypeOf(page), id: url }]

  /** 一件 → 落成什么（副作用都在这里）。 */
  const land = async (
    actor: SeoActor,
    pick: SeoPick,
    pages: readonly SitePage[],
  ): Promise<SeoPick['outcome']> => {
    const page = pages.find((p) => p.url === pick.page)
    const evidence = evidenceText(pick.evidence)
    const body = `${pick.suggestion}\n证据：${evidence}`
    switch (pick.lane) {
      case 'fix_page': {
        if (pick.fix === 'page_seo_edit' && pick.page !== undefined) {
          const title = draftTitle(pick.query, page?.title)
          if (title !== undefined) {
            const target = { type: targetTypeOf(page), id: pick.page }
            const id = await stageFix(
              actor,
              'page_seo_edit',
              target,
              { url: pick.page, ...(page?.title === undefined ? {} : { title: page.title }) },
              { title, h1: title, target_query: pick.query },
              `改页面标题与 H1：${page?.title ?? pick.page}`,
              `${body}\n这是机械的第一稿（把查询原样放进标题与 H1）；描述与开头两句可以在卡上改，或者点「指导」让它重写。`,
            )
            return id === undefined
              ? { kind: 'none', note: '这条改动没提上去（额度或门禁）' }
              : { kind: 'change', id }
          }
        }
        if (
          pick.fix === 'internal_link_edit' &&
          pick.link_from !== undefined &&
          pick.page !== undefined
        ) {
          const from = pages.find((p) => p.url === pick.link_from)
          const target = { type: targetTypeOf(from), id: pick.link_from }
          const id = await stageFix(
            actor,
            'internal_link_edit',
            target,
            { url: pick.link_from, ...(from?.title === undefined ? {} : { title: from.title }) },
            { links: [{ to: pick.page, anchor: pick.query }] },
            `调内链：从「${from?.title ?? pick.link_from}」链到卡住的那页`,
            body,
          )
          return id === undefined
            ? { kind: 'none', note: '这条改动没提上去（额度或门禁）' }
            : { kind: 'change', id }
        }
        // 加小节 / 标题已经含查询：要写正文，开一件本职责的事项，写好了走同名动作出卡
        const id = openMatter(`fix|${pick.page ?? ''}|${pick.query}`, {
          kind: 'project',
          title: `改页面：${page?.title ?? pick.page ?? pick.query}（接住「${pick.query}」）`,
          summary: `${body}\n写好之后用「${pick.fix === 'page_section_add' ? '加小节' : '改标题与开头'}」出卡，发出去之前要人点一下。`,
          pinned: pinOf(pick.page, page),
          position_id: actor.assignment_id,
          entry: 'role',
          role_id: 'dtc.content',
          participants: [actor.person_id],
        })
        return id === undefined
          ? { kind: 'none', note: '这件两周内已经开过了' }
          : { kind: 'matter', id }
      }
      case 'new_page': {
        if (pick.serp_check?.right_crowd !== true)
          return { kind: 'none', note: pick.serp_skipped ?? '没看过搜索结果，不出选题卡' }
        const payload: SeoTopicPayload = {
          query: pick.query,
          ...(pick.page === undefined ? {} : { ranking_page: pick.page }),
          evidence: pick.evidence,
          why: pick.suggestion,
          serp: pick.serp_check,
        }
        const item = await options.approvals.create<SeoTopicPayload>({
          workspace_id,
          schema_version: 1,
          kind: 'seo_topic',
          role_id: actor.role_id,
          subject: { object: { type: 'search_query', id: pick.query } },
          dedupe_key: `dk_${workspace_id}|seo_topic|${pick.query.toLowerCase()}`,
          title: `新页面选题：${pick.query}`,
          summary: `${pick.suggestion}\n${pick.serp_check.reason}\n证据：${evidence}\n批了开一件写这一页的事项；发布照每天 2 篇的额度分批发。`,
          payload,
          evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
          proposer: {
            kind: 'agent',
            id: `agent_${actor.role_id}`,
            assignment_id: actor.assignment_id,
          },
          automation: { level_at_creation: 'L1' },
          routing: {
            recipients: [{ person: actor.person_id, via: 'role_holder' }],
            rule: 'role_holder',
            escalation: {
              after_hours: 72,
              business_hours: true,
              chain: ['owner'],
              escalated_at: [],
            },
            separation_of_duties: false,
          },
          priority: 'queue',
        })
        return { kind: 'topic', id: item.id }
      }
      case 'site_handoff': {
        const site = options.holderOf('site.shopify-build')
        const id = openMatter(`site|${pick.page ?? pick.query}`, {
          kind: 'project',
          title: `交建站：${page?.title ?? pick.page ?? pick.query}${INDEX_WORDS[page?.index_status ?? ''] ?? ''}`,
          summary: `内容与搜索每日判断转来：${body}\n需要处理跳转 / 规范网址 / 收录（301 或 308，不用 307），处理完在 Search Console 请求重新收录。`,
          pinned: pinOf(pick.page, page),
          entry: 'position',
          position_template_id: 'site',
          role_id: 'site.shopify-build',
          ...(site === undefined
            ? {}
            : { position_id: site.assignment_id, participants: [site.person_id] }),
        })
        return id === undefined
          ? { kind: 'none', note: '这件两周内已经交过建站了' }
          : { kind: 'matter', id }
      }
      case 'pr_handoff': {
        const pr = options.holderOf('pr.forums') ?? options.holderOf('pr.reddit')
        const id = openMatter(`pr|${pick.query}`, {
          kind: 'project',
          title: `交公关：让站外提到「${pick.query}」`,
          summary: `内容与搜索每日判断转来：${body}\n需要的是站外被提及（Reddit / 论坛 / 评测 / 新闻稿），链接指向 ${pick.page ?? '我们的相关页面'}。`,
          pinned: pinOf(pick.page, page),
          entry: 'position',
          position_template_id: 'pr',
          ...(pr === undefined
            ? {}
            : { position_id: pr.assignment_id, participants: [pr.person_id] }),
        })
        return id === undefined
          ? { kind: 'none', note: '这件两周内已经交过公关了' }
          : { kind: 'matter', id }
      }
    }
  }

  /** 出一张搜索报告卡（L3 自动出、看完归档；不进队列）。 */
  const report = async <P>(
    actor: SeoActor,
    variant: string,
    key: string,
    title: string,
    summary: string,
    payload: P,
  ): Promise<string> => {
    const item = await options.approvals.create<P>({
      workspace_id,
      schema_version: 1,
      kind: 'seo_report',
      role_id: actor.role_id,
      subject: { object: { type: 'workspace', id: workspace_id } },
      dedupe_key: `dk_${workspace_id}|seo_report|${variant}|${key}`,
      title,
      summary,
      payload,
      evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
      proposer: { kind: 'agent', id: `agent_${actor.role_id}`, assignment_id: actor.assignment_id },
      automation: {
        level_at_creation: 'L3',
        auto_approved: true,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: actor.person_id, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'digest',
    })
    return item.id
  }

  /** Search Console 这一跳：没连 = `undefined`；连了但读不到 = 那句人话。 */
  const readConsole = async (): Promise<{
    rows: GscRow[] | undefined
    pages: SitePage[]
    error?: string
  }> => {
    const gsc = options.searchConsole()
    if (!gsc.connected()) return { rows: undefined, pages: [] }
    try {
      const [rows, pages] = await Promise.all([gsc.rows({ end: clock.now() }), gsc.pages()])
      return { rows, pages }
    } catch (err) {
      return { rows: [], pages: [], error: err instanceof Error ? err.message : String(err) }
    }
  }

  const date = (): string => clock.now().slice(0, 10)
  const skipped = '没人持有「内容与搜索」这条职责，这一轮不跑'

  return {
    async daily() {
      const actor = options.holderOf('dtc.content')
      if (actor === undefined) return { skipped, picks: 0, changes: 0, topics: 0, matters: 0 }
      const consoleRead = await readConsole()
      const brand = await brandOf(consoleRead.pages)
      const payload: SeoDailyPayload = await buildDaily({
        rows: consoleRead.rows,
        pages: consoleRead.pages,
        signals: signalOptions(brand),
        search: options.searchData(),
        country: brand.country,
        language: brand.language,
        our_domains: brand.domains,
        date: date(),
      })
      if (consoleRead.error !== undefined) payload.notes.unshift(consoleRead.error.slice(0, 160))
      const counts = { changes: 0, topics: 0, matters: 0 }
      for (const pick of payload.picks) {
        const outcome = await land(actor, pick, consoleRead.pages)
        if (outcome !== undefined) pick.outcome = outcome
        if (outcome?.kind === 'change') counts.changes += 1
        if (outcome?.kind === 'topic') counts.topics += 1
        if (outcome?.kind === 'matter') counts.matters += 1
      }
      const summary =
        payload.picks.length === 0
          ? (payload.notes[0] ?? '今天没有值得动的')
          : payload.picks.map((p) => `${p.rank}. ${p.query}：${p.suggestion}`).join('\n')
      const approval_item_id = await report(
        actor,
        'daily',
        payload.date,
        `今天值得动的 ${payload.picks.length} 件事（${payload.date}）`,
        summary,
        payload,
      )
      emit('seo.daily_read', actor.assignment_id, {
        date: payload.date,
        gsc: payload.gsc,
        search_data: payload.search_data,
        picks: payload.picks.length,
        ...counts,
      })
      return { approval_item_id, picks: payload.picks.length, ...counts }
    },

    async weeklyRevenue() {
      const actor = options.holderOf('dtc.content')
      if (actor === undefined) return { skipped, rows: 0 }
      const consoleRead = await readConsole()
      const brand = await brandOf(consoleRead.pages)
      const ga4 = (await options.ga4?.()) ?? undefined
      const out = pageRevenue({
        gsc: consoleRead.rows ?? [],
        orders: options.orders(),
        ...(ga4 === undefined ? {} : { ga4 }),
        options: {
          currency: brand.currency,
          shop_host: brand.shop_host,
          ...thresholdPick(options.thresholds()),
        },
      })
      const notes: string[] = []
      if (consoleRead.rows === undefined)
        notes.push('Search Console 还没连：点击那一列是 0，订单与收入照 Shopify 的落地页算。')
      if (ga4 === undefined) notes.push('GA4 没接：没有落地页转化率那一列。')
      if (out.unmatched_orders > 0)
        notes.push(`${out.unmatched_orders} 张订单没有落地页记录，归不上任何一页（照实报，不猜）。`)
      const payload: SeoWeeklyRevenuePayload = {
        variant: 'weekly_revenue',
        week_of: date(),
        rows: out.rows,
        unmatched_orders: out.unmatched_orders,
        ga4: ga4 === undefined ? 'not_connected' : 'connected',
        notes,
      }
      const leaks = out.rows.filter((r) => r.flag === 'leak').length
      const gems = out.rows.filter((r) => r.flag === 'gem').length
      const approval_item_id = await report(
        actor,
        'weekly_revenue',
        payload.week_of,
        `按页面收入小结（${payload.week_of} 那一周）`,
        `${out.rows.length} 页；点击多没订单 ${leaks} 页，点击少出订单 ${gems} 页。`,
        payload,
      )
      emit('seo.weekly_revenue', actor.assignment_id, { rows: out.rows.length, leaks, gems })
      return { approval_item_id, rows: out.rows.length }
    },

    async weeklyGeo() {
      const actor = options.holderOf('dtc.content')
      if (actor === undefined) return { skipped, gaps: 0 }
      const { pages } = await readConsole()
      const brand = await brandOf(pages)
      const questions = await refreshQuestions()
      const enabled = questions.filter((q) => q.enabled).slice(0, MAX_GEO_QUESTIONS)
      const search = options.searchData()
      const status = await search.status()
      const notes: string[] = []
      const rows: SeoWeeklyGeoPayload['rows'] = []
      if (!status.configured) notes.push('搜索数据接口还没接，这周没有探测各 AI 平台。')
      else {
        for (const q of enabled) {
          try {
            const answers = await search.aiAnswers({
              question: q.text,
              platforms: [...GEO_PLATFORMS],
              country: brand.country,
              language: brand.language,
              brand: { name: brand.name, domains: brand.domains },
            })
            rows.push(...probeRows(q.text, answers))
          } catch (err) {
            notes.push(
              `「${q.text}」这一问没查到（${(err instanceof Error ? err.message : String(err)).slice(0, 60)}）`,
            )
          }
        }
      }
      const gaps = geoGaps(rows, pages, brand.domains)
      const payload: SeoWeeklyGeoPayload = {
        variant: 'weekly_geo',
        week_of: date(),
        search_data: status.configured ? 'configured' : 'not_configured',
        questions: enabled.length,
        rows,
        gaps,
        notes,
      }
      // 缺位里「交公关」的那几条合成一件交给公关的事项
      const toPr = gaps.filter((g) => g.lane === 'pr_handoff')
      if (toPr.length > 0) {
        const pr = options.holderOf('pr.forums') ?? options.holderOf('pr.reddit')
        openMatter(`geo_pr|${payload.week_of}`, {
          kind: 'project',
          title: `交公关：AI 回答里缺我们（${toPr.length} 个问题）`,
          summary: toPr.map((g) => `「${g.question}」：${g.suggestion}`).join('\n'),
          entry: 'position',
          position_template_id: 'pr',
          ...(pr === undefined
            ? {}
            : { position_id: pr.assignment_id, participants: [pr.person_id] }),
        })
      }
      // 站点门面（llms.txt / 结构化数据 / AI 爬虫）开一次交给建站的事项
      const state = loadState()
      if (state.facade_matter_id === undefined && options.work !== undefined) {
        const site = options.holderOf('site.shopify-build')
        const m = options.work.createMatter({
          kind: 'project',
          title: '交建站：让 AI 读得懂我们的网站（llms.txt / 结构化数据 / AI 爬虫）',
          summary: SITE_FACADE_NOTE,
          entry: 'position',
          position_template_id: 'site',
          role_id: 'site.shopify-build',
          ...(site === undefined
            ? {}
            : { position_id: site.assignment_id, participants: [site.person_id] }),
        })
        saveState({ ...loadState(), facade_matter_id: m.id })
      }
      const seen = new Set(
        rows.filter((r) => r.brand_mentioned || r.our_domain_cited).map((r) => r.question),
      )
      const approval_item_id = await report(
        actor,
        'weekly_geo',
        payload.week_of,
        `AI 平台可见度（${payload.week_of} 那一周）`,
        status.configured
          ? `${enabled.length} 个买家问题，${seen.size} 个在某个平台上提到或引用了我们；缺位 ${gaps.length} 个。`
          : (notes[0] ?? ''),
        payload,
      )
      emit('seo.weekly_geo', actor.assignment_id, {
        questions: enabled.length,
        probed: rows.length,
        gaps: gaps.length,
        search_data: payload.search_data,
      })
      return { approval_item_id, gaps: gaps.length }
    },

    geoQuestions: () => refreshQuestions(),

    setGeoQuestions(list) {
      // 人在面板上改过的一律记成 `human`（下一次自动生成不会覆盖它）
      const clean = list
        .map((q) => ({ ...q, text: q.text.trim() }))
        .filter((q) => q.text !== '')
        .map((q) => ({ ...q, origin: 'human' as const }))
      saveState({ ...loadState(), geo_questions: clean })
      return clean
    },

    async gatePublish(input) {
      const after = rec(input.after)
      if (input.kind !== 'publish_post' || after.published !== true) return input
      const body = typeof after.body === 'string' ? after.body : ''
      const title = typeof after.title === 'string' ? after.title : undefined
      if (body.trim() === '' && title === undefined) return input
      const actor: SeoActor = {
        workspace_id,
        person_id: input.created_by.id,
        assignment_id: input.assignment_id,
        role_id: input.role_id,
      }
      const kb = (await options.knowledge?.(actor)) ?? { facts: [], rules: [] }
      const result = checkContentQuality({
        body,
        ...(title === undefined ? {} : { title }),
        facts: kb.facts,
        ...(kb.rules.length === 0 ? {} : { rules: kb.rules }),
        now: clock.now(),
      })
      emit('content.quality_checked', input.assignment_id, {
        target: input.target.id,
        passed: result.passed,
        issues: result.issues.length,
        rules_from: result.rules_from,
      })
      if (result.passed) return { ...input, after: { ...after, quality_gate: result } }
      return {
        ...input,
        after: { ...after, published: false, quality_gate: result },
        // 挡在草稿、而且一定要人看到这张卡（草稿本来是 L2 自动的）
        level: 'L1',
        notes: [
          ...(input.notes ?? []),
          ...result.issues.map((i) => `「${i.sentence}」——${i.detail}`),
        ],
        approval: {
          ...input.approval,
          title: `没过质检，先留在草稿：${title ?? input.target.id}`,
          summary: qualitySummary(result),
        },
      }
    },

    async onDecided(item) {
      if (item.kind !== 'seo_topic' || item.workspace_id !== workspace_id) return
      if (item.state !== 'approved' && item.state !== 'approved_edited') return
      const p = item.payload as SeoTopicPayload
      const actor = options.holderOf('dtc.content')
      openMatter(`topic|${p.query}`, {
        kind: 'project',
        title: `写一页新的：${p.query}`,
        summary: `${p.why}\n${p.serp.reason}\n写好后发布照每天 2 篇的额度分批发；发布前自动质检。${p.ranking_page === undefined ? '' : `\n发出去之后从 ${p.ranking_page} 链过来。`}`,
        entry: 'role',
        role_id: 'dtc.content',
        ...(actor === undefined
          ? {}
          : { position_id: actor.assignment_id, participants: [actor.person_id] }),
      })
    },
  }

  async function refreshQuestions(): Promise<GeoQuestion[]> {
    const state = loadState()
    const { rows } = await readConsole()
    const top = [...(rows ?? [])]
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 30)
      .map((r) => r.query)
    const brand = await options.brand()
    const list = generateGeoQuestions({
      brand,
      top_queries: top,
      ...(state.geo_questions === undefined ? {} : { existing: state.geo_questions }),
    })
    saveState({ ...state, geo_questions: list })
    return list
  }
}

function thresholdPick(t: Record<string, number>): {
  leak_min_clicks?: number
  gem_max_clicks?: number
} {
  return {
    ...(typeof t.seo_leak_min_clicks === 'number'
      ? { leak_min_clicks: t.seo_leak_min_clicks }
      : {}),
    ...(typeof t.seo_gem_max_clicks === 'number' ? { gem_max_clicks: t.seo_gem_max_clicks } : {}),
  }
}
