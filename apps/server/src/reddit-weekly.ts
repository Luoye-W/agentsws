/**
 * WP330（docs/102 附：甲方周报要求；文末「Luoye 10-14 定」）：**Reddit 周报**的服务端那一半。
 *
 * - **什么时候**：每周五 17:00（工作区时区；定时任务里可改），先让 WP328 做本周最后一次巡查
 *   （{@link RedditWeekSource.sweepNow}），再出周报；数据窗口「周日 00:00 — 出报告那一刻」（起始日可改）。
 * - **数据**：WP328 巡查入库的条目（{@link RedditWeekSource}）+ WP323 发出记录里本周的 Reddit 回复。
 *   怎么数、怎么归组在 `@agentsws/social-core` 的 `composeRedditWeekly`（纯函数）。
 * - **出什么**：一张周报卡（`weekly_review` 同一类：L3 自动出、看完归档、不进审批队列），发给担
 *   `social.reddit`（没有就 `pr.reddit`）的人；卡上能复制 / 导出 Markdown。同一周再出 = 同一张卡出新一版。
 * - **记录去处**：用户配的去处里，筛选点名了 `weekly_report` 的，记一行（正文 = 整份 Markdown）。
 * - **分节与措辞**：品牌自己一份（{@link RedditWeeklyService.setFormat}），用户几句话交代、AI 用工具改。
 *
 * 没配 Reddit 巡查（没有自家版块、也没有外部关键词）就不出——不出 0。
 */
import type {
  ApprovalBus,
  Assignment,
  Clock,
  Iso8601,
  RedditWatchItem,
  RedditWeeklyFormat,
  RedditWeeklyPayload,
  WorkspaceId,
} from '@agentsws/contracts'
import { REDDIT_WEEKLY_ACTION } from '@agentsws/contracts'
import {
  composeRedditWeekly,
  normalizeRedditWeeklyFormat,
  redditWeekWindow,
} from '@agentsws/social-core'
import type { OutboundLog } from './outbound/log.js'
import type { RedditWeeklyStore } from './reddit-weekly-store.js'

type MaybePromise<T> = T | Promise<T>

/**
 * **WP328 要交的那一份**（一个品牌一个）。WP328 合进来之前由 {@link EMPTY_REDDIT_WEEK_SOURCE} 顶着
 * （= 没配，周报不出）；测试用替身。
 */
export interface RedditWeekSource {
  /** 配没配 Reddit 巡查（自家版块或外部关键词有一样就算）。 */
  configured(): MaybePromise<boolean>
  /** 自家版块（用户配的，不带 `r/`）。 */
  subreddits(): MaybePromise<string[]>
  /** 窗口里入库的条目（按 Reddit 上的发出时间挑；多给也行，周报会再按窗口挑一遍）。 */
  items(window: { since: Iso8601; until: Iso8601 }): MaybePromise<RedditWatchItem[]>
  /** 窗口里各次巡查跑完的时间。 */
  sweeps(window: { since: Iso8601; until: Iso8601 }): MaybePromise<Iso8601[]>
  /** 现在做一次巡查（周报前的「本周最后一次」）。没有就直接用已入库的。 */
  sweepNow?(): Promise<unknown>
}

export const EMPTY_REDDIT_WEEK_SOURCE: RedditWeekSource = {
  configured: () => false,
  subreddits: () => [],
  items: () => [],
  sweeps: () => [],
}

/** 补跑时「已经跨进新的一周」的判据：新的一周开始还不到两天。 */
const LATE_MS = 2 * 86_400_000

/** 周报发给担这几条职责的人（按先后取第一个担着的）。 */
export const REDDIT_WEEKLY_ROLES = ['social.reddit', 'pr.reddit'] as const

export interface RedditWeeklyServiceOptions {
  workspace_id: WorkspaceId
  clock: Clock
  tzOffsetMinutes(): number
  brandName(): string | undefined
  assignments(): Assignment[]
  approvals: Pick<ApprovalBus, 'create'>
  store: RedditWeeklyStore
  source(): RedditWeekSource
  outbound?: Pick<OutboundLog, 'list' | 'record' | 'sinks'>
}

export interface RedditWeeklyRunResult {
  approval_item_id?: string
  week_of?: string
  skipped?: string
  /** 记进了发出记录（有去处点名要周报时）。 */
  recorded?: boolean
  /** 最后一次巡查没跑成的原话（照样出周报，用已入库的）。 */
  sweep_failed?: string
}

export interface RedditWeeklyService {
  /** 现在拼一份（不巡查、不出卡、不存；预览用）。没配就是 `undefined`。 */
  build(): Promise<RedditWeeklyPayload | undefined>
  /** 定时那一拍：最后一次巡查 → 拼 → 存 → 出卡 → 记录去处。 */
  run(options?: {
    sweep?: boolean
    /**
     * 关机错过、这是补跑：已经跨进新的一周头两天了，就出**上一周**的（起始日 00:00 — 下一个起始日 00:00），
     * 不出一份只有一两天的「这周」。
     */
    late?: boolean
  }): Promise<RedditWeeklyRunResult>
  /** 存着的某一周（不给 = 最近一份）。 */
  report(week_of?: string): RedditWeeklyPayload | undefined
  /** 导出文档（Markdown）。 */
  exportDoc(week_of?: string): { filename: string; content: string } | undefined
  format(): RedditWeeklyFormat
  /** 叠一份改动（AI 按用户的话给的）。`reset: true` 先回默认再叠。 */
  setFormat(
    raw: unknown,
    options?: { reset?: boolean },
  ): { format: RedditWeeklyFormat; problems: string[] }
}

