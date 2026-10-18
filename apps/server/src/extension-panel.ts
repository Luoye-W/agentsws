/**
 * WP413（真机联调 10-18 R1，Luoye 10-19 定 a–d）：**插件常驻侧边栏**要的事实，接到网关端口上
 * （`/v1/extension/panel*`，路由在 `packages/api/src/routes/extension-panel.ts`；卡由路由自己从审批总线取）。
 *
 * - 进度：巡查最近一次读了哪几块、各读到几条、几点读完、下次大约几点、现在在不在读、起草中几条；
 * - 批过的写：交给插件之后做到哪了（排着 / 填好了等你点 / 已发 · 已记录 / 没发出去 · 再填一次）；
 * - 记录：发出记录（Reddit 那几条）与每个记录去处写进去没有。
 *
 * 全是**本机已有的事实**，这里只挑、只换形状，不另存一份；工坊那边看到的是同一份。
 */

import type { ExtensionPanelFacts, ExtensionPanelPort } from '@agentsws/api'
import type {
  PanelProgress,
  PanelRecord,
  PanelSinkResult,
  PanelSinkView,
  PanelWrite,
} from '@agentsws/browser-action'
import type {
  ApprovalItem,
  Iso8601,
  OutboundRecord,
  OutboundRecordInput,
  RecordSinkView,
  RedditWatchSettings,
  RedditWatchView,
  RedditWriteView,
  SinkWrite,
  WorkspaceId,
} from '@agentsws/contracts'

const DAY_MS = 86_400_000
/** 批过的写在侧边栏留几天（已发的只留一天）。 */
export const PANEL_WRITES_DAYS = 7
/** 记录那一块最多几行。 */
export const PANEL_RECORDS_MAX = 20

/** 巡查那一份里侧边栏用得到的（`RedditWatchAssembly` 的子集）。 */
export interface PanelWatch {
  view(): RedditWatchView
  items(query?: { status?: 'open' | 'drafting' | 'done' | 'dismissed' }): unknown[]
}

/** Reddit 写那一份里侧边栏用得到的（`RedditWriteService` 的子集）。 */
export interface PanelWrites {
  writes(): RedditWriteView[]
  refill(
    job_id: string,
  ): Promise<{ ok: true; view: RedditWriteView } | { ok: false; message: string }>
}

/** 发出记录那一份里侧边栏用得到的（`OutboundLog` 的子集）。 */
export interface PanelOutbound {
  list(ws: WorkspaceId, query?: { channel?: string; limit?: number }): OutboundRecord[]
  sinks(ws: WorkspaceId): RecordSinkView[]
  /** 这一行写进各去处的状态（老实现没有 = 只给去处总状态）。 */
  writesOf?(ws: WorkspaceId, record_id: string): SinkWrite[]
}

export interface ExtensionPanelOptions {
  now(): Iso8601
  /** 品牌时区（分钟；算「下次几点」要按品牌本地的钟点）。 */
  tzOffsetMinutes(ws: WorkspaceId): number
  workspaceName(ws: WorkspaceId): Promise<string | undefined>
  watch(ws: WorkspaceId): Promise<PanelWatch | undefined>
  writes(ws: WorkspaceId): Promise<PanelWrites | undefined>
  outbound: PanelOutbound
  /** 施行这张卡、不等取消窗口（`txn.executor.applyApproval(id, { skip_cancel_window: true })`）。 */
  applyNow(item_id: string): Promise<unknown>
}

/**
 * 下一次大约几点读（按设置算，不看定时器）：一天一次（或隔几天）= 上次那天往后数天、到 `day_start_hour`；
 * 隔 N 小时 = 上次 + N 小时。从没读过 = 今天到点就读（已过点 = 马上）。关了 / 没设好回 `undefined`。
 */
export function nextRunAt(input: {
  now: Iso8601
  tz_offset_minutes: number
  settings: Pick<RedditWatchSettings, 'enabled' | 'every_hours' | 'day_start_hour'>
  configured: boolean
  last_started_at?: Iso8601
}): Iso8601 | undefined {
  const { settings: s } = input
  if (!s.enabled || !input.configured) return undefined
  const nowMs = Date.parse(input.now)
  const tz = input.tz_offset_minutes * 60_000
  const base = input.last_started_at === undefined ? undefined : Date.parse(input.last_started_at)
  let at: number
  if (s.every_hours >= 24) {
    const days = Math.max(1, Math.round(s.every_hours / 24))
    const startOfLocalDay = (ms: number): number => Math.floor((ms + tz) / DAY_MS) * DAY_MS - tz
    const day = base === undefined ? startOfLocalDay(nowMs) : startOfLocalDay(base) + days * DAY_MS
    at = day + s.day_start_hour * 3_600_000
  } else {
    at = base === undefined ? nowMs : base + s.every_hours * 3_600_000
  }
  return new Date(Math.max(at, nowMs)).toISOString()
}

