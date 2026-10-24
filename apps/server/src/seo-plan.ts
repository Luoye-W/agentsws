/**
 * WP450（docs/109 §5.2 #9–11、17）：SEO 第二批的**副作用**那一层（每个品牌一份）——主题簇与编辑日历、外链体检、llms.txt、
 * 改写成社媒稿。判断全在 `@agentsws/seo-core`（纯函数：`cluster` / `backlinks` / `llms-txt` / `repurpose`）；这里只取数、出卡、
 * 开事项、落盘。本文件不打一跳网络——搜索数据、官方数据接口、模型、网站结构都是注入的。
 *
 * 1. **主题簇**（`dtc.seo` 出规划）：候选词 = Search Console 非品牌词 + 品牌档案的品类词 + 品类词搜索结果里的「大家还问」；
 *    能查关键词概况就补上量；按量取前 20 个查搜索结果，按重叠度分组（规则算）→ 一张 `seo_cluster` 卡批整组。
 *    **按需跑**（第三栏「出一组」、带估算）：查搜索结果要花积分，不在后台自己花。
 * 2. **编辑日历**：批了按每天 2 篇（「内容与博客」发布额度同一个数）排进日历；每天早上那一轮把到日子的那几篇各开一件写作事项，
 *    派给内容与博客的担当人（没人担派回 SEO 与 GEO 自己）。日历在第三栏，不做中栏整页（决策 1765）。
 * 3. **外链体检**（每月一次，可关）：读云上外链概况与外链行（我们 + 竞品），规则看变化、锚文本、可疑来源；竞品差距 Top 10 交公关。
 *    花费照官方数据接口的价目在面板上写明；用户看得到的字里不提数据从哪来。
 * 4. **llms.txt**：按网站结构（站点地图 + 品牌档案）生成一份，交建站（主题那一条）放上去；放法见 `LLMS_PLACEMENT_ZH`。
 * 5. **改写成社媒稿**：一篇已发布的文章一键起草 X / LinkedIn / Reddit / 短视频脚本——模型写得到用模型，写不到按规则拼；
 *    一律过「不编经历与数字」那一道；每个渠道给担那条社媒职责的人开一件事项，**只起草，不发**。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ApprovalBus,
  ApprovalItem,
  BacklinkAuditRun,
  BacklinkAuditSettings,
  BacklinkAuditView,
  BacklinkRow,
  Clock,
  DataCallResult,
  DataCapabilityList,
  LlmsTxtCheck,
  LlmsTxtDraft,
  LlmsTxtView,
  RepurposeChannel,
  RepurposeDraft,
  RepurposeResult,
  RoleId,
  SearchDataPort,
  SeoCalendarEntry,
  SeoCalendarView,
  SeoCluster,
  SeoClusterKeyword,
  SeoClusterPayload,
  SeoClusterPlanEstimate,
  SeoClusterPlanResult,
  SeoPublishedPost,
  SeoRefreshItem,
  WorkspaceId,
} from '@agentsws/contracts'
import { REPURPOSE_CHANNELS } from '@agentsws/contracts'
import {
  addDays,
  auditBacklinks,
  backlinkGapBrief,
  backlinkRowsOf,
  backlinkSummaryOf,
  buildLlmsTxt,
  clusterBrief,
  isBrandQuery,
  keywordIntent,
  LLMS_PLACEMENT_ZH,
  type LlmsStructure,
  llmsStructureFromUrls,
  MAX_CLUSTER_SERP,
  normalizeQuery,
  planClusters,
  REPURPOSE_CHANNEL_ZH,
  type RepurposeArticle,
  repurposeFromModel,
  repurposePrompt,
  repurposeRules,
  type SearchConsolePort,
  scheduleCluster,
} from '@agentsws/seo-core'
import {
  CONTENT_ROLE,
  SEO_ROLE,
  type SeoActor,
  type SeoBrandInfo,
  type SeoDraftModel,
  type SeoMatterPort,
  topicWriter,
} from './seo-service.js'

/** 官方数据接口那一口（`createDataService` 的子集）。 */
export interface SeoPlanDataPort {
  capabilities(): Promise<DataCapabilityList>
  call(
    capability: string,
    input: { input: Record<string, unknown>; fresh?: boolean },
  ): Promise<DataCallResult>
}

export interface SeoPlanOptions {
  workspace_id: WorkspaceId
  clock: Clock
  approvals: ApprovalBus
  holderOf(role_id: RoleId): SeoActor | undefined
  work?: SeoMatterPort
  searchConsole(): SearchConsolePort
  searchData(): SearchDataPort
  /** 官方数据接口（关键词概况、外链）；没关联账号时它自己抛「没配」。 */
  dataService?(): SeoPlanDataPort | undefined
  brand(): SeoBrandInfo | Promise<SeoBrandInfo>
  /** 比外链用的竞品域名（关注设置里的竞品）。 */
  competitors?(): Promise<string[]>
  /** 「哪篇该回头改」：每日判断里在掉的页（seo-service 记的）。 */
  refreshCandidates?(): SeoRefreshItem[]
  /** 最近发布的文章（账本里施行了的 `publish_post`，`published: true`）。 */
  publishedPosts?(): Promise<(SeoPublishedPost & { body?: string })[]>
  /** 写社媒稿的模型口（每次现取；没配回 `undefined`，用规则版）。 */
  drafter?(meta: { actor: SeoActor; run_id: string }): SeoDraftModel | undefined
  /** 网站结构（llms.txt 用：站点地图里的地址 + 网站）；读不到回 `undefined`。 */
  siteUrls?(): Promise<{ origin: string; urls: string[] } | undefined>
  /** 体检里最近一次「llms.txt」那一项。 */
  llmsLive?(): LlmsTxtCheck | undefined
  /** 每天最多几篇（「内容与博客」发布额度）；缺省 2。 */
  perDay?(): number
  event?(type: string, payload: Record<string, unknown>): void
  dir?: string
}

