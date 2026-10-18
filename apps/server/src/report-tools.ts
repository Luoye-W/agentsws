/**
 * WP331（决策 691，Luoye 10-15）：**报告积木**的四个工具真接上（定义在 `@agentsws/stand-ins` 的 `runtime/report.ts`）。
 *
 * 周报不是固定功能：用户说一句，AI 用官方「自动化任务」建一条定时（提示词 = 用户的要求），到点那次运行里用
 * 这四个工具取数、出报告；改格式 = AI 改那条定时的提示词。这里只有通用的积木，不认平台、不认客户：
 *
 * | 工具 | 怎么接 |
 * |---|---|
 * | `query_watch_items` | 这个品牌的巡查库（{@link WatchSource}，现在是 WP328 的 Reddit 巡查）→ `queryWatchItems` 筛、数、归组 |
 * | `run_watch_now` | 巡查库的 `sweepNow`：现在巡查一次、等它做完（最多 {@link WATCH_WAIT_MS}） |
 * | `query_sent_records` | WP323 发出记录 → `summarizeSent` 计数 + 链接 |
 * | `publish_report` | 报表块（`weekly_review` 同类：不进审批队列），发给这次运行的人、挂在这条职责上；同一系列同一周期 = 同一份的新版本；记录去处点名 `report` 的记一行 |
 * | `list_competitor_changes` | WP392：竞品监控那一份（`platform: 'competitor'` 的 {@link WatchSource}）的 `changes` → `queryCompetitorChanges` 筛、数 |
 *
 * WP392：`query_watch_items` 的 `platform` 多两种写法——`competitor`（竞品变化）、`all`（配了的全部一起查，帖子和变化混在一起）。
 *
 * 出参白名单：计数、原文引用（截断过）、链接、时间——不带任何内部 id 以外的东西、不带凭据。
 */
import {
  type ApprovalBus,
  type Clock,
  type CompetitorChange,
  type CompetitorSourceKind,
  type Iso8601,
  REPORT_OUTBOUND_ACTION,
  type ReportPayload,
  WATCH_ASSESSMENTS,
  type WatchAssessment,
  type WatchItem,
  type WorkspaceId,
} from '@agentsws/contracts'
import {
  COMPETITOR_WATCH_PLATFORM,
  type CompetitorChangeFilter,
  type PeriodInput,
  parseChangeKinds,
  queryCompetitorChanges,
  queryWatchItems,
  resolvePeriod,
  type SentFilter,
  summarizeSent,
  type WatchFilter,
} from '@agentsws/social-core'
import type { ToolExecution, ToolExecutor } from '@agentsws/stand-ins'
import {
  LIST_COMPETITOR_CHANGES_TOOL,
  PUBLISH_REPORT_TOOL,
  QUERY_SENT_RECORDS_TOOL,
  QUERY_WATCH_ITEMS_TOOL,
  RUN_WATCH_NOW_TOOL,
} from '@agentsws/stand-ins'
import type { OutboundLog } from './outbound/log.js'

type MaybePromise<T> = T | Promise<T>

/** 一个品牌一个平台的巡查库（巡查那一单交出来的口子）。 */
export interface WatchSource {
  platform: string
  /** 配没配巡查（自家地盘或外部关键词有一样就算）。 */
  configured(): MaybePromise<boolean>
  /** 自家地盘（用户配的版块 / 频道，不带前缀）。 */
  ownPlaces(): MaybePromise<string[]>
  /** 窗口里入库的条目（多给也行，会再按窗口挑）。 */
  items(window: { since: Iso8601; until: Iso8601 }): MaybePromise<WatchItem[]>
  /** 窗口里各次巡查跑完的时间。 */
  sweeps(window: { since: Iso8601; until: Iso8601 }): MaybePromise<Iso8601[]>
  /** 现在巡查一次并等它做完；有哪块没读成就抛一句人话。没有 = 不能现巡。 */
  sweepNow?(options?: { timeoutMs?: number }): Promise<unknown>
  /**
   * WP392：窗口里比出来的竞品变化（竞品监控那一份才有；`items` 里同样带着 `kind: 'change'` 的条目，
   * 这里给的是变化本身，出报表时按竞品 / 种类数）。
   */
  changes?(window: { since: Iso8601; until: Iso8601 }): MaybePromise<CompetitorChange[]>
  /** WP392：各条源这次读没读到（报告照实写「哪家没读到」）。没有 = 不分源。 */
  health?(): MaybePromise<{ sources: number; failed: string[]; partial: string[] }>
}