/** 巡查视图 → 侧边栏「进度」那一块。 */
export function progressOf(input: {
  view: RedditWatchView
  drafting: number
  now: Iso8601
  tz_offset_minutes: number
}): PanelProgress {
  const { view } = input
  const run = view.last_run
  const account = view.extension.user ?? view.settings.brand_username
  const next = nextRunAt({
    now: input.now,
    tz_offset_minutes: input.tz_offset_minutes,
    settings: view.settings,
    configured: view.configured,
    ...(run === undefined ? {} : { last_started_at: run.started_at }),
  })
  return {
    configured: view.configured,
    ...(account === undefined || account === '' ? {} : { account }),
    ...(view.extension.reddit_connected === undefined
      ? {}
      : { reddit_connected: view.extension.reddit_connected }),
    ...(view.extension.note === undefined ? {} : { note: view.extension.note }),
    ...(run === undefined
      ? {}
      : {
          last_run: {
            started_at: run.started_at,
            ...(run.finished_at === undefined ? {} : { finished_at: run.finished_at }),
            trigger: run.trigger,
            parts: run.parts.map((p) => ({
              part: p.part,
              status: p.status,
              fetched: p.fetched,
              fresh: p.fresh,
              ...(p.message === undefined ? {} : { message: p.message }),
              ...(p.finished_at === undefined ? {} : { finished_at: p.finished_at }),
            })),
            pending: run.pending,
          },
        }),
    reading: run !== undefined && run.finished_at === undefined,
    ...(next === undefined ? {} : { next_run_at: next }),
    drafting: input.drafting,
    pending: view.pending.length,
  }
}

/** 一条写 → 侧边栏上那一行。 */
export function panelWriteOf(v: RedditWriteView): PanelWrite {
  return {
    job_id: v.job_id,
    approval_item_id: v.approval_item_id,
    state: v.state,
    subreddit: v.subreddit,
    queued_at: v.queued_at,
    ...(v.label === undefined ? {} : { label: v.label }),
    ...(v.message === undefined ? {} : { message: v.message }),
    ...(v.link === undefined ? {} : { link: v.link }),
    ...(v.record_id === undefined ? {} : { record_id: v.record_id }),
    ...(v.can_refill === undefined ? {} : { can_refill: v.can_refill }),
    ...(v.finished_at === undefined ? {} : { finished_at: v.finished_at }),
  }
}

/**
 * 侧边栏留哪几条写：最近 {@link PANEL_WRITES_DAYS} 天、没收起的；已发的只留一天（之后在「记录」里）。
 * 同一张卡再填过几次只留最新那一件。新的在前。
 */
export function recentWrites(rows: readonly RedditWriteView[], now: Iso8601): PanelWrite[] {
  const nowMs = Date.parse(now)
  const seen = new Set<string>()
  return [...rows]
    .sort((a, b) => Date.parse(b.queued_at) - Date.parse(a.queued_at))
    .filter((r) => {
      if (r.dismissed === true || seen.has(r.approval_item_id)) return false
      const at = Date.parse(r.finished_at ?? r.queued_at)
      const keep = r.state === 'sent' ? DAY_MS : PANEL_WRITES_DAYS * DAY_MS
      if (Number.isFinite(at) && nowMs - at > keep) return false
      seen.add(r.approval_item_id)
      return true
    })
    .slice(0, 30)
    .map(panelWriteOf)
}

/** 一行写进某个去处的状态 → 侧边栏上的一格（还在退避重试的、带错的算「没写进去」）。 */
export function sinkResultOf(name: string, w: SinkWrite): PanelSinkResult {
  if (w.status === 'written') return { name, status: 'written' }
  if (w.last_error !== undefined) return { name, status: 'failed', message: w.last_error.message }
  return { name, status: 'pending' }
}