export interface SeoPlanAssembly {
  planEstimate(): Promise<SeoClusterPlanEstimate>
  /** 出一组主题（出卡）。 */
  planClusters(): Promise<SeoClusterPlanResult>
  calendarView(): Promise<SeoCalendarView>
  /** 每天早上那一轮：到日子的开写作事项。回开了几件。 */
  tickCalendar(): Promise<{ opened: number }>
  /** 卡被决定之后（主题簇批了 → 排进日历）。 */
  onDecided(item: ApprovalItem): Promise<void>
  backlinkView(): Promise<BacklinkAuditView>
  setBacklinkSettings(patch: Partial<BacklinkAuditSettings>): Promise<BacklinkAuditView>
  /** 现在体检一次外链（`manual`）。 */
  backlinkAudit(trigger?: 'scheduled' | 'manual'): Promise<BacklinkAuditRun>
  /** 每天早上看一眼到没到期（每月一次；关了不跑）。 */
  backlinkDue(): Promise<BacklinkAuditRun | undefined>
  llmsView(): Promise<LlmsTxtView>
  /** 生成一份 llms.txt；`handoff: true` 交建站放上去。 */
  llmsGenerate(input?: { handoff?: boolean }): Promise<LlmsTxtView>
  /** 一篇已发布的文章一键起草社媒稿，开事项交社媒运营。 */
  repurpose(input: {
    change_id?: string
    title?: string
    body?: string
    url?: string
    channels?: RepurposeChannel[]
  }): Promise<RepurposeResult>
}

interface PlanState {
  calendar?: SeoCalendarEntry[]
  clusters?: { cluster: SeoCluster; approved_at: string }[]
  pending?: { approval_item_id: string; topic: string }[]
  backlinks?: { settings?: BacklinkAuditSettings; runs?: BacklinkAuditRun[] }
  llms?: { draft?: LlmsTxtDraft; handed_to_site?: { matter_id: string; at: string } }
  repurposed?: Record<string, { at: string; matters: string[] }>
}

const STATE_FILE = 'seo-plan.json'
const DAY_MS = 86_400_000
/** 外链体检缺省每几天一次。 */
export const BACKLINK_EVERY_DAYS = 30
const KEEP_BACKLINK_RUNS = 12
/** 比几家竞品（每家一次外链行，花费按次算）。 */
export const BACKLINK_MAX_COMPETITORS = 3
/** 日历文章发了多少天以后提「回头改」。 */
const REFRESH_AFTER_DAYS = 180

/** 改写成社媒稿：每个渠道交给哪条职责（按顺序找第一个有人担的）。 */
export const REPURPOSE_ROLES: Record<RepurposeChannel, readonly RoleId[]> = {
  x: ['social.x'] as RoleId[],
  linkedin: ['social.linkedin'] as RoleId[],
  reddit: ['social.reddit', 'pr.reddit'] as RoleId[],
  short_video: ['social.tiktok', 'social.youtube', 'social.instagram'] as RoleId[],
}

/** 外链差距交给谁（站外提及归公关）。 */
const PR_ROLES = ['pr.press', 'pr.forums', 'pr.reddit'] as RoleId[]
/** llms.txt 交给谁（主题模板那一条；没人担交整站搭建）。 */
const SITE_ROLES = ['site.shopify-theme', 'site.shopify-build'] as RoleId[]

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