export function createRedditWeeklyService(
  options: RedditWeeklyServiceOptions,
): RedditWeeklyService {
  const ws = options.workspace_id
  const holder = (): Assignment | undefined => {
    const live = options.assignments().filter((a) => a.revoked_at === undefined)
    for (const role of REDDIT_WEEKLY_ROLES) {
      const a = live.find((x) => x.role_id === role)
      if (a !== undefined) return a
    }
    return undefined
  }

  const build = async (late = false): Promise<RedditWeeklyPayload | undefined> => {
    const source = options.source()
    if (!(await source.configured())) return undefined
    const format = options.store.format(ws)
    const tz = options.tzOffsetMinutes()
    const now = options.clock.now()
    let window = redditWeekWindow(now, tz, format.window_start_weekday)
    if (late && Date.parse(now) - Date.parse(window.since) < LATE_MS) {
      const prev = redditWeekWindow(
        new Date(Date.parse(window.since) - 1).toISOString(),
        tz,
        format.window_start_weekday,
      )
      window = {
        since: prev.since,
        until: new Date(Date.parse(window.since) - 1).toISOString(),
        week_of: prev.week_of,
      }
    }
    const range = { since: window.since, until: window.until }
    const [items, sweeps, subreddits] = await Promise.all([
      source.items(range),
      source.sweeps(range),
      source.subreddits(),
    ])
    const records = options.outbound?.list(ws, { channel: 'reddit', ...range, limit: 5000 }) ?? []
    const brand = options.brandName()
    return composeRedditWeekly({
      now,
      window,
      tzOffsetMinutes: tz,
      format,
      ...(brand === undefined ? {} : { brand }),
      subreddits,
      items,
      records,
      sweeps,
    })
  }

  /** 有去处点名要周报才记一行（同一周只记一次）。 */
  const recordToSinks = (p: RedditWeeklyPayload): boolean => {
    const out = options.outbound
    if (out === undefined) return false
    const wanted = out
      .sinks(ws)
      .some(
        (s) =>
          (s.state === 'active' || s.state === 'broken') &&
          s.filter.actions?.includes(REDDIT_WEEKLY_ACTION) === true,
      )
    if (!wanted) return false
    out.record(ws, {
      source_key: `report:reddit_weekly:${p.week_of}`,
      sent_at: p.generated_at,
      channel: 'reddit',
      action: REDDIT_WEEKLY_ACTION,
      kind: 'reddit_weekly',
      destination: '周报',
      thread_title: p.title,
      content: p.markdown,
      approved_by: '自动',
    })
    return true
  }

  const filenameOf = (p: RedditWeeklyPayload): string => `reddit-weekly-${p.week_of}.md`

  return {
    build: () => build(),
    async run(runOptions) {
      const owner = holder()
      if (owner === undefined) return { skipped: '这个品牌没人担 Reddit 运营，周报没人收' }
      const source = options.source()
      if (!(await source.configured()))
        return { skipped: '没配 Reddit 巡查（自家版块、外部关键词都没有）' }
      let sweep_failed: string | undefined
      if (runOptions?.sweep !== false && source.sweepNow !== undefined) {
        try {
          await source.sweepNow()
        } catch (e) {
          sweep_failed = e instanceof Error ? e.message : String(e)
        }
      }
      const payload = await build(runOptions?.late === true)
      if (payload === undefined) return { skipped: '没配 Reddit 巡查' }
      options.store.putReport(ws, payload)
      const item = await options.approvals.create<RedditWeeklyPayload>({
        workspace_id: ws,
        schema_version: 1,
        // 与经营一页纸同一类：看一眼就过的报表（NOT_A_CARD），不进审批队列
        kind: 'weekly_review',
        role_id: owner.role_id,
        subject: { object: { type: 'workspace', id: ws } },
        dedupe_key: `dk_${ws}|reddit_weekly|${payload.week_of}`,
        title: payload.title,
        summary: payload.summary,
        payload,
        evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
        proposer: { kind: 'agent', id: `agent_${owner.role_id}`, assignment_id: owner.id },
        automation: {
          level_at_creation: 'L3',
          auto_approved: true,
          mandate_check: { within: true, caps_hit: [] },
          sampling: { selected: false },
        },
        routing: {
          recipients: [{ person: owner.person_id, via: 'role_holder' }],
          rule: 'role_holder',
          escalation: { after_hours: 72, business_hours: true, chain: [], escalated_at: [] },
          separation_of_duties: false,
        },
        priority: 'digest',
      })
      const recorded = recordToSinks(payload)
      return {
        approval_item_id: item.id,
        week_of: payload.week_of,
        ...(recorded ? { recorded } : {}),
        ...(sweep_failed === undefined ? {} : { sweep_failed }),
      }
    },
    report: (week_of) => options.store.report(ws, week_of),
    exportDoc(week_of) {
      const p = options.store.report(ws, week_of)
      return p === undefined ? undefined : { filename: filenameOf(p), content: p.markdown }
    },
    format: () => options.store.format(ws),
    setFormat(raw, setOptions) {
      if (setOptions?.reset === true) options.store.resetFormat(ws)
      const r = normalizeRedditWeeklyFormat(raw, options.store.format(ws))
      const next = { ...r.format, updated_at: options.clock.now() }
      options.store.setFormat(ws, next)
      return { format: next, problems: r.problems }
    },
  }
}