/**
 * WP392：几份巡查库合成一份（`platform: 'all'`：帖子和竞品变化一起查）。只合配了的那几份。
 */
export async function combineWatchSources(list: readonly WatchSource[]): Promise<WatchSource> {
  const on: WatchSource[] = []
  for (const s of list) if (await s.configured()) on.push(s)
  return {
    platform: on.map((s) => s.platform).join('+') || 'none',
    configured: () => on.length > 0,
    ownPlaces: async () => [...new Set((await Promise.all(on.map((s) => s.ownPlaces()))).flat())],
    items: async (w) => (await Promise.all(on.map((s) => s.items(w)))).flat(),
    sweeps: async (w) => (await Promise.all(on.map((s) => s.sweeps(w)))).flat(),
    ...(on.some((s) => s.sweepNow !== undefined)
      ? {
          sweepNow: async (o?: { timeoutMs?: number }) => {
            const parts: unknown[] = []
            let finished_at: string | undefined
            for (const s of on) {
              if (s.sweepNow === undefined) continue
              const r = (await s.sweepNow(o)) as
                | { finished_at?: string; parts?: unknown[] }
                | undefined
              parts.push(...(r?.parts ?? []))
              if (r?.finished_at !== undefined) finished_at = r.finished_at
            }
            return { ...(finished_at === undefined ? {} : { finished_at }), parts }
          },
        }
      : {}),
    ...(on.some((s) => s.changes !== undefined)
      ? {
          changes: async (w: { since: Iso8601; until: Iso8601 }) =>
            (await Promise.all(on.map((s) => s.changes?.(w) ?? []))).flat(),
        }
      : {}),
  }
}

/** 「立即巡查」最多等多久（插件那两块要等 Chrome 里的插件交回）。 */
export const WATCH_WAIT_MS = 5 * 60_000

/** 报告正文最长几个字（一份周报几千字；再长多半是模型把原始数据整段贴进来了）。 */
export const REPORT_MAX_CHARS = 60_000