export function createSeoPlan(options: SeoPlanOptions): SeoPlanAssembly {
  const { clock, workspace_id } = options
  let memory: PlanState = {}
  const file = options.dir === undefined ? undefined : join(options.dir, STATE_FILE)
  const load = (): PlanState => {
    if (file === undefined) return memory
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as PlanState
    } catch {
      return {}
    }
  }
  const save = (next: PlanState): void => {
    memory = next
    if (file !== undefined) writeFileSync(file, JSON.stringify(next, null, 2))
  }
  const today = (): string => clock.now().slice(0, 10)
  const perDay = (): number => Math.max(1, Math.floor(options.perDay?.() ?? 2))
  const holder = (roles: readonly RoleId[]): { role_id: RoleId; actor: SeoActor } | undefined => {
    for (const r of roles) {
      const actor = options.holderOf(r)
      if (actor !== undefined) return { role_id: r, actor }
    }
    return undefined
  }
  const emit = (type: string, payload: Record<string, unknown>): void => {
    try {
      options.event?.(type, payload)
    } catch {
      // 记事件失败不挡正事
    }
  }
  const openMatter = (input: {
    title: string
    summary: string
    role_id: RoleId
    actor?: SeoActor
  }): string | undefined => {
    if (options.work === undefined) return undefined
    return options.work.createMatter({
      kind: 'project',
      title: input.title,
      summary: input.summary,
      entry: 'role',
      role_id: input.role_id,
      ...(input.actor === undefined
        ? {}
        : { position_id: input.actor.assignment_id, participants: [input.actor.person_id] }),
    }).id
  }

  /* ── 主题簇 ─────────────────────────────────────────────────────── */

  const serpPrice = async (): Promise<{ ok: boolean; reason?: string; price: number }> => {
    try {
      const s = await options.searchData().status()
      if (!s.configured)
        return {
          ok: false,
          reason: s.reason ?? '搜索数据接口还没接上，按搜索结果分组要它',
          price: 0,
        }
      return { ok: true, price: s.prices?.serp ?? 0 }
    } catch {
      return { ok: false, reason: '这会儿查不了搜索数据接口，稍后再试', price: 0 }
    }
  }

  const planEstimate = async (): Promise<SeoClusterPlanEstimate> => {
    if (options.holderOf(SEO_ROLE) === undefined)
      return {
        available: false,
        reason: '没人持有「SEO 与 GEO」这条职责',
        serp_calls: 0,
        credits: 0,
      }
    const p = await serpPrice()
    // 最多查 20 个词 + 品类词那一次
    const calls = MAX_CLUSTER_SERP + 1
    return {
      available: p.ok,
      ...(p.reason === undefined ? {} : { reason: p.reason }),
      serp_calls: calls,
      credits: Math.round(calls * p.price * 100) / 100,
    }
  }

  const candidates = async (
    brand: SeoBrandInfo,
    cost: { credits: number; calls: number },
    notes: string[],
  ): Promise<SeoClusterKeyword[]> => {
    const terms = [brand.name, ...brand.domains.map((d) => d.split('.')[0] ?? '')].filter(
      (t) => t.trim() !== '',
    )
    const out = new Map<string, SeoClusterKeyword>()
    const add = (k: SeoClusterKeyword): void => {
      const key = normalizeQuery(k.keyword)
      if (key === '' || key.length > 80 || isBrandQuery(key, terms)) return
      const cur = out.get(key)
      out.set(key, cur === undefined ? { ...k, keyword: key } : { ...cur, ...k, keyword: key })
    }
    // ① Search Console：近 7 天非品牌词（按曝光），点击最多的那页记成「已经排上」
    const gsc = options.searchConsole()
    if (gsc.connected()) {
      try {
        const rows = await gsc.rows({ end: clock.now() })
        const byQ = new Map<
          string,
          { impressions: number; clicks: number; page: string; best: number }
        >()
        for (const r of rows) {
          const q = normalizeQuery(r.query)
          const cur = byQ.get(q) ?? { impressions: 0, clicks: 0, page: r.page, best: -1 }
          cur.impressions += r.impressions
          cur.clicks += r.clicks
          if (r.clicks > cur.best) {
            cur.best = r.clicks
            cur.page = r.page
          }
          byQ.set(q, cur)
        }
        const ranked = [...byQ.entries()]
          .sort((a, b) => b[1].impressions - a[1].impressions)
          .slice(0, 25)
        for (const [q, v] of ranked)
          add({
            keyword: q,
            intent: keywordIntent(q, terms),
            impressions: v.impressions,
            clicks: v.clicks,
            ...(v.clicks > 0 && v.best > 0 ? { ranking_page: v.page } : {}),
            from: 'search_console',
          })
      } catch {
        notes.push('这次没读到 Search Console，候选词只从品类来')
      }
    } else notes.push('Search Console 没连：候选词只从品类来，接上后能把已经排上的词一起算进来')
    // ② 品类词 + 它的搜索结果里「大家还问」
    const seed = (brand.subcategory ?? brand.category ?? '').trim()
    if (seed !== '') {
      add({ keyword: seed, intent: 'unknown', from: 'brand' })
      try {
        const r = await options.searchData().serp({
          query: seed,
          engine: 'google',
          country: brand.country,
          language: brand.language,
        })
        cost.calls += 1
        cost.credits += r.credits ?? 0
        for (const q of r.people_also_ask ?? [])
          add({ keyword: q, intent: 'unknown', from: 'related' })
      } catch {
        notes.push('品类词的搜索结果这次没查到')
      }
    }
    // ③ 关键词概况（量 / 意图；估算）——查得到才补，查不到照样分组
    const list = [...out.values()]
    const data = options.dataService?.()
    if (data !== undefined && list.length > 0) {
      try {
        const r = await data.call('seo.keyword_overview', {
          input: {
            keywords: list.slice(0, 100).map((k) => k.keyword),
            country: brand.country,
            language: brand.language,
          },
        })
        cost.calls += 1
        cost.credits += r.credits
        for (const it of r.items) {
          const key = normalizeQuery(String(it.keyword ?? ''))
          const k = out.get(key)
          if (k === undefined) continue
          const v = num(it.search_volume)
          const intent = String(it.search_intent ?? '')
          out.set(key, {
            ...k,
            ...(v === undefined ? {} : { volume: v }),
            ...(['informational', 'commercial', 'transactional', 'navigational'].includes(intent)
              ? { intent: intent as SeoClusterKeyword['intent'] }
              : {}),
          })
        }
      } catch {
        notes.push('关键词概况这次没查到，按曝光排先后')
      }
    }
    return [...out.values()]
  }

  const planNow = async (): Promise<SeoClusterPlanResult> => {
    const cost = { credits: 0, calls: 0 }
    const notes: string[] = []
    const actor = options.holderOf(SEO_ROLE)
    if (actor === undefined) return { skipped: '没人持有「SEO 与 GEO」这条职责', cost, notes }
    const p = await serpPrice()
    if (!p.ok) return { skipped: p.reason ?? '搜索数据接口没接上', cost, notes }
    const brand = await options.brand()
    const pool = await candidates(brand, cost, notes)
    const strength = (k: SeoClusterKeyword): number => k.volume ?? k.impressions ?? 0
    const top = [...pool].sort((a, b) => strength(b) - strength(a)).slice(0, MAX_CLUSTER_SERP)
    if (top.length < 3) return { skipped: '候选词不到 3 个，凑不成一组', cost, notes }
    const serps = new Map<string, string[]>()
    for (const k of top) {
      try {
        const r = await options.searchData().serp({
          query: k.keyword,
          engine: 'google',
          country: brand.country,
          language: brand.language,
        })
        cost.calls += 1
        cost.credits += r.credits ?? 0
        serps.set(
          k.keyword,
          r.items
            .filter((i) => i.type === 'organic')
            .slice(0, 10)
            .map((i) => i.url),
        )
      } catch {
        // 这个词没查到：分组时照实排除
      }
    }
    cost.credits = Math.round(cost.credits * 100) / 100
    const state = load()
    const plan = planClusters({
      keywords: top,
      serps,
      brand_terms: [brand.name],
      id: `cl_${today().replaceAll('-', '')}_${String((state.clusters?.length ?? 0) + (state.pending?.length ?? 0) + 1)}`,
    })
    // 已经在日历里的词不再出
    const planned = new Set((state.calendar ?? []).map((e) => normalizeQuery(e.keyword)))
    const cluster = plan.clusters.find((c) => !planned.has(normalizeQuery(c.pillar.keyword)))
    if (cluster === undefined)
      return {
        skipped:
          plan.clusters.length === 0
            ? '这些词的搜索结果重叠太少，凑不成一组（一组至少一篇总页 + 两篇分页）'
            : '能凑成的那组已经在日历里了',
        cost,
        notes,
      }
    const writer = topicWriter(options.holderOf)
    const start = addDays(today(), 1)
    const payload: SeoClusterPayload = {
      form: 'seo_cluster',
      cluster,
      per_day: perDay(),
      start,
      schedule: scheduleCluster(cluster, { start, per_day: perDay(), taken: takenDays(state) }),
      cost,
      writer:
        writer.actor === undefined ? 'none' : writer.role_id === CONTENT_ROLE ? 'content' : 'seo',
    }
    const n = 1 + cluster.spokes.length
    const item = await options.approvals.create<SeoClusterPayload>({
      workspace_id,
      schema_version: 1,
      kind: 'seo_cluster',
      role_id: actor.role_id,
      subject: { object: { type: 'search_query', id: cluster.topic } },
      dedupe_key: `dk_${workspace_id}|seo_cluster|${cluster.topic}`,
      title: `一组主题：${cluster.topic}（${String(n)} 篇）`,
      summary: [
        `一篇总页 + ${String(cluster.spokes.length)} 篇分页，按搜索结果重叠度分的组（谁和谁前 10 名重叠得多就归一组）。`,
        `批了按每天 ${String(perDay())} 篇排进编辑日历，到日子给${
          payload.writer === 'content'
            ? '「内容与博客」'
            : payload.writer === 'seo'
              ? '你'
              : '写的人'
        }开一件写作事项；发布照旧每篇过质检。`,
        cost.credits > 0
          ? `这次规划查了 ${String(cost.calls)} 次搜索数据，约 ${String(cost.credits)} 积分。`
          : '',
      ]
        .filter((x) => x !== '')
        .join('\n'),
      payload,
      evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
      proposer: { kind: 'agent', id: `agent_${actor.role_id}`, assignment_id: actor.assignment_id },
      automation: { level_at_creation: 'L1' },
      routing: {
        recipients: [{ person: actor.person_id, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 72, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    })
    const next = load()
    save({
      ...next,
      pending: [
        ...(next.pending ?? []).filter((x) => x.approval_item_id !== item.id),
        { approval_item_id: item.id, topic: cluster.topic },
      ],
    })
    emit('seo.cluster_planned', {
      approval_item_id: item.id,
      topic: cluster.topic,
      posts: n,
      credits: cost.credits,
    })
    return { approval_item_id: item.id, cluster, cost, notes }
  }

  const takenDays = (state: PlanState): Map<string, number> => {
    const m = new Map<string, number>()
    for (const e of state.calendar ?? [])
      if (e.status !== 'skipped') m.set(e.date, (m.get(e.date) ?? 0) + 1)
    return m
  }

  const approveCluster = (item: ApprovalItem): void => {
    const base = item.payload as SeoClusterPayload
    const edited = item.state === 'approved_edited' ? item.decision?.edited_payload : undefined
    const p = (
      edited !== null &&
      typeof edited === 'object' &&
      (edited as { form?: unknown }).form === 'seo_cluster'
        ? edited
        : base
    ) as SeoClusterPayload
    const state = load()
    if ((state.clusters ?? []).some((c) => c.cluster.id === p.cluster.id)) return
    // 批的那天往后顺（卡可能放了几天才批）
    const start = addDays(today(), 1) > p.start ? addDays(today(), 1) : p.start
    const schedule = scheduleCluster(p.cluster, {
      start,
      per_day: perDay(),
      taken: takenDays(state),
    })
    const posts = [p.cluster.pillar, ...p.cluster.spokes]
    const entries: SeoCalendarEntry[] = schedule.flatMap((s) => {
      const post = posts.find((x) => x.id === s.post_id)
      if (post === undefined) return []
      return [
        {
          id: `${p.cluster.id}:${post.id}`,
          cluster_id: p.cluster.id,
          cluster_topic: p.cluster.topic,
          post_id: post.id,
          role: post.role,
          keyword: post.keyword,
          title: post.title,
          kind: post.kind,
          ...(post.existing_page === undefined ? {} : { existing_page: post.existing_page }),
          date: s.date,
          status: 'scheduled' as const,
          links: p.cluster.links.filter((l) => l.from === post.id),
        },
      ]
    })
    save({
      ...state,
      calendar: [...(state.calendar ?? []), ...entries],
      clusters: [...(state.clusters ?? []), { cluster: p.cluster, approved_at: clock.now() }],
      pending: (state.pending ?? []).filter((x) => x.approval_item_id !== item.id),
    })
    emit('seo.cluster_scheduled', { cluster_id: p.cluster.id, posts: entries.length })
  }

  const tickCalendar = async (): Promise<{ opened: number }> => {
    const state = load()
    const due = (state.calendar ?? []).filter((e) => e.status === 'scheduled' && e.date <= today())
    if (due.length === 0 || options.work === undefined) return { opened: 0 }
    const writer = topicWriter(options.holderOf)
    const clusters = new Map((state.clusters ?? []).map((c) => [c.cluster.id, c.cluster]))
    let opened = 0
    const calendar = (state.calendar ?? []).map((e) => {
      if (!due.includes(e)) return e
      const cluster = clusters.get(e.cluster_id)
      const post =
        cluster === undefined
          ? undefined
          : [cluster.pillar, ...cluster.spokes].find((x) => x.id === e.post_id)
      const lines =
        cluster === undefined || post === undefined
          ? [`主攻的词：${e.keyword}`]
          : clusterBrief(cluster, post)
      const id = openMatter({
        title: `${e.kind === 'refresh' ? '回头改' : '写'}「${e.title}」（编辑日历 ${e.date}）`,
        summary: [...lines, '写好后发布照每天 2 篇的额度分批发；发布前自动质检。'].join('\n'),
        role_id: writer.role_id,
        ...(writer.actor === undefined ? {} : { actor: writer.actor }),
      })
      if (id === undefined) return e
      opened += 1
      return { ...e, status: 'opened' as const, matter_id: id, opened_at: clock.now() }
    })
    save({ ...state, calendar })
    if (opened > 0) emit('seo.calendar_opened', { opened, date: today() })
    return { opened }
  }

  const published = async (): Promise<(SeoPublishedPost & { body?: string })[]> => {
    try {
      return (await options.publishedPosts?.()) ?? []
    } catch {
      return []
    }
  }

  const calendarView = async (): Promise<SeoCalendarView> => {
    const state = load()
    const posts = await published()
    // 已发布：开写之后发出来、标题里有这篇的词的那篇（按标题认，认不出照旧「已开写」）
    const calendar = (state.calendar ?? []).map((e) => {
      // 只认开写之后发出来的那篇（开写之前就有的同名文章不算）
      if (e.status !== 'opened' || e.opened_at === undefined) return e
      const opened = e.opened_at
      const hit = posts.find(
        (p) =>
          p.published_at >= opened && normalizeQuery(p.title).includes(normalizeQuery(e.keyword)),
      )
      return hit === undefined
        ? e
        : {
            ...e,
            status: 'published' as const,
            published_at: hit.published_at,
            ...(hit.url === undefined ? {} : { url: hit.url }),
          }
    })
    if (calendar.some((e, i) => e.status !== (state.calendar ?? [])[i]?.status))
      save({ ...state, calendar })
    const from = addDays(today(), -7)
    const to = addDays(today(), 28)
    const refresh: SeoRefreshItem[] = [
      ...(options.refreshCandidates?.() ?? []),
      ...calendar
        .filter(
          (e) =>
            e.status === 'published' &&
            e.published_at !== undefined &&
            Date.parse(clock.now()) - Date.parse(e.published_at) > REFRESH_AFTER_DAYS * DAY_MS,
        )
        .map((e) => ({
          page: e.url ?? e.title,
          query: e.keyword,
          reason: `发了半年多（${e.published_at?.slice(0, 10) ?? ''}），回头看一眼数字和链接还对不对`,
          ...(e.published_at === undefined ? {} : { since: e.published_at }),
        })),
    ].slice(0, 8)
    return {
      today: today(),
      per_day: perDay(),
      entries: calendar.filter((e) => e.date >= from && e.date <= to),
      refresh,
      published: posts.slice(0, 8).map(({ body: _body, ...p }) => {
        const r = state.repurposed?.[p.change_id]
        return r === undefined ? p : { ...p, repurposed_at: r.at, repurpose_matters: r.matters }
      }),
      clusters: (state.clusters ?? []).map(({ cluster }) => {
        const mine = calendar.filter((e) => e.cluster_id === cluster.id)
        return {
          id: cluster.id,
          topic: cluster.topic,
          total: mine.length,
          published: mine.filter((e) => e.status === 'published').length,
        }
      }),
      plan: await planEstimate(),
      ...((state.pending ?? []).length === 0 ? {} : { pending: state.pending }),
    }
  }

  /* ── 外链体检 ─────────────────────────────────────────────────── */

  const backlinkSettings = (state: PlanState): BacklinkAuditSettings => ({
    enabled: true,
    every_days: BACKLINK_EVERY_DAYS,
    ...(state.backlinks?.settings ?? {}),
  })

  const competitorDomains = async (settings: BacklinkAuditSettings): Promise<string[]> => {
    const list =
      settings.competitors ?? (await options.competitors?.().catch(() => [] as string[])) ?? []
    return [...new Set(list.map((d) => d.trim().toLowerCase()).filter((d) => d !== ''))].slice(
      0,
      BACKLINK_MAX_COMPETITORS,
    )
  }

  const backlinkView = async (): Promise<BacklinkAuditView> => {
    const state = load()
    const settings = backlinkSettings(state)
    const last = state.backlinks?.runs?.[0]
    const comps = await competitorDomains(settings)
    const calls = 2 + comps.length
    const data = options.dataService?.()
    let credits: number | undefined
    let available = data !== undefined
    let reason: string | undefined =
      data === undefined ? '先关联「Agents 工坊官方数据接口」' : undefined
    if (data !== undefined)
      try {
        const caps = await data.capabilities()
        const price = (id: string): number | undefined =>
          caps.capabilities.find((c) => c.id === id && c.available)?.credits_per_unit
        const summary = price('seo.backlink_summary')
        const rows = price('seo.backlinks')
        if (summary === undefined) {
          available = false
          reason = '外链概况这项数据还没开通'
        } else credits = summary + (rows === undefined ? 0 : rows * 100 * (1 + comps.length))
      } catch (err) {
        available = false
        reason = err instanceof Error ? err.message.slice(0, 120) : '这会儿查不了价目'
      }
    const base = last?.at ?? undefined
    return {
      settings,
      ...(last === undefined ? {} : { last }),
      ...(settings.enabled
        ? {
            next_due:
              base === undefined ? today() : addDays(base.slice(0, 10), settings.every_days),
          }
        : {}),
      estimate:
        credits === undefined
          ? { calls, unknown: true }
          : { credits: Math.round(credits * 100) / 100, calls },
      available,
      ...(reason === undefined ? {} : { reason }),
    }
  }

  const backlinkAudit = async (
    trigger: 'scheduled' | 'manual' = 'manual',
  ): Promise<BacklinkAuditRun> => {
    const state = load()
    const settings = backlinkSettings(state)
    const brand = await options.brand()
    const ourDomain = brand.domains[0] ?? brand.shop_host
    const runId = `bl_${Date.parse(clock.now()).toString(36)}`
    const notes: string[] = []
    const cost = { credits: 0, calls: 0 }
    const prev = state.backlinks?.runs?.[0]
    const run: BacklinkAuditRun = {
      id: runId,
      at: clock.now(),
      status: 'ok',
      trigger,
      anchors: [],
      suspicious: [],
      issues: [],
      gap: [],
      competitors: [],
      notes,
      cost,
    }
    const data = options.dataService?.()
    if (data === undefined || ourDomain === undefined || ourDomain === '') {
      run.status = 'skipped'
      notes.push(
        data === undefined
          ? '外链体检要用「Agents 工坊官方数据接口」，先去「设置 → 账号与积分」关联一次'
          : '不知道我们的网站，先在品牌档案里填上',
      )
    } else {
      const callOne = async (cap: string, input: Record<string, unknown>) => {
        const r = await data.call(cap, { input })
        cost.calls += 1
        cost.credits += r.credits
        return r
      }
      try {
        const r = await callOne('seo.backlink_summary', { target: ourDomain })
        const s = backlinkSummaryOf(r.items, r.fetched_at)
        if (s !== undefined) run.ours = s
      } catch (err) {
        notes.push(`外链概况这次没读到：${err instanceof Error ? err.message.slice(0, 80) : ''}`)
      }
      let rows: BacklinkRow[] = []
      const competitors = new Map<string, BacklinkRow[]>()
      try {
        rows = backlinkRowsOf(
          (await callOne('seo.backlinks', { target: ourDomain, mode: 'domain', limit: 100 })).items,
        )
        const comps = await competitorDomains(settings)
        run.competitors = comps
        for (const c of comps)
          try {
            competitors.set(
              c,
              backlinkRowsOf(
                (await callOne('seo.backlinks', { target: c, mode: 'domain', limit: 100 })).items,
              ),
            )
          } catch {
            notes.push(`${c} 的外链这次没读到`)
          }
        if (comps.length === 0) notes.push('关注设置里还没有竞品，竞品差距这次不算')
      } catch {
        notes.push('外链明细这项数据还没开通：锚文本、可疑来源、竞品差距这次不看，只看概况')
      }
      if (run.ours === undefined && rows.length === 0) run.status = 'skipped'
      else if (notes.length > 0) run.status = 'partial'
      const terms = [brand.name, ...brand.domains.map((d) => d.split('.')[0] ?? '')]
      let keywords: string[] = []
      try {
        const gsc = options.searchConsole()
        if (gsc.connected())
          keywords = [
            ...new Set((await gsc.rows({ end: clock.now() })).map((r) => normalizeQuery(r.query))),
          ]
            .filter((q) => !isBrandQuery(q, terms))
            .slice(0, 50)
      } catch {
        keywords = []
      }
      const result = auditBacklinks({
        ...(run.ours === undefined ? {} : { ours: run.ours }),
        ...(prev?.ours === undefined
          ? {}
          : {
              previous: {
                ...(prev.ours.referring_domains === undefined
                  ? {}
                  : { referring_domains: prev.ours.referring_domains }),
                ...(prev.ours.backlinks === undefined ? {} : { backlinks: prev.ours.backlinks }),
              },
            }),
        rows,
        competitors,
        brand_terms: terms,
        our_domains: brand.domains,
        keywords,
      })
      if (prev?.ours !== undefined)
        run.previous = {
          at: prev.at,
          ...(prev.ours.referring_domains === undefined
            ? {}
            : { referring_domains: prev.ours.referring_domains }),
          ...(prev.ours.backlinks === undefined ? {} : { backlinks: prev.ours.backlinks }),
        }
      if (result.change !== undefined) run.change = result.change
      run.anchors = result.anchors
      run.suspicious = result.suspicious
      run.issues = result.issues
      run.gap = result.gap
      cost.credits = Math.round(cost.credits * 100) / 100
      // 竞品差距交公关（站外提及归公关）
      if (run.gap.length > 0) {
        const pr = holder(PR_ROLES)
        if (pr === undefined) notes.push('没人担公关，竞品差距清单留在这里')
        else {
          const id = openMatter({
            title: `外链：${String(run.gap.length)} 个站链了竞品、还没链我们（${today()}）`,
            summary: backlinkGapBrief(run.gap).join('\n'),
            role_id: pr.role_id,
            actor: pr.actor,
          })
          if (id !== undefined)
            run.handed_to_pr = { matter_id: id, at: clock.now(), sites: run.gap.length }
        }
      }
    }
    const next = load()
    save({
      ...next,
      backlinks: {
        ...(next.backlinks ?? {}),
        runs: [run, ...(next.backlinks?.runs ?? [])].slice(0, KEEP_BACKLINK_RUNS),
      },
    })
    emit('seo.backlink_audit', {
      run_id: run.id,
      status: run.status,
      issues: run.issues.length,
      gap: run.gap.length,
      credits: cost.credits,
    })
    return run
  }

  /* ── llms.txt ─────────────────────────────────────────────────── */

  const llmsView = async (): Promise<LlmsTxtView> => {
    const s = load().llms
    const live = options.llmsLive?.()
    return {
      ...(s?.draft === undefined ? {} : { draft: s.draft }),
      ...(live === undefined ? {} : { live }),
      ...(s?.handed_to_site === undefined ? {} : { handed_to_site: s.handed_to_site }),
      placement: [...LLMS_PLACEMENT_ZH],
    }
  }

  const structure = async (brand: SeoBrandInfo): Promise<LlmsStructure | undefined> => {
    const site = await options.siteUrls?.().catch(() => undefined)
    const origin =
      site?.origin ?? (brand.domains[0] === undefined ? undefined : `https://${brand.domains[0]}`)
    if (origin === undefined) return undefined
    return llmsStructureFromUrls({
      name: brand.name,
      ...(brand.one_liner === undefined ? {} : { summary: brand.one_liner }),
      origin,
      urls: site?.urls ?? [],
    })
  }

  /* ── 改写成社媒稿 ─────────────────────────────────────────────── */

  const repurpose = async (input: {
    change_id?: string
    title?: string
    body?: string
    url?: string
    channels?: RepurposeChannel[]
  }): Promise<RepurposeResult> => {
    const brand = await options.brand()
    let article: RepurposeArticle | undefined
    if (input.change_id !== undefined) {
      const hit = (await published()).find((p) => p.change_id === input.change_id)
      if (hit === undefined) throw new Error('没找到这篇已发布的文章')
      article = {
        title: hit.title,
        body: hit.body ?? '',
        ...(hit.url === undefined ? {} : { url: hit.url }),
        brand: brand.name,
      }
    } else if (input.title !== undefined && (input.body ?? '').trim() !== '')
      article = {
        title: input.title,
        body: input.body ?? '',
        ...(input.url === undefined ? {} : { url: input.url }),
        brand: brand.name,
      }
    if (article === undefined || article.body.trim() === '')
      throw new Error('这篇文章读不到正文，没法起草')
    const channels = input.channels ?? [...REPURPOSE_CHANNELS]
    const actor = options.holderOf(CONTENT_ROLE) ?? options.holderOf(SEO_ROLE)
    const model =
      actor === undefined
        ? undefined
        : options.drafter?.({
            actor,
            run_id: `run_repurpose_${Date.parse(clock.now()).toString(36)}`,
          })
    const drafts: RepurposeDraft[] = []
    const matters: RepurposeResult['matters'] = []
    const skipped: RepurposeResult['skipped'] = []
    for (const ch of channels) {
      const owner = holder(REPURPOSE_ROLES[ch])
      if (owner === undefined) {
        skipped.push({ channel: ch, reason: `没人担${REPURPOSE_CHANNEL_ZH[ch]}那条社媒职责` })
        continue
      }
      let draft: RepurposeDraft | undefined
      if (model !== undefined)
        try {
          const p = repurposePrompt(article, ch)
          draft = repurposeFromModel(
            article,
            ch,
            (await model({ system: p.system, prompt: p.prompt })).text,
          )
          if (draft.text.trim() === '') draft = undefined
        } catch {
          draft = undefined
        }
      draft ??= repurposeRules(article, ch)
      drafts.push(draft)
      const id = openMatter({
        title: `起草好了：${REPURPOSE_CHANNEL_ZH[ch]}（文章「${article.title}」）`,
        summary: [
          `这是从文章「${article.title}」${article.url === undefined ? '' : `（${article.url}）`}改写的${REPURPOSE_CHANNEL_ZH[ch]}草稿，只起草、没发。`,
          '发之前：在那个平台的编辑框里再看一眼字数与规矩；占位里的真实经历要么填真的、要么删掉；草稿里的数都来自原文。',
          ...(draft.removed.length === 0
            ? []
            : [`起草时拿掉了 ${String(draft.removed.length)} 句原文里没有的数或经历。`]),
          '——草稿——',
          draft.text,
        ].join('\n'),
        role_id: owner.role_id,
        actor: owner.actor,
      })
      if (id !== undefined) matters.push({ channel: ch, role_id: owner.role_id, matter_id: id })
    }
    if (input.change_id !== undefined && matters.length > 0) {
      const state = load()
      save({
        ...state,
        repurposed: {
          ...(state.repurposed ?? {}),
          [input.change_id]: { at: clock.now(), matters: matters.map((m) => m.matter_id) },
        },
      })
    }
    emit('seo.repurposed', {
      ...(input.change_id === undefined ? {} : { change_id: input.change_id }),
      drafts: drafts.length,
      matters: matters.length,
    })
    return {
      source: {
        title: article.title,
        ...(article.url === undefined ? {} : { url: article.url }),
        ...(input.change_id === undefined ? {} : { change_id: input.change_id }),
      },
      drafts,
      matters,
      skipped,
    }
  }

  return {
    planEstimate,
    planClusters: planNow,
    calendarView,
    tickCalendar,
    async onDecided(item) {
      if (item.kind !== 'seo_cluster' || item.workspace_id !== workspace_id) return
      if (item.state === 'approved' || item.state === 'approved_edited') {
        approveCluster(item)
        return
      }
      if (item.state === 'rejected' || item.state === 'expired' || item.state === 'withdrawn') {
        const state = load()
        save({
          ...state,
          pending: (state.pending ?? []).filter((x) => x.approval_item_id !== item.id),
        })
      }
    },
    backlinkView,
    async setBacklinkSettings(patch) {
      const state = load()
      const cur = backlinkSettings(state)
      const every =
        patch.every_days === undefined
          ? cur.every_days
          : Math.min(90, Math.max(7, Math.floor(patch.every_days)))
      save({
        ...state,
        backlinks: {
          ...(state.backlinks ?? {}),
          settings: {
            ...cur,
            ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
            every_days: every,
            ...(patch.competitors === undefined
              ? {}
              : { competitors: patch.competitors.slice(0, BACKLINK_MAX_COMPETITORS) }),
          },
        },
      })
      return backlinkView()
    },
    backlinkAudit,
    async backlinkDue() {
      const state = load()
      const settings = backlinkSettings(state)
      if (!settings.enabled) return undefined
      if (options.holderOf(SEO_ROLE) === undefined) return undefined
      if (options.dataService?.() === undefined) return undefined
      const last = state.backlinks?.runs?.[0]
      if (last !== undefined && addDays(last.at.slice(0, 10), settings.every_days) > today())
        return undefined
      return backlinkAudit('scheduled')
    },
    llmsView,
    async llmsGenerate(input) {
      const brand = await options.brand()
      const s = await structure(brand)
      if (s === undefined) throw new Error('不知道我们的网站，先在品牌档案里填上')
      const draft = buildLlmsTxt(s, clock.now())
      const state = load()
      let handed = state.llms?.handed_to_site
      if (input?.handoff === true) {
        const site = holder(SITE_ROLES)
        if (site === undefined) throw new Error('没人担建站（网页模板 / 整站搭建），先在岗位里分好')
        const id = openMatter({
          title: `放一份 llms.txt 到网站根目录（${today()}）`,
          summary: [
            'SEO 与 GEO 按店里现在的合集、商品、政策页生成了一份 llms.txt，请放到网站上：',
            ...LLMS_PLACEMENT_ZH.map((x, i) => `${String(i + 1)}. ${x}`),
            '——文件内容——',
            draft.content,
          ].join('\n'),
          role_id: site.role_id,
          actor: site.actor,
        })
        if (id !== undefined) handed = { matter_id: id, at: clock.now() }
      }
      save({
        ...state,
        llms: { draft, ...(handed === undefined ? {} : { handed_to_site: handed }) },
      })
      return llmsView()
    },
    repurpose,
  }
}