/** 发出记录 → 侧边栏「记录」那一行（带各去处写没写进去；`approval_item_id` 留给路由按人筛）。 */
export function panelRecordOf(
  r: OutboundRecord,
  sinks: readonly RecordSinkView[],
  writesOf: ((record_id: string) => SinkWrite[]) | undefined,
): PanelRecord & { approval_item_id?: string } {
  const writes = writesOf?.(r.id) ?? []
  const results: PanelSinkResult[] = []
  for (const w of writes) {
    const sink = sinks.find((s) => s.id === w.sink_id)
    if (sink !== undefined) results.push(sinkResultOf(sink.name, w))
  }
  return {
    id: r.id,
    sent_at: r.sent_at,
    channel: r.channel,
    action: r.action,
    content: r.content,
    status: r.status,
    ...(r.destination === undefined ? {} : { destination: r.destination }),
    ...(r.counterpart === undefined ? {} : { counterpart: r.counterpart }),
    ...(r.link === undefined ? {} : { link: r.link }),
    ...(r.approved_by === undefined ? {} : { approved_by: r.approved_by }),
    ...(r.approved_via === 'extension' ? { via_extension: true } : {}),
    sinks: results,
    ...(r.approval_item_id === undefined ? {} : { approval_item_id: r.approval_item_id }),
  }
}

/** 去处列表那一行。 */
export function panelSinkOf(s: RecordSinkView): PanelSinkView {
  return {
    name: s.name,
    state: s.state,
    written: s.written,
    pending: s.pending,
    ...(s.last_error === undefined ? {} : { last_error: s.last_error.message }),
  }
}

/**
 * 发出记录那一行补上「在哪儿批的」（WP413：在插件里批的记 `extension`）。卡找不到 / 没决定就原样。
 * 接在 Reddit 写的 `record` 那一跳（宿主装配）。
 */
export function withApprovalVia(
  input: OutboundRecordInput,
  approval: (id: string) => Pick<ApprovalItem, 'decision'> | undefined,
): OutboundRecordInput {
  if (input.approval_item_id === undefined || input.approved_via !== undefined) return input
  const via = approval(input.approval_item_id)?.decision?.via
  return via === undefined ? input : { ...input, approved_via: via }
}

export function createExtensionPanelPort(options: ExtensionPanelOptions): ExtensionPanelPort {
  const facts = async (ws: WorkspaceId): Promise<ExtensionPanelFacts> => {
    const now = options.now()
    const [name, watch, writes] = await Promise.all([
      options.workspaceName(ws).catch(() => undefined),
      options.watch(ws).catch(() => undefined),
      options.writes(ws).catch(() => undefined),
    ])
    const view = watch?.view()
    const progress: PanelProgress =
      view === undefined
        ? { configured: false, reading: false, drafting: 0, pending: 0 }
        : progressOf({
            view,
            drafting: watch?.items({ status: 'drafting' }).length ?? 0,
            now,
            tz_offset_minutes: options.tzOffsetMinutes(ws),
          })
    const sinks = options.outbound.sinks(ws)
    const writesOf =
      options.outbound.writesOf === undefined
        ? undefined
        : (id: string) => options.outbound.writesOf?.(ws, id) ?? []
    return {
      ...(name === undefined ? {} : { workspace_name: name }),
      progress,
      writes: recentWrites(writes?.writes() ?? [], now),
      records: options.outbound
        .list(ws, { channel: 'reddit', limit: PANEL_RECORDS_MAX })
        .map((r) => panelRecordOf(r, sinks, writesOf)),
      sinks: sinks.map(panelSinkOf),
    }
  }
  return {
    facts: (session) => facts(session.workspace_id),
    async deliverNow(session, item_id) {
      let message: string | undefined
      try {
        await options.applyNow(item_id)
      } catch (err) {
        // 已经交出去了（别处先施行过）也算交出去了；别的照实说
        message = err instanceof Error ? err.message : String(err)
      }
      const writes = await options.writes(session.workspace_id).catch(() => undefined)
      const row = [...(writes?.writes() ?? [])]
        .filter((w) => w.approval_item_id === item_id)
        .sort((a, b) => Date.parse(b.queued_at) - Date.parse(a.queued_at))[0]
      if (row !== undefined) return { write: panelWriteOf(row) }
      return { message: message ?? '批好了，正在交给插件。' }
    },
    async refill(session, job_id) {
      const writes = await options.writes(session.workspace_id)
      if (writes === undefined) return { ok: false, message: '这个品牌没有装 Reddit 写。' }
      const out = await writes.refill(job_id)
      return out.ok ? { ok: true, write: panelWriteOf(out.view) } : out
    },
  }
}
