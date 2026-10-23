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
  ActionJob,
  PanelPost,
  PanelProgress,
  PanelRecord,
  PanelSentInput,
  PanelSinkResult,
  PanelSinkView,
  PanelStage,
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
  SocialAccount,
  SocialPost,
  WorkspaceId,
} from '@agentsws/contracts'
import { socialChannelSpec, socialComposeUrl } from '@agentsws/contracts'

const DAY_MS = 86_400_000
/** 批过的写在侧边栏留几天（已发的只留一天）。 */
export const PANEL_WRITES_DAYS = 7
/** 记录那一块最多几行。 */
export const PANEL_RECORDS_MAX = 20

/** 巡查那一份里侧边栏用得到的（`RedditWatchAssembly` 的子集）。 */
export interface PanelWatch {
  view(): RedditWatchView
  items(query?: { status?: 'open' | 'drafting' | 'done' | 'dismissed' }): unknown[]
  /** WP419：起草那一头卡在哪（老实现没有 = 不说卡在哪）。 */
  draftState?(): {
    queued: number
    reading_threads: boolean
    plugin_ready: boolean
    plugin_why?: string
  }
}

/** WP419：起草前那两道门（有没有人担、品牌号口吻定了没有）。 */
export interface PanelDraftGate {
  /** 有人担 Reddit 运营或外部版块（没人担 = 读到的不起草）。 */
  has_owner: boolean
  /** 口吻还没定（WP411：没定一条都不起草）。 */
  persona_needed: boolean
  /** 工坊里那张「品牌号怎么说话」卡（开着才有）。 */
  persona_card_id?: string
}

/** Reddit 写那一份里侧边栏用得到的（`RedditWriteService` 的子集）。 */
export interface PanelWrites {
  writes(): RedditWriteView[]
  refill(
    job_id: string,
    /** WP478（只加）：改过字再填。 */
    edit?: { text?: string },
  ): Promise<{ ok: true; view: RedditWriteView } | { ok: false; message: string }>
  /** WP432：人点「打开这一条」（老实现没有 = 侧边栏打不开，照实说）。 */
  open?(
    job_id: string,
    edit?: { text?: string; title?: string },
  ): Promise<{ ok: true; job: ActionJob; view: RedditWriteView } | { ok: false; message: string }>
  /** WP432：不发了。 */
  drop?(
    job_id: string,
    reason?: string,
  ): { ok: true; view: RedditWriteView } | { ok: false; message: string }
  /** WP445：插件里等你发的几条（看板与侧边栏顶上那一行同一个数）。 */
  inPlugin?(): number
  /** WP467：人自己发出去了，核过记「已记录」。 */
  recordSent?(
    job_id: string,
    input: PanelSentInput,
  ): { ok: true; view: RedditWriteView } | { ok: false; message: string }
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
  /** WP419：起草前那两道门（不给 = 不说卡在哪一道门）。 */
  draftGate?(ws: WorkspaceId): Promise<PanelDraftGate | undefined>
  /** WP419（决策 1231）：交给人发的社媒帖子（与各自挂的号）。不给 = 侧边栏没有这一块。 */
  handoffs?(ws: WorkspaceId): Promise<{ post: SocialPost; account?: SocialAccount }[]>
  /** WP432：工坊版本与插件文件夹里那一版（侧边栏底下比对用；不给 = 不说）。 */
  versions?(): { workshop?: string; folder?: string }
  /** WP432：这个人「等你发」那一类开没开系统通知（不给 = 开）。 */
  notifySystem?(ws: WorkspaceId, person_id: string): Promise<boolean>
  /** WP419：人在侧边栏里回话（发好了 / 不发了）。回 `false` = 不是交给人的那一条。 */
  answerPost?(
    ws: WorkspaceId,
    post_id: string,
    answer:
      | { done: true; by: string; link?: string }
      | { done: false; by: string; reason?: string },
  ): Promise<boolean>
}

/** WP419：交给人发的一条 → 侧边栏上那一行（发帖页只会是那几家的站）。认不出渠道回 `undefined`。 */
export function panelPostOf(
  post: SocialPost,
  account: SocialAccount | undefined,
): (PanelPost & { owner?: string }) | undefined {
  const compose = socialComposeUrl(post.channel, post.body, account?.url)
  if (compose === undefined || post.handoff === undefined) return undefined
  return {
    id: post.id,
    channel: post.channel,
    channel_label: socialChannelSpec(post.channel)?.zh ?? post.channel,
    account: account?.display_name ?? account?.handle ?? '',
    body: post.body,
    kind: post.kind,
    ...(post.scheduled_at === undefined ? {} : { scheduled_at: post.scheduled_at }),
    compose_url: compose.url,
    prefilled: compose.prefilled,
    media: post.media_refs?.length ?? 0,
    handed_at: post.handoff.at,
    ...(post.handoff.owner === undefined ? {} : { owner: post.handoff.owner }),
  }
}

