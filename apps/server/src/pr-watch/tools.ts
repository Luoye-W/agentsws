/**
 * WP386：`list_mentions`（信息监控查提及）的执行器。
 *
 * 按组 / 竞品 / 来源 / 情绪 / 时间窗查这个品牌的提及库，带回各条监控源的状态与上一轮的几句话（自动加拉、没拉到）。
 * **拉不到的源照实列出来**（`sources[].status: 'failed'` + `missing`），模型照实转述「没拉到」，不说成 0 条。
 *
 * 还没配监控源、库里也一条都没有：先看 Google 账号（docs/103 S5：没有就做不了，引导在浏览器里登录，问一次），
 * 再出信息监控配置卡（`needs_setup:pr.watch`）——「第一次用这条职责」就这样把卡弹出来。
 */
import {
  type Iso8601,
  MONITOR_GROUP_LABELS,
  type MonitorGroup,
  type MonitorSource,
  needsConnectionReason,
  type WorkspaceId,
} from '@agentsws/contracts'
import { LIST_MENTIONS_TOOL, type ToolExecution, type ToolExecutor } from '@agentsws/stand-ins'
import type { StoredMention } from '../pr.js'
import { PR_WATCH_REDDIT_TARGET, PR_WATCH_TARGET, type PrWatchAssembly } from './service.js'

const GROUPS: readonly MonitorGroup[] = ['own', 'competitor', 'industry', 'site']
const SENTIMENTS = ['negative', 'neutral', 'positive'] as const

export interface PrMonitorToolOptions {
  /** 这个品牌的信息监控与提及库（没装回 `undefined`）。 */
  of(workspace_id: WorkspaceId): Promise<
    | {
        watch: PrWatchAssembly
        mentions(filter: {
          group?: MonitorGroup
          competitor?: string
          source_id?: string
          since?: string
          until?: string
        }): StoredMention[]
        sources(): MonitorSource[]
      }
    | undefined
  >
  now(): Iso8601
  /**
   * Google 账号这一步（S5）：已连任一 Google 服务 → `true`；没连、也还没问过 → `false`（出一次连接卡）；
   * 问过了就信人 → `true`。
   */
  googleReady?(workspace_id: WorkspaceId): boolean
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

export function createPrMonitorToolExecutor(options: PrMonitorToolOptions): ToolExecutor {
  return async (call): Promise<ToolExecution> => {
    const bare = call.name.includes('.')
      ? call.name.slice(call.name.lastIndexOf('.') + 1)
      : call.name
    if (bare !== LIST_MENTIONS_TOOL)
      return { status: 'error', reason: `unsupported_tool: ${call.name}` }
    const ws = call.request.workspace_id
    const brand = await options.of(ws)
    if (brand === undefined)
      return { status: 'ok', data: { rows: 0, items: [], missing: '这台机器上没有装信息监控。' } }
    const input = call.input
    const sources = brand.sources()
    const all = brand.mentions({})
    if (sources.length === 0 && all.length === 0 && !brand.watch.configured()) {
      if (options.googleReady !== undefined && !options.googleReady(ws))
        return {
          status: 'error',
          reason: needsConnectionReason(
            'google_account',
            '信息监控靠 Google 提醒：先在这台电脑的浏览器里登录你的 Google 账号。',
          ),
        }
      return {
        status: 'error',
        reason: `needs_setup:${PR_WATCH_TARGET} 还没配监控源：我先按品牌档案和竞品列一份要建的 Google 提醒，你确认后建好、把 RSS 链接贴回来。`,
      }
    }
    const group = GROUPS.find((g) => g === str(input.group))
    const sentiment = SENTIMENTS.find((s) => s === str(input.sentiment))
    const competitor = str(input.competitor)
    const sourceArg = str(input.source)
    const source_id =
      sourceArg === undefined
        ? undefined
        : sourceArg.toLowerCase() === 'reddit'
          ? 'reddit'
          : (sources.find(
              (s) => s.id === sourceArg || s.label.toLowerCase() === sourceArg.toLowerCase(),
            )?.id ?? sourceArg)
    const days = Number(input.days)
    const since =
      str(input.since) ??
      new Date(
        Date.parse(options.now()) -
          (Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 7) * 86_400_000,
      ).toISOString()
    const until = str(input.until)
    const limit = Math.max(
      1,
      Math.min(100, Number.isFinite(Number(input.limit)) ? Number(input.limit) : 30),
    )
    const rows = brand
      .mentions({
        ...(group === undefined ? {} : { group }),
        ...(competitor === undefined ? {} : { competitor }),
        ...(source_id === undefined ? {} : { source_id }),
        since,
        ...(until === undefined ? {} : { until }),
      })
      .filter((m) => sentiment === undefined || m.sentiment === sentiment)
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
    const view = brand.watch.view()
    const failed = view.sources.filter((s) => s.status === 'failed' && s.paused !== true)
    const counts: Record<string, number> = {}
    for (const m of rows) {
      const g = m.group ?? 'own'
      counts[g] = (counts[g] ?? 0) + 1
    }
    // 决策 1086：已经有 feed 在拉、Reddit 还没定过 → 这一轮顺带出「Reddit 搜索词」配置卡（问一次，不点不开）
    const askReddit = brand.watch.askRedditOnce()
    return {
      status: 'ok',
      data: {
        ...(askReddit ? { needs_setup: PR_WATCH_REDDIT_TARGET } : {}),
        rows: rows.length,
        window: { since, ...(until === undefined ? {} : { until }) },
        by_group: Object.fromEntries(
          Object.entries(counts).map(([g, n]) => [
            MONITOR_GROUP_LABELS[g as MonitorGroup]?.zh ?? g,
            n,
          ]),
        ),
        items: rows.slice(0, limit).map((m) => ({
          id: m.id,
          group: MONITOR_GROUP_LABELS[m.group ?? 'own'].zh,
          ...(m.competitor === undefined ? {} : { competitor: m.competitor }),
          source: m.source,
          origin: m.origin,
          url: m.url,
          ...(m.title === undefined ? {} : { title: m.title }),
          text: m.text.slice(0, 300),
          ...(m.author === undefined ? {} : { author: m.author }),
          published_at: m.published_at,
          ...(m.sentiment === undefined ? {} : { sentiment: m.sentiment }),
          ...(m.triage === undefined ? {} : { triage: m.triage }),
          seen_count: m.seen_count,
        })),
        sources: view.sources.map((s) => ({
          id: s.id,
          label: s.label,
          group: MONITOR_GROUP_LABELS[s.group].zh,
          status: s.paused === true ? 'paused' : s.status,
          ...(s.last_ok_at === undefined ? {} : { last_ok_at: s.last_ok_at }),
          ...(s.last_error === undefined ? {} : { last_error: s.last_error }),
        })),
        summary: view.summary,
        ...(view.next_run_at === undefined ? {} : { next_run_at: view.next_run_at }),
        notes: view.last_run?.notes ?? [],
        ...(failed.length === 0
          ? {}
          : {
              missing: `${failed.length} 条监控源这次没拉到（${failed
                .slice(0, 5)
                .map((s) => `「${s.label}」`)
                .join('、')}）：它们那一块没有数，不等于没人提。`,
            }),
      },
      provenance: rows.slice(0, limit).map((m) => ({ type: 'mention', id: m.id })),
    }
  }
}
