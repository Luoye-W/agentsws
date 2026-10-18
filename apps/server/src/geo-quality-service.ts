/**
 * WP380（Luoye 10-17，决策 1066）：「内容与搜索」里 GEO 的第二层——服务端接线。
 *
 * - **改完自动复查**：每张 GEO 改动（变化大出的事项、一致性分派）记「改了什么、期望哪个数动、哪天复查」；
 *   到期把那组问题即时重问一遍（不走排队档；官方那条路不问 Claude），前后一比出「保留 / 扩大 / 修改 / 停」卡。
 * - **对外说法一致性**：官方事实表（带日期）对官网、商品页、结构化数据、上架页、评测 / 合作方页面，
 *   过时或说法不一的按岗位分好出一张卡（同 WP350 的方案卡：就这样 = 每个岗位各开一件事，同一来源批次）；
 *   改外部的事照旧由那个岗位出审批，这里不碰外面。
 * - **周报模板**：缺位主因与先后、每个数标来路、站外来源地图、一致性与复查小结、给 WP381 留的位置。
 *
 * 判断全在 `@agentsws/seo-core`（纯函数）；这里只取页面、调模型、出卡、开事项、存表。不打一跳网络——
 * 取页面、模型都是注入的。
 */

import { jsonLdNodes, visibleText } from '@agentsws/brand-intake'
import type {
  ApprovalBus,
  ApprovalItem,
  Clock,
  GeoConsistencyPage,
  GeoConsistencyRun,
  GeoFixOwner,
  GeoGap,
  GeoMetricsView,
  GeoRecheck,
  GeoRecheckInput,
  GeoRunEstimate,
  GeoWatchCardPayload,
  GeoWeekPoint,
  RoleId,
  SeoWeeklyGeoPayload,
  WatchRun,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  CONSISTENCY_PAGES_MAX,
  type ConsistencyPage,
  consistencyPrompt,
  FIGURE_BASIS_ZH,
  factsAsOf,
  GAP_CAUSE_ZH,
  type GapSignals,
  groupFindings,
  mergeFindings,
  parseConsistencyReply,
  RECHECK_ADVICE_ZH,
  RECHECK_DAYS,
  RECHECK_DAYS_OFFSITE,
  RECHECK_MAX_TRIES,
  RECHECK_METRIC_ZH,
  rankGaps,
  recheckAdvice,
  recheckSide,
  reportFigures,
  ruleFindings,
  shiftDay,
  sourceMap,
  surfaceOf,
} from '@agentsws/seo-core'
import type { GeoMonitor, WatchModel } from './geo-monitor.js'
import type { GeoStore } from './geo-store.js'
import type { SeoActor, SeoMatterPort } from './seo-service.js'

/** 一次一致性检查最多让模型读几页。 */
export const CONSISTENCY_MODEL_PAGES = 8
/** 一天最多跑几条到期复查（每条都要花一轮问答的钱）。 */
export const RECHECKS_PER_DAY = 3
/** 一致性检查多久自动跑一次（天；跟着每周那一轮看到期没有）。 */
export const CONSISTENCY_EVERY_DAYS = 28

/** 岗位的中文名（卡与事项上）。 */
export const OWNER_ZH: Readonly<Record<GeoFixOwner | 'content', string>> = {
  site: '建站',
  'web-ops': '网站运营',
  pr: '公关',
  content: '内容与搜索',
}

/** 每个岗位找谁持有（按顺序找第一个有人的职责）。 */
const OWNER_ROLES: Readonly<Record<GeoFixOwner | 'content', RoleId[]>> = {
  site: ['site.shopify-theme', 'site.shopify-build'],
  'web-ops': ['dtc.store', 'dtc.content'],
  pr: ['pr.press', 'pr.forums', 'pr.reddit'],
  content: ['dtc.content'],
}
const OWNER_TEMPLATE: Readonly<Record<GeoFixOwner | 'content', string>> = {
  site: 'site',
  'web-ops': 'web-ops',
  pr: 'pr',
  content: 'web-ops',
}

const FIELD_ZH: Readonly<Record<string, string>> = {
  name: '名称',
  category: '品类',
  price: '价格',
  selling_points: '卖点',
  markets: '市场',
}