/**
 * WP419（自查 R5 / U17）：读到了要回的、却还没出卡——照实说卡在哪一步。顺序就是起草那一头真正的先后：
 * 没人担 → 等读整串（插件读不了就说为什么）→ 等你定口吻 → 和品牌号说过的矛盾（等你看）→ 正在起草。
 * 什么都没卡（全出卡了 / 没有要回的）回 `undefined`。
 */
export function stageOf(input: {
  /** 开着、要回、还没出卡、不是矛盾的条数。 */
  open: number
  /** 和品牌号说过的矛盾、没出卡的条数。 */
  conflicts: number
  /** 起草没成（带原因）的条数与第一条原因。 */
  failed?: number
  failed_why?: string
  queued: number
  reading_threads: boolean
  plugin_ready: boolean
  plugin_why?: string
  gate?: PanelDraftGate
}): PanelStage | undefined {
  const { open, conflicts } = input
  if (open === 0 && conflicts === 0) return undefined
  if (open > 0 && input.gate?.has_owner === false)
    return {
      kind: 'no_owner',
      count: open,
      text: `读到 ${open} 条要回的，但没人担 Reddit 运营，不会起草`,
    }
  if (input.queued > 0 && input.reading_threads)
    return {
      kind: 'reading_thread',
      count: input.queued,
      text: `先在你的浏览器里读整串（${input.queued} 条），读完就起草`,
    }
  if (input.queued > 0 && !input.plugin_ready)
    return {
      kind: 'needs_plugin',
      count: input.queued,
      text: `${input.queued} 条要先读整串：${input.plugin_why ?? '插件这会儿读不了'}`,
    }
  if (open > 0 && input.gate?.persona_needed === true)
    return {
      kind: 'needs_persona',
      count: open,
      text: `${open} 条等你先定品牌号怎么说话`,
      ...(input.gate.persona_card_id === undefined ? {} : { card_id: input.gate.persona_card_id }),
    }
  const failed = Math.min(input.failed ?? 0, open)
  if (failed > 0)
    return {
      kind: 'draft_failed',
      count: failed,
      text: `${failed} 条没起草成：${input.failed_why ?? '原因没记下'}`,
    }
  if (open > 0) return { kind: 'drafting', count: open, text: `正在起草 ${open} 条` }
  return {
    kind: 'conflict',
    count: conflicts,
    text: `${conflicts} 条草稿和品牌号以前说的矛盾，没出卡，等你在工坊里看`,
  }
}

/** 巡查那一份 → 起草卡在哪一步（侧边栏「进度」与 AI 的 `list_reddit_pending` 同一句）。 */
export function watchStage(
  watch: PanelWatch,
  gate?: PanelDraftGate,
  view: RedditWatchView = watch.view(),
): PanelStage | undefined {
  const waiting = view.pending.filter((x) => x.status === 'open' && x.dup_of === undefined)
  const conflicts = waiting.filter((x) => x.conflict !== undefined).length
  // 起草没成、记了原因的（宿主把原因写在条目的 note 上）
  const failedRows = waiting.filter((x) => x.conflict === undefined && x.draft_failed === true)
  const ds = watch.draftState?.()
  return stageOf({
    open: waiting.length - conflicts,
    conflicts,
    ...(failedRows.length === 0
      ? {}
      : { failed: failedRows.length, failed_why: failedRows[0]?.note ?? '原因没记下' }),
    queued: ds?.queued ?? 0,
    reading_threads: ds?.reading_threads ?? false,
    plugin_ready: ds?.plugin_ready ?? true,
    ...(ds?.plugin_why === undefined ? {} : { plugin_why: ds.plugin_why }),
    ...(gate === undefined ? {} : { gate }),
  })
}

/** 最近 7 天品牌号已经回过、没再起草的几条。 */
export function repliedBefore(items: readonly unknown[], now: Iso8601): number {
  const since = Date.parse(now) - PANEL_WRITES_DAYS * DAY_MS
  return items.filter((x) => {
    const it = x as { replied_before?: boolean; status_at?: string }
    return it.replied_before === true && Date.parse(it.status_at ?? '') >= since
  }).length
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
    kind: v.kind,
    ...(v.text === undefined ? {} : { text: v.text }),
    ...(v.title === undefined ? {} : { title: v.title }),
  }
}