export interface ReportToolOptions {
  clock: Clock
  tzOffsetMinutes(workspace_id: WorkspaceId): number
  /**
   * 这个品牌某个平台的巡查库（不给平台 = 这条职责配的那一个；WP392：`competitor` = 竞品监控、`all` = 全部合成一份）；
   * 没有回 `undefined`。`role_id` 是这次运行的职责（不给平台时按它挑）。
   */
  watch(
    workspace_id: WorkspaceId,
    platform?: string,
    role_id?: string,
  ): MaybePromise<WatchSource | undefined>
  /** 担巡查的那几条职责（查巡查 / 立即巡查只给它们）。 */
  watchRoles: ReadonlySet<string>
  /** WP392：担竞品监控的那几条职责（`list_competitor_changes` 只给它们；不给 = 没人担）。 */
  competitorRoles?: ReadonlySet<string>
  /** 发出记录（懒取：比运行时晚建）。 */
  outbound(): Pick<OutboundLog, 'list' | 'record' | 'sinks'> | undefined
  /** 出报表块那条审批总线（懒取）。 */
  approvals(): Pick<ApprovalBus, 'create'>
  /** 同一个去重键已经发过几次（第几版用）。 */
  publishedCount(workspace_id: WorkspaceId, dedupe_key: string): number
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
const bare = (name: string): string =>
  name.includes('.') ? name.slice(name.indexOf('.') + 1) : name
const int = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined

function periodOf(input: Record<string, unknown>): PeriodInput {
  const out: PeriodInput = {}
  const period = str(input.period)
  const week_start = int(input.week_start)
  const since = str(input.since)
  const until = str(input.until)
  if (period !== undefined) out.period = period
  if (week_start !== undefined) out.week_start = week_start
  if (since !== undefined) out.since = since
  if (until !== undefined) out.until = until
  return out
}

const windowView = (w: ReturnType<typeof resolvePeriod>) => ({
  since: w.since,
  until: w.until,
  start_date: w.start_date,
  end_date: w.end_date,
  label: w.label,
})

const ok = (data: unknown): ToolExecution => ({ status: 'ok', data })

/** 报告的去重键：同一个人在同一条职责下、同一系列、同一周期 = 同一份。 */
export function reportDedupeKey(input: {
  workspace_id: string
  assignment_id: string
  series: string
  period_key: string
}): string {
  const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
  return `dk_${input.workspace_id}|report|${input.assignment_id}|${norm(input.series)}|${norm(input.period_key)}`
}

export function createReportToolExecutor(options: ReportToolOptions): ToolExecutor {
  const queryWatch = async (
    ws: WorkspaceId,
    input: Record<string, unknown>,
    role_id: string,
  ): Promise<ToolExecution> => {
    const source = await options.watch(ws, str(input.platform), role_id)
    const w = resolvePeriod(options.clock.now(), options.tzOffsetMinutes(ws), periodOf(input))
    if (source === undefined || !(await source.configured()))
      return ok({
        configured: false,
        window: windowView(w),
        message: '这个品牌还没配巡查（自家版块 / 外部关键词都没有），先在岗位里说一句要巡查哪里。',
      })
    const range = { since: w.since, until: w.until }
    const [items, sweeps, ownPlaces] = await Promise.all([
      source.items(range),
      source.sweeps(range),
      source.ownPlaces(),
    ])
    const assessment = Array.isArray(input.assessment)
      ? input.assessment.filter((a): a is WatchAssessment =>
          (WATCH_ASSESSMENTS as readonly unknown[]).includes(a),
        )
      : undefined
    const scope = input.scope === 'own' || input.scope === 'external' ? input.scope : undefined
    const signal =
      input.signal === 'voc' || input.signal === 'ugc' || input.signal === 'any'
        ? input.signal
        : undefined
    const kind =
      input.kind === 'post' || input.kind === 'comment' || input.kind === 'change'
        ? input.kind
        : undefined
    const filter: WatchFilter = {}
    if (scope !== undefined) filter.scope = scope
    if (assessment !== undefined && assessment.length > 0) filter.assessment = assessment
    const topic = str(input.topic)
    const keyword = str(input.keyword)
    if (topic !== undefined) filter.topic = topic
    if (keyword !== undefined) filter.keyword = keyword
    if (signal !== undefined) filter.signal = signal
    if (kind !== undefined) filter.kind = kind
    // WP340：「优先」（命中告警词）与本地标签
    if (typeof input.priority === 'boolean') filter.priority = input.priority
    const tag = str(input.tag)
    if (tag !== undefined) filter.tag = tag
    const limit = int(input.limit)
    const r = queryWatchItems({
      items,
      ownPlaces,
      window: range,
      filter,
      ...(input.group_by === 'topic' ? { group_by: 'topic' as const } : {}),
      ...(limit === undefined ? {} : { limit }),
    })
    const done = sweeps.filter((t) => t >= w.since && t <= w.until).sort()
    return ok({
      configured: true,
      platform: source.platform,
      own_places: ownPlaces,
      window: windowView(w),
      sweeps: { count: done.length, ...(done.length === 0 ? {} : { last_at: done.at(-1) }) },
      ...r,
      ...(w.problems.length === 0 ? {} : { problems: w.problems }),
    })
  }

  const runNow = async (ws: WorkspaceId, input: Record<string, unknown>, role_id: string) => {
    const source = await options.watch(ws, str(input.platform), role_id)
    if (source === undefined || !(await source.configured()))
      return ok({ ok: false, message: '这个品牌还没配巡查。' })
    if (source.sweepNow === undefined)
      return ok({ ok: false, message: '这个平台不能现在巡查，用已入库的数据。' })
    try {
      const run = (await source.sweepNow({ timeoutMs: WATCH_WAIT_MS })) as
        | {
            finished_at?: string
            parts?: { part?: string; status?: string; fresh?: number; message?: string }[]
          }
        | undefined
      return ok({
        ok: true,
        ...(run?.finished_at === undefined ? {} : { finished_at: run.finished_at }),
        parts: (run?.parts ?? []).map((p) => ({
          part: p.part,
          status: p.status,
          ...(p.fresh === undefined ? {} : { fresh: p.fresh }),
          ...(p.message === undefined ? {} : { message: p.message }),
        })),
      })
    } catch (e) {
      // 没读成不挡报告：照实说，用已入库的出
      return ok({
        ok: false,
        message: `${e instanceof Error ? e.message : String(e)}`.slice(0, 400),
        note: '没读成的那几块照实写进报告，用已入库的数据出。',
      })
    }
  }

  /** WP392：竞品变化表（出参白名单：计数、标题、链接、前后值、幅度、时间、一句人话）。 */
  const listChanges = async (
    ws: WorkspaceId,
    input: Record<string, unknown>,
    role_id: string,
  ): Promise<ToolExecution> => {
    const source = await options.watch(ws, COMPETITOR_WATCH_PLATFORM, role_id)
    const w = resolvePeriod(options.clock.now(), options.tzOffsetMinutes(ws), periodOf(input))
    if (source === undefined || source.changes === undefined || !(await source.configured()))
      return ok({
        configured: false,
        window: windowView(w),
        message:
          '这个品牌还没盯竞品（关注的竞品上没写独立站或 Amazon 对标款）。先说一句「帮我盯竞品的上新和价格」。',
      })
    const filter: CompetitorChangeFilter = {}
    const competitor = str(input.competitor)
    if (competitor !== undefined) filter.competitor = competitor
    const kinds = parseChangeKinds(input.kinds ?? input.kind)
    if (kinds !== undefined) filter.kinds = kinds
    const sourceKind: CompetitorSourceKind | undefined =
      input.source === 'shop'
        ? 'shop_catalog'
        : input.source === 'amazon'
          ? 'amazon_asin'
          : undefined
    if (sourceKind !== undefined) filter.source_kind = sourceKind
    const range = { since: w.since, until: w.until }
    const [changes, health, sweeps] = await Promise.all([
      source.changes(range),
      source.health?.(),
      source.sweeps(range),
    ])
    const limit = int(input.limit)
    const r = queryCompetitorChanges({
      changes,
      window: range,
      filter,
      ...(limit === undefined ? {} : { limit }),
    })
    const done = sweeps.filter((t) => t >= w.since && t <= w.until).sort()
    return ok({
      configured: true,
      window: windowView(w),
      reads: { count: done.length, ...(done.length === 0 ? {} : { last_at: done.at(-1) }) },
      ...(health === undefined
        ? {}
        : {
            sources: {
              count: health.sources,
              ...(health.failed.length === 0 ? {} : { not_read: health.failed }),
              ...(health.partial.length === 0 ? {} : { partly_read: health.partial }),
            },
          }),
      ...r,
      ...(w.problems.length === 0 ? {} : { problems: w.problems }),
    })
  }

  const querySent = (ws: WorkspaceId, input: Record<string, unknown>): ToolExecution => {
    const w = resolvePeriod(options.clock.now(), options.tzOffsetMinutes(ws), periodOf(input))
    const log = options.outbound()
    if (log === undefined) return ok({ window: windowView(w), message: '这台机器没开发出记录。' })
    const channel = str(input.channel)
    const actions = Array.isArray(input.actions)
      ? input.actions.filter((a): a is string => typeof a === 'string')
      : undefined
    const sentFilter: SentFilter = { window: { since: w.since, until: w.until } }
    if (channel !== undefined) sentFilter.channel = channel
    if (actions !== undefined) sentFilter.actions = actions
    const sentLimit = int(input.limit)
    if (sentLimit !== undefined) sentFilter.limit = sentLimit
    const records = log.list(ws, {
      ...(channel === undefined ? {} : { channel: channel.toLowerCase() }),
      since: w.since,
      until: w.until,
      limit: 5000,
    })
    return ok({
      window: windowView(w),
      ...summarizeSent(records, sentFilter),
      ...(w.problems.length === 0 ? {} : { problems: w.problems }),
    })
  }

  /** 有去处点名要报告（动作 `report`）才记一行。 */
  const recordToSinks = (ws: WorkspaceId, p: ReportPayload, key: string): boolean => {
    const out = options.outbound()
    if (out === undefined) return false
    const wanted = out
      .sinks(ws)
      .some(
        (s) =>
          (s.state === 'active' || s.state === 'broken') &&
          s.filter.actions?.includes(REPORT_OUTBOUND_ACTION) === true,
      )
    if (!wanted) return false
    out.record(ws, {
      source_key: `report:${key}:v${p.version}`,
      sent_at: p.published_at,
      channel: 'report',
      action: REPORT_OUTBOUND_ACTION,
      kind: 'report',
      destination: '报表区',
      thread_title: p.version > 1 ? `${p.title}（第 ${p.version} 版）` : p.title,
      content: p.markdown,
      approved_by: '自动',
    })
    return true
  }

  const publish = async (
    call: Parameters<ToolExecutor>[0],
    input: Record<string, unknown>,
  ): Promise<ToolExecution> => {
    const req = call.request
    const ws = req.workspace_id as WorkspaceId
    const title = str(input.title)
    const period = str(input.period)
    const markdown = typeof input.markdown === 'string' ? input.markdown.trim() : ''
    const problems: string[] = []
    if (title === undefined || title.length > 120) problems.push('title 要有，最多 120 个字')
    if (period === undefined || period.length > 80) problems.push('period 要有，最多 80 个字')
    if (markdown === '') problems.push('markdown 正文是空的')
    if (markdown.length > REPORT_MAX_CHARS)
      problems.push(
        `正文太长（${markdown.length} 字，最多 ${REPORT_MAX_CHARS}）：原文只引用要紧的几条`,
      )
    const startRaw = str(input.period_start)
    const start =
      startRaw !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(startRaw) ? startRaw : undefined
    if (startRaw !== undefined && start === undefined)
      problems.push('period_start 要写成 YYYY-MM-DD')
    if (problems.length > 0 || title === undefined || period === undefined)
      return ok({ ok: false, problems })
    const series = (str(input.series) ?? title).slice(0, 120)
    const key = reportDedupeKey({
      workspace_id: ws,
      assignment_id: req.actor.assignment_id,
      series,
      period_key: start ?? period,
    })
    const payload: ReportPayload = {
      kind: 'report',
      series,
      title,
      period,
      ...(start === undefined ? {} : { period_start: start }),
      markdown: `${markdown}\n`,
      published_at: options.clock.now(),
      version: options.publishedCount(ws, key) + 1,
    }
    const item = await options.approvals().create<ReportPayload>({
      workspace_id: ws,
      schema_version: 1,
      // 报表（与经营一页纸同一类，NOT_A_CARD）：看一眼就过，不进审批队列
      kind: 'weekly_review',
      role_id: req.actor.role_id,
      subject: { object: { type: 'workspace', id: ws } },
      dedupe_key: key,
      title,
      summary: period,
      payload,
      evidence: { run_id: req.id, source_events: [], provenance: { seen: [] }, precheck: {} },
      proposer: { kind: 'agent', id: req.id, assignment_id: req.actor.assignment_id },
      automation: {
        level_at_creation: 'L3',
        auto_approved: true,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: req.actor.person_id, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 72, business_hours: true, chain: [], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'digest',
    })
    const recorded = recordToSinks(ws, payload, key)
    return ok({
      ok: true,
      report_id: item.id,
      version: payload.version,
      ...(recorded ? { recorded: true } : {}),
    })
  }

  return async (call): Promise<ToolExecution> => {
    const ws = call.request.workspace_id as WorkspaceId
    const input = (call.input ?? {}) as Record<string, unknown>
    const name = bare(call.name)
    const role = call.request.actor.role_id
    const watchTool = name === QUERY_WATCH_ITEMS_TOOL || name === RUN_WATCH_NOW_TOOL
    // WP392：担竞品监控的职责也能查巡查数据（默认就是竞品那一份）
    const competitorRole = options.competitorRoles?.has(role) === true
    if (watchTool && !options.watchRoles.has(role) && !competitorRole)
      return { status: 'blocked', reason: '这条职责看不了巡查数据' }
    if (name === LIST_COMPETITOR_CHANGES_TOOL && !competitorRole)
      return { status: 'blocked', reason: '这条职责看不了竞品变化表' }
    switch (name) {
      case QUERY_WATCH_ITEMS_TOOL:
        return queryWatch(ws, input, role)
      case RUN_WATCH_NOW_TOOL:
        return runNow(ws, input, role)
      case LIST_COMPETITOR_CHANGES_TOOL:
        return listChanges(ws, input, role)
      case QUERY_SENT_RECORDS_TOOL:
        return querySent(ws, input)
      case PUBLISH_REPORT_TOOL:
        return publish(call, input)
      default:
        return { status: 'error', reason: `不认识的工具 ${call.name}` }
    }
  }
}