type MatterInput = Parameters<SeoMatterPort['createMatter']>[0]

export interface GeoQualityDeps {
  workspace_id: WorkspaceId
  clock: Clock
  nextId(prefix: string): string
  monitor: GeoMonitor
  store(): Promise<GeoStore>
  approvals: ApprovalBus
  /** 开一件事项（同一件 14 天内不重复；没装事项口回 `undefined`）。 */
  openMatter(key: string, input: MatterInput): string | undefined
  holderOf(role_id: RoleId): SeoActor | undefined
  /** 读页面那一问的模型（每次现取；没配回 `undefined`——只跑规则那一层）。 */
  model(actor: SeoActor): WatchModel | undefined
  /** 取一页（公开网址；取不到回 `undefined`，照实写「没取到」）。不给 = 一致性检查只能说「取不了页面」。 */
  pageFetch?(url: string): Promise<{ html: string } | undefined>
  thresholds(): Record<string, number>
  emit(type: string, actor: string, payload: Record<string, unknown>): void
}

export type GeoQuality = ReturnType<typeof createGeoQuality>

export function createGeoQuality(deps: GeoQualityDeps) {
  const today = (): string => deps.clock.now().slice(0, 10)
  const days = (key: string, fallback: number): number => {
    const v = deps.thresholds()[key]
    return typeof v === 'number' && v > 0 ? Math.round(v) : fallback
  }
  const holderFor = (owner: GeoFixOwner | 'content'): { actor?: SeoActor; role: RoleId } => {
    for (const role of OWNER_ROLES[owner]) {
      const actor = deps.holderOf(role)
      if (actor !== undefined) return { actor, role }
    }
    return { role: OWNER_ROLES[owner][0] as RoleId }
  }
  const matterFor = (
    owner: GeoFixOwner | 'content',
    title: string,
    summary: string,
  ): MatterInput => {
    const { actor, role } = holderFor(owner)
    return {
      kind: 'project',
      title,
      summary,
      ...(owner === 'content'
        ? { entry: 'role' as const, role_id: role }
        : {
            entry: 'position' as const,
            position_template_id: OWNER_TEMPLATE[owner],
            role_id: role,
          }),
      ...(actor === undefined
        ? {}
        : { position_id: actor.assignment_id, participants: [actor.person_id] }),
    }
  }
  const cardBase = (actor: SeoActor) => ({
    workspace_id: deps.workspace_id,
    schema_version: 1 as const,
    kind: 'geo_watch' as const,
    role_id: actor.role_id,
    subject: { object: { type: 'geo_watch', id: deps.workspace_id } },
    evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
    proposer: {
      kind: 'agent' as const,
      id: `agent_${actor.role_id}`,
      assignment_id: actor.assignment_id,
    },
    automation: { level_at_creation: 'L1' as const },
    routing: {
      recipients: [{ person: actor.person_id, via: 'role_holder' as const }],
      rule: 'role_holder' as const,
      escalation: {
        after_hours: 72,
        business_hours: true,
        chain: ['owner' as const],
        escalated_at: [],
      },
      separation_of_duties: false,
    },
    priority: 'queue' as const,
  })

  /* ── 改完自动复查 ─────────────────────────────────────────────────── */

  /** 登记一条复查：记下改之前那组问题上的数（最近一周）。 */
  async function registerRecheck(
    input: GeoRecheckInput & { source: GeoRecheck['source']; markets?: string[] },
  ): Promise<GeoRecheck> {
    const store = await deps.store()
    const fallback = input.source === 'consistency' ? RECHECK_DAYS_OFFSITE : RECHECK_DAYS
    const wait =
      input.due_days ??
      days(
        input.source === 'consistency' ? 'geo_recheck_days_offsite' : 'geo_recheck_days',
        fallback,
      )
    const rows = await deps.monitor.historyRows(shiftDay(today(), -35))
    const r: GeoRecheck = {
      id: deps.nextId('grc'),
      created_at: deps.clock.now(),
      source: input.source,
      change: input.change.trim().slice(0, 200),
      metric: input.metric,
      prompt_ids: [...new Set(input.prompt_ids)],
      ...(input.markets === undefined || input.markets.length === 0
        ? {}
        : { markets: input.markets }),
      ...(input.owner === undefined ? {} : { owner: input.owner }),
      ...(input.matter_id === undefined ? {} : { matter_id: input.matter_id }),
      due: shiftDay(today(), wait),
      before: recheckSide(rows, input.metric, input.prompt_ids),
      status: 'waiting',
    }
    store.saveRecheck(r)
    return r
  }

  /** 一句「复查：10-26 重问这 3 个问题，看提及率」（事项摘要里写上）。 */
  const recheckLine = (r: Pick<GeoRecheck, 'due' | 'prompt_ids' | 'metric'>): string =>
    `复查：${r.due.slice(5)} 重问这 ${r.prompt_ids.length} 个问题，看「${RECHECK_METRIC_ZH[r.metric]}」。`

  /** 出复查结果卡（「改东西」家族：就这样 = 照建议开一件跟进的事；保留只记下）。 */
  async function recheckCard(actor: SeoActor, r: GeoRecheck): Promise<string> {
    const payload: GeoWatchCardPayload = { form: 'geo_recheck', recheck: r }
    const pct = (v?: number) => (v === undefined ? '—' : `${Math.round(v * 100)}%`)
    const item = await deps.approvals.create<GeoWatchCardPayload>({
      ...cardBase(actor),
      dedupe_key: `dk_${deps.workspace_id}|geo_watch|recheck|${r.id}`,
      title: `复查：${r.advice === undefined ? '' : `${RECHECK_ADVICE_ZH[r.advice]} · `}${r.change}`,
      summary: [
        `${RECHECK_METRIC_ZH[r.metric]}：${pct(r.before.value)}（n=${r.before.n}）→ ${pct(r.after?.value)}（n=${r.after?.n ?? 0}）`,
        r.why ?? '',
      ]
        .filter((l) => l !== '')
        .join('\n'),
      payload,
    })
    return item.id
  }

  /**
   * 到期的复查：即时重问那组问题 → 前后一比 → 出建议卡。没拿到够多的回答就再等一周（最多两次）。
   * 一天最多跑 {@link RECHECKS_PER_DAY} 条。
   */
  async function processDue(actor: SeoActor): Promise<GeoRecheck[]> {
    const store = await deps.store()
    const due = store.rechecks({ status: 'waiting', due_by: today() }).slice(0, RECHECKS_PER_DAY)
    const out: GeoRecheck[] = []
    for (const r of due) {
      const later = (why: string): GeoRecheck => {
        const tries = (r.tries ?? 0) + 1
        return tries >= RECHECK_MAX_TRIES
          ? { ...r, tries, status: 'skipped', why }
          : { ...r, tries, due: shiftDay(today(), 7), why }
      }
      const round = await deps.monitor
        .runGeo('manual', { recheck: { prompt_ids: r.prompt_ids, markets: r.markets } })
        .catch((err: unknown) => ({
          skipped: err instanceof Error ? err.message.slice(0, 80) : '没跑成',
          run: undefined,
        }))
      const run = (round as { run?: WatchRun }).run
      if (run === undefined) {
        const next = later(`这次没问成：${(round as { skipped?: string }).skipped ?? ''}`)
        store.saveRecheck(next)
        out.push(next)
        continue
      }
      // 先记下这一轮是复查（每周指标不算它），再取它的回答
      store.saveRecheck({ ...r, run_id: run.id })
      const rows = (await deps.monitor.historyRows(run.period, { rechecks: 'only' })).filter(
        (x) => x.answer.run_id === run.id,
      )
      const after = recheckSide(rows, r.metric, r.prompt_ids)
      const verdict = recheckAdvice(r.before, after)
      if (verdict === undefined) {
        const next = {
          ...later(`回答太少（n=${after.n}），下周再看。`),
          run_id: run.id,
          after,
        }
        store.saveRecheck(next)
        out.push(next)
        continue
      }
      const done: GeoRecheck = { ...r, run_id: run.id, after, ...verdict, status: 'done' }
      const card_id = await recheckCard(actor, done)
      store.saveRecheck({ ...done, card_id })
      out.push({ ...done, card_id })
    }
    if (out.length > 0)
      deps.emit('seo.geo_recheck', actor.assignment_id, {
        done: out.filter((r) => r.status === 'done').length,
        waiting: out.filter((r) => r.status === 'waiting').length,
        skipped: out.filter((r) => r.status === 'skipped').length,
      })
    return out
  }

  /* ── 对外说法一致性 ─────────────────────────────────────────────────── */

  /** 要对的页：我们的首页、近 4 周被引用的我们的页、提到我们的回答里引用的站外页、人指定的。 */
  async function candidatePages(
    domains: readonly string[],
    extra: readonly string[],
  ): Promise<{ url: string; surface: GeoConsistencyPage['surface'] }[]> {
    const rows = await deps.monitor.historyRows(shiftDay(today(), -35))
    const count = new Map<string, number>()
    for (const r of rows) {
      if (r.answer.status !== 'ok') continue
      const us = r.mentions.some((m) => m.entity === 'ours' && m.mentioned)
      for (const c of r.citations) {
        if (c.where === 'searched' || c.site_kind === 'competitor') continue
        if (c.site_kind !== 'ours' && !us) continue
        count.set(c.url, (count.get(c.url) ?? 0) + 1)
      }
    }
    const urls = [
      ...extra,
      ...domains.map((d) => `https://${d.replace(/^https?:\/\//, '').replace(/\/$/, '')}/`),
      ...[...count.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u),
    ]
    const seen = new Set<string>()
    const out: { url: string; surface: GeoConsistencyPage['surface'] }[] = []
    for (const url of urls) {
      if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
      seen.add(url)
      out.push({ url, surface: surfaceOf(url, domains) })
      if (out.length >= CONSISTENCY_PAGES_MAX) break
    }
    return out
  }

  /** 跑一次一致性检查；查出东西就出一张按岗位分好的卡。 */
  async function runConsistency(
    actor: SeoActor,
    input: { urls?: readonly string[] } = {},
  ): Promise<GeoConsistencyRun> {
    const store = await deps.store()
    const facts = await deps.monitor.officialFacts()
    const { watch } = await deps.monitor.ensureWatch()
    const id = deps.nextId('gcs')
    const asOf = factsAsOf(facts)
    const base: GeoConsistencyRun = {
      id,
      at: deps.clock.now(),
      ...(asOf === undefined ? {} : { facts_as_of: asOf }),
      pages: [],
      findings: [],
    }
    if (facts.length === 0) {
      store.saveConsistency(base)
      return base
    }
    const pages = await candidatePages(watch.brand.domains, input.urls ?? [])
    const model = deps.model(actor)
    let asked = 0
    const found: Parameters<typeof mergeFindings>[0][number][] = []
    for (const p of pages) {
      if (deps.pageFetch === undefined) {
        base.pages.push({ ...p, status: 'skipped', reason: '这台电脑取不了网页' })
        continue
      }
      const got = await deps.pageFetch(p.url).catch(() => undefined)
      if (got === undefined || got.html.trim() === '') {
        base.pages.push({ ...p, status: 'failed', reason: '没取到这一页' })
        continue
      }
      const page: ConsistencyPage = {
        url: p.url,
        surface: p.surface,
        text: visibleText(got.html, 8000),
        jsonld: jsonLdNodes(got.html),
      }
      found.push(...ruleFindings(page, facts))
      if (model !== undefined && asked < CONSISTENCY_MODEL_PAGES && page.text.trim() !== '') {
        asked += 1
        try {
          const reply = await model({ prompt: consistencyPrompt(page, facts) })
          found.push(...parseConsistencyReply(reply.text, page, facts))
        } catch {
          // 模型这次没答上来：规则那一层照用
        }
      }
      base.pages.push({ ...p, status: 'ok' })
    }
    const run: GeoConsistencyRun = {
      ...base,
      findings: mergeFindings(found, (_f, i) => `${id}_${i + 1}`),
    }
    if (run.findings.length > 0) {
      const batch_id = `batch_${id}`
      const recheck_on = shiftDay(today(), days('geo_recheck_days_offsite', RECHECK_DAYS_OFFSITE))
      const groups = groupFindings(run.findings)
      const payload: GeoWatchCardPayload = {
        form: 'geo_consistency',
        run_id: id,
        batch_id,
        groups,
        recheck_on,
      }
      const item = await deps.approvals.create<GeoWatchCardPayload>({
        ...cardBase(actor),
        dedupe_key: `dk_${deps.workspace_id}|geo_watch|consistency|${id}`,
        title: `对外说法不一致：${run.findings.length} 处，分给 ${groups.length} 个岗位`,
        summary: groups
          .map(
            (g) =>
              `${OWNER_ZH[g.owner]}：${g.findings
                .slice(0, 3)
                .map(
                  (f) =>
                    `${FIELD_ZH[f.field] ?? f.field}${f.verdict === 'outdated' ? '过时' : '不一致'}`,
                )
                .join('、')}${g.findings.length > 3 ? ` 等 ${g.findings.length} 处` : ''}`,
          )
          .join('\n'),
        payload,
      })
      Object.assign(run, { card_id: item.id, batch_id })
    }
    store.saveConsistency(run)
    deps.emit('seo.geo_consistency', actor.assignment_id, {
      run_id: id,
      pages: run.pages.length,
      fetched: run.pages.filter((p) => p.status === 'ok').length,
      findings: run.findings.length,
      by_owner: groupFindings(run.findings).map((g) => [g.owner, g.findings.length]),
    })
    return run
  }

  /** 每周那一轮顺手看：上一次一致性检查超过 {@link CONSISTENCY_EVERY_DAYS} 天（或从没查过）就查一次。 */
  async function consistencyDue(): Promise<boolean> {
    const last = (await deps.store()).consistencyRuns(1)[0]
    if (last === undefined) return true
    const every = days('geo_consistency_days', CONSISTENCY_EVERY_DAYS)
    return Date.parse(deps.clock.now()) - Date.parse(last.at) >= every * 86_400_000
  }

  /** 提到我们的那组问题（最近一周；复查描述准确度用）。 */
  async function mentionedPrompts(): Promise<string[]> {
    const rows = await deps.monitor.historyRows(shiftDay(today(), -14))
    const week = [...new Set(rows.map((r) => r.week))].sort().at(-1)
    return [
      ...new Set(
        rows
          .filter(
            (r) => r.week === week && r.mentions.some((m) => m.entity === 'ours' && m.mentioned),
          )
          .map((r) => r.answer.prompt_id),
      ),
    ]
  }

  /**
   * 卡被决定之后：一致性卡批了 → 每个岗位各开一件事（同一来源批次，事项里列出每一处与官方说法），
   * 记一条复查（描述准确度）；复查卡批了且建议不是「保留」→ 开一件跟进的事给原来负责的岗位。
   */
  async function onDecided(item: ApprovalItem): Promise<boolean> {
    const base = item.payload as GeoWatchCardPayload
    if (base.form !== 'geo_consistency' && base.form !== 'geo_recheck') return false
    const approved = item.state === 'approved' || item.state === 'approved_edited'
    if (!approved) return true
    const edited = item.state === 'approved_edited' ? item.decision?.edited_payload : undefined
    const p = (
      edited !== null && typeof edited === 'object' && 'form' in edited ? edited : base
    ) as GeoWatchCardPayload
    const store = await deps.store()
    if (p.form === 'geo_consistency') {
      const groups = p.groups.filter((g) => g.findings.length > 0)
      const opened: { owner: GeoFixOwner; matter_id: string }[] = []
      const prompts = await mentionedPrompts()
      const recheck = { due: p.recheck_on, prompt_ids: prompts, metric: 'accuracy' as const }
      for (const g of groups) {
        const lines = g.findings.map(
          (f) =>
            `· ${f.url}${f.surface === 'structured_data' ? '（结构化数据）' : ''}：${FIELD_ZH[f.field] ?? f.field}写的是「${f.said}」，官方是「${f.official}」（${f.official_as_of} 起）${f.verdict === 'outdated' ? '——旧说法' : ''}${f.quote === undefined ? '' : `\n  原话：${f.quote}`}`,
        )
        const id = deps.openMatter(
          `geo_consistency|${p.batch_id}|${g.owner}`,
          matterFor(
            g.owner,
            `${OWNER_ZH[g.owner]}：对外说法要改 ${g.findings.length} 处（和官方事实对不上）`,
            [
              `来源批次 ${p.batch_id}（同一次检查分给了 ${groups.length} 个岗位）。`,
              ...lines,
              '改外面的页面照你这个岗位的规矩出审批；改完在这件事里说一声。',
              prompts.length > 0 ? recheckLine(recheck) : '',
            ]
              .filter((l) => l !== '')
              .join('\n'),
          ),
        )
        if (id !== undefined) opened.push({ owner: g.owner, matter_id: id })
      }
      const run = store.consistencyRuns().find((r) => r.id === p.run_id)
      if (run !== undefined) store.saveConsistency({ ...run, batch_id: p.batch_id })
      if (prompts.length > 0 && opened.length > 0)
        await registerRecheck({
          source: 'consistency',
          change: `对外说法改 ${groups.reduce((a, g) => a + g.findings.length, 0)} 处（${opened.map((o) => OWNER_ZH[o.owner]).join('、')}）`,
          metric: 'accuracy',
          prompt_ids: prompts,
          due_days: Math.max(
            1,
            Math.round((Date.parse(p.recheck_on) - Date.parse(today())) / 86_400_000),
          ),
          owner: 'content',
          ...(opened[0] === undefined ? {} : { matter_id: opened[0].matter_id }),
        })
      return true
    }
    if (p.form !== 'geo_recheck') return true
    const r = p.recheck
    if (r.advice === undefined || r.advice === 'keep') return true
    const owner = r.owner ?? 'content'
    const what =
      r.advice === 'expand'
        ? '同样的改法用到相近的页和问题上'
        : r.advice === 'modify'
          ? '这一改没什么动静，换一种改法'
          : '变差了，先停下，看要不要改回去'
    deps.openMatter(
      `geo_recheck|${r.id}`,
      matterFor(
        owner,
        `${RECHECK_ADVICE_ZH[r.advice]}：${r.change}`,
        [
          `复查结果：${r.why ?? ''}`,
          `接下来：${what}。`,
          r.matter_id === undefined ? '' : `原来那件事：${r.matter_id}`,
        ]
          .filter((l) => l !== '')
          .join('\n'),
      ),
    )
    return true
  }

  /* ── 周报模板 ─────────────────────────────────────────────────────── */

  /**
   * 周报的第二层：缺位排好先后（主因 / 负责岗位 / 复查日期）、每个数标来路、站外来源地图、一致性与复查
   * 小结、WP381 的位置。回 payload 要加的格子与摘要里要加的几行。
   */
  async function weeklyExtras(input: {
    run: WatchRun
    gaps: readonly GeoGap[]
    point?: GeoWeekPoint | undefined
    view: GeoMetricsView
    estimate?: GeoRunEstimate | undefined
    slots?: SeoWeeklyGeoPayload['slots']
    site?: { blocked?: boolean; js_only?: boolean }
  }): Promise<{ payload: Partial<SeoWeeklyGeoPayload>; lines: string[] }> {
    const store = await deps.store()
    const week = input.run.period
    const rows = await deps.monitor.historyRows(shiftDay(week, -21))
    const topics = new Map(store.prompts({ archived: true }).map((p) => [p.text, p.topic] as const))
    const latest = store.consistencyRuns(1)[0]
    const signalsOf = (g: GeoGap): GapSignals => {
      const mine = rows.filter((r) => r.week === week && r.answer.prompt_text === g.question)
      const claims = mine.flatMap((r) => r.insight?.claims ?? [])
      const compares = mine.flatMap((r) =>
        r.insight?.compare === undefined ? [] : [r.insight.compare],
      )
      return {
        topic: topics.get(g.question),
        wrong_fields: claims.filter((c) => c.verdict === 'wrong').map((c) => c.field),
        outdated_fields: claims.filter((c) => c.verdict === 'outdated').map((c) => c.field),
        losses: compares.filter((c) => c.verdict === 'competitor').length,
        wins: compares.filter((c) => c.verdict === 'ours').length,
        negative: mine.some((r) =>
          r.mentions.some((m) => m.entity === 'ours' && m.sentiment === 'negative'),
        ),
        inconsistent: (latest?.findings.length ?? 0) > 0,
        ...(input.site?.blocked === undefined ? {} : { blocked: input.site.blocked }),
        ...(input.site?.js_only === undefined ? {} : { js_only: input.site.js_only }),
      }
    }
    const gaps = rankGaps(input.gaps, signalsOf, week)
    const figures = reportFigures({
      point: input.point,
      rank: input.view.rank.week === week ? input.view.rank : undefined,
      estimate: input.estimate,
      as_of: week,
    })
    const map = sourceMap(rows, { from: shiftDay(week, -21), to: week }).filter(
      (m) => m.group !== 'owned',
    )
    const waiting = store.rechecks({ status: 'waiting' }).length
    const doneRecent = store
      .rechecks({ status: 'done' })
      .filter((r) => r.due >= shiftDay(week, -7))
      .slice(0, 5)
    const lines: string[] = []
    if (figures.length > 0)
      lines.push(
        `数：${figures
          .filter((f) => ['mention_rate', 'win_rate', 'accuracy'].includes(f.key))
          .map(
            (f) =>
              `${f.label} ${f.value}（${FIGURE_BASIS_ZH[f.basis]}${f.n === undefined ? '' : `，n=${f.n}`}）`,
          )
          .join(' · ')}`,
      )
    const top = gaps[0]
    if (top?.cause !== undefined)
      lines.push(
        `先做：「${top.question}」——${GAP_CAUSE_ZH[top.cause]} · ${OWNER_ZH[top.owner ?? 'content']} · ${top.recheck_on?.slice(5) ?? ''} 复查`,
      )
    const offsite = map.filter((m) => m.group === 'media' || m.group === 'community').slice(0, 2)
    if (offsite.length > 0)
      lines.push(
        `站外来源：${offsite
          .map(
            (m) =>
              `${m.group === 'media' ? '媒体' : '社区'} ${m.domains[0]?.domain ?? ''}（${m.citations}）`,
          )
          .join(' · ')}`,
      )
    if (latest !== undefined && latest.findings.length > 0)
      lines.push(
        `说法不一致 ${latest.findings.length} 处（${groupFindings(latest.findings)
          .map((g) => `${OWNER_ZH[g.owner]} ${g.findings.length}`)
          .join(' · ')}）`,
      )
    if (waiting + doneRecent.length > 0)
      lines.push(
        `复查：等着 ${waiting} 条${doneRecent.length === 0 ? '' : `；做完 ${doneRecent.map((r) => (r.advice === undefined ? '—' : RECHECK_ADVICE_ZH[r.advice])).join('、')}`}`,
      )
    for (const slot of [
      input.slots?.site_check,
      input.slots?.product_check,
      input.slots?.ai_traffic,
    ])
      if (slot !== undefined && slot.lines.length > 0) lines.push(`${slot.title}：${slot.lines[0]}`)
    const slots =
      input.slots === undefined
        ? undefined
        : Object.fromEntries(Object.entries(input.slots).filter(([, v]) => v !== undefined))
    return {
      payload: {
        gaps,
        ...(figures.length === 0 ? {} : { figures }),
        ...(map.length === 0 ? {} : { source_map: map }),
        ...(latest === undefined
          ? {}
          : {
              consistency: {
                run_id: latest.id,
                at: latest.at,
                findings: latest.findings.length,
                by_owner: groupFindings(latest.findings).map((g) => ({
                  owner: g.owner,
                  n: g.findings.length,
                })),
              },
            }),
        ...(waiting + doneRecent.length === 0
          ? {}
          : {
              rechecks: {
                waiting,
                done: doneRecent.map((r) => ({
                  id: r.id,
                  change: r.change,
                  ...(r.advice === undefined ? {} : { advice: r.advice }),
                  ...(r.delta_pp === undefined ? {} : { delta_pp: r.delta_pp }),
                })),
              },
            }),
        ...(slots === undefined || Object.keys(slots).length === 0 ? {} : { slots }),
      },
      lines,
    }
  }

  return {
    registerRecheck,
    recheckLine,
    processDue,
    runConsistency,
    consistencyDue,
    onDecided,
    weeklyExtras,
  }
}