/** WP432：品牌本地的「今天」里发出去了几条（读回确认的；发出记录里 `sent` 的）。 */
export function sentToday(
  records: readonly Pick<OutboundRecord, 'sent_at' | 'status'>[],
  now: Iso8601,
  tz_offset_minutes: number,
): number {
  const tz = tz_offset_minutes * 60_000
  const day = (ms: number): number => Math.floor((ms + tz) / DAY_MS)
  const today = day(Date.parse(now))
  return records.filter((r) => r.status === 'sent' && day(Date.parse(r.sent_at)) === today).length
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
    let progress: PanelProgress =
      view === undefined
        ? { configured: false, reading: false, drafting: 0, pending: 0 }
        : progressOf({
            view,
            drafting: 0,
            now,
            tz_offset_minutes: options.tzOffsetMinutes(ws),
          })
    if (view !== undefined && watch !== undefined) {
      // WP419：「起草中」只数真在起草的（以前数的是已经出了卡的）；卡在哪一步照实说
      const gate = await options.draftGate?.(ws).catch(() => undefined)
      const stage = watchStage(watch, gate, view)
      const replied = repliedBefore(watch.items({ status: 'done' }), now)
      progress = {
        ...progress,
        drafting: stage?.kind === 'drafting' ? stage.count : 0,
        ...(stage === undefined ? {} : { stage }),
        ...(replied === 0 ? {} : { replied_before: replied }),
      }
    }
    // WP432：今天发了几条、等你发几条（侧边栏顶上那一行）
    const allWrites = writes?.writes() ?? []
    // WP445：等你发 = 还没在插件里打开的卡 + 批过、等你打开的（同一张卡算一条）
    const awaitingN = writes?.inPlugin?.() ?? allWrites.filter((w) => w.state === 'awaiting').length
    const reddit = options.outbound.list(ws, { channel: 'reddit', limit: 200 })
    progress = {
      ...progress,
      sent_today: sentToday(reddit, now, options.tzOffsetMinutes(ws)),
      awaiting: awaitingN,
    }
    const sinks = options.outbound.sinks(ws)
    const writesOf =
      options.outbound.writesOf === undefined
        ? undefined
        : (id: string) => options.outbound.writesOf?.(ws, id) ?? []
    const posts = ((await options.handoffs?.(ws).catch(() => [])) ?? [])
      .map((h) => panelPostOf(h.post, h.account))
      .filter((x): x is PanelPost & { owner?: string } => x !== undefined)
    return {
      ...(name === undefined ? {} : { workspace_name: name }),
      ...(posts.length === 0 ? {} : { posts }),
      progress,
      writes: recentWrites(allWrites, now),
      ...(options.versions === undefined ? {} : { versions: options.versions() }),
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
    async answerPost(session, post_id, answer) {
      if (options.answerPost === undefined) return { ok: false, message: '这个品牌没装社媒发帖。' }
      const done = await options.answerPost(session.workspace_id, post_id, {
        ...answer,
        by: session.person_id,
      } as never)
      return done
        ? { ok: true }
        : { ok: false, message: '这一条已经回过话了（在工坊里或另一处）。' }
    },
    async openWrite(session, job_id, edit) {
      const writes = await options.writes(session.workspace_id)
      if (writes?.open === undefined) return { ok: false, message: '这个品牌没有装 Reddit 写。' }
      const out = await writes.open(job_id, edit)
      return out.ok ? { ok: true, job: out.job, write: panelWriteOf(out.view) } : out
    },
    async sentWrite(session, job_id, input) {
      const writes = await options.writes(session.workspace_id)
      if (writes?.recordSent === undefined)
        return { ok: false, message: '这个品牌没有装 Reddit 写。' }
      const out = writes.recordSent(job_id, input)
      return out.ok ? { ok: true, write: panelWriteOf(out.view) } : out
    },
    async dropWrite(session, job_id, reason) {
      const writes = await options.writes(session.workspace_id)
      if (writes?.drop === undefined) return { ok: false, message: '这个品牌没有装 Reddit 写。' }
      const out = writes.drop(job_id, reason)
      return out.ok ? { ok: true } : out
    },
    async notifySystem(session) {
      return (await options.notifySystem?.(session.workspace_id, session.person_id)) ?? true
    },
    async refill(session, job_id, edit) {
      const writes = await options.writes(session.workspace_id)
      if (writes === undefined) return { ok: false, message: '这个品牌没有装 Reddit 写。' }
      const out = await writes.refill(job_id, edit)
      return out.ok ? { ok: true, write: panelWriteOf(out.view) } : out
    },
  }
}
