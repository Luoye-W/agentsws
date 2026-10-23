/**
 * WP372（决策 1004 / 1019）：右侧面板六张卡标题行的**一句摘要 + 状态点**。
 *
 * 注册表 `useStatus` 那一格（静态那一段的一部分），所以要**轻**：只读缓存或一个小请求。
 * 右上角图标也调它，但只要点不要摘要——那时 `detail` 为假，取摘要才要的那几样（报表、记录、模型）不发请求。
 *
 * 点的颜色（决策 1004）：红 = 坏了要修（连接没连上 / 过期、发出记录写不进去），黄 = 等你看（对话等你、计划等你点头）。
 */

import { useQueries, useQuery } from '@tanstack/react-query'
import { EXTENSION_NEEDS_KEY } from '@/components/connections/extension-onboard-card'
import { useScopeConversations } from '@/components/conversations/conversation-data'
import { MODEL_CHOICES_KEY } from '@/components/free-chat/model-picker'
import { useScopeMonitor } from '@/components/pr/use-scope-monitor'
import type { RailScope } from '@/components/rail/rail-scope'
import type { CardStatus, RailPanelBodyProps } from '@/components/rail/registry'
import { isListedSchedule, SCHEDULES_KEY, scheduleInScope } from '@/components/rail/schedule-count'
import { scopeAssignments, shortDate } from '@/components/reports/report-data'
import { useReportList } from '@/components/reports/use-report-list'
import {
  type ExtensionNeedsView,
  getExtensionNeeds,
  getMySchedules,
  getPlatformKit,
  getPositionConnections,
  getPositionRecords,
  type PositionConnectionItem,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import {
  COMPETITOR_WATCH_ROLES,
  competitorWatchKey,
  getCompetitorWatch,
} from '@/lib/competitor-watch-api'
import { getFreeChatModels } from '@/lib/free-chat'
import { listSinks, SINKS_KEY } from '@/lib/outbound-api'

/** 本周从周一 00:00 算（本地时间）。 */
export function weekStart(now: Date = new Date()): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

export function useConversationsStatus({ scope }: RailPanelBodyProps): CardStatus | undefined {
  const { t } = useApp()
  const { duties } = useScopeConversations(scope)
  const all = duties.flatMap((d) => d.matters)
  if (all.length === 0) return undefined
  // WP456-T3（§3.9）：卡头标题后面跟一个灰色计数（「对话 1」）
  const count = all.length
  const waiting = all.filter((m) => m.state === 'awaiting' || m.state === 'ready').length
  if (waiting > 0)
    return {
      summary: t('conv.summary.waiting', { n: waiting }),
      count,
      dot: 'attention',
      dotLabel: t('conv.dot.waiting', { n: waiting }),
    }
  const running = all.filter((m) => m.state === 'running').length
  if (running > 0) return { summary: t('conv.summary.running', { n: running }), count }
  return { summary: t('conv.summary.count', { n: all.length }), count }
}

/** 报表：最新一份的名字与日期（「周报 · 10-12」）。不亮点——报表看完即过，不要人做什么。 */
export function useReportsStatus(
  { scope }: RailPanelBodyProps,
  detail = true,
): CardStatus | undefined {
  const { t } = useApp()
  // WP438：报表卡收着时右边写「几份」（固定的报表；AI 写的报告文档归「产出」）
  const { list } = useReportList(scope, detail)
  const n = list?.reports.length ?? 0
  return n === 0 ? undefined : { summary: t('reports.card.summary', { n }) }
}

/** 产出：本周几份（记录）；发出记录写不进去的亮红点。 */
export function useOutputsStatus(
  { scope }: RailPanelBodyProps,
  detail = true,
): CardStatus | undefined {
  const { t } = useApp()
  const sinks = useQuery({ queryKey: SINKS_KEY, queryFn: listSinks, retry: false })
  const records = useQueries({
    queries: scopeAssignments(scope).map((a) => ({
      queryKey: ['records', a],
      queryFn: () => getPositionRecords(a),
      enabled: detail,
      retry: false,
    })),
  })
  const broken = (sinks.data ?? [])
    .filter((s) => s.state === 'broken')
    .reduce((n, s) => n + s.pending, 0)
  const since = weekStart()
  const week = records
    .flatMap((r) => r.data?.payload?.rows ?? [])
    .filter((row) => Date.parse(row.at) >= since).length
  const summary = week > 0 ? t('outputs.summary.week', { n: week }) : undefined
  if (broken > 0)
    return {
      ...(summary === undefined ? {} : { summary }),
      dot: 'alert',
      dotLabel: t('outputs.dot.broken', { n: broken }),
    }
  return summary === undefined ? undefined : { summary }
}

/** 「明早 9:00」「今天 15:30」「10-20 9:00」。 */
export function whenLabel(
  iso: string,
  t: (k: string, v?: Record<string, string | number>) => string,
  now: Date = new Date(),
): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(d) - day(now)) / 86_400_000)
  if (diff === 0) return t('plans.today', { time })
  if (diff === 1) return t(d.getHours() < 12 ? 'plans.tomorrow_am' : 'plans.tomorrow', { time })
  return `${shortDate(iso)} ${time}`
}

/**
 * WP392：这一层的竞品监控状态（只在担「店铺管理 / 亚马逊店铺运营」的那一层取；和卡里那一份同一个查询键）。
 */
function useCompetitorWatchStatus(scope: RailScope | undefined) {
  const assignment = scope?.roles?.find((r) =>
    COMPETITOR_WATCH_ROLES.includes(r.role_id),
  )?.assignment
  const q = useQuery({
    queryKey: competitorWatchKey(assignment ?? ''),
    queryFn: () => getCompetitorWatch(assignment as string),
    enabled: assignment !== undefined,
    retry: false,
    staleTime: 60_000,
  })
  return assignment === undefined || q.data === null ? undefined : q.data
}

/** 计划：下一次什么时候（「下次 明早 9:00」）；等你点头的亮黄点。 */
export function usePlansStatus({ scope }: RailPanelBodyProps): CardStatus | undefined {
  const { t } = useApp()
  const list = useQuery({
    queryKey: SCHEDULES_KEY,
    queryFn: getMySchedules,
    enabled: scope !== undefined,
    retry: false,
  })
  const competitor = useCompetitorWatchStatus(scope)
  // WP386：信息监控的下一次（「信息监控 · 明早 9:00」）也算这一层的计划
  const monitorNext = useScopeMonitor(scope)?.view?.next_run_at
  if (scope === undefined || list.data === undefined) return undefined
  const rows = list.data.filter((r) => isListedSchedule(r) && scheduleInScope(r, scope))
  const competitorNext = competitor?.next_read_at
  if (rows.length === 0 && monitorNext === undefined && competitorNext === undefined)
    return undefined
  const waiting = rows.filter((r) => r.params?.awaiting_approval === true).length
  const next = [
    ...rows
      .filter((r) => r.state !== 'paused' && r.next_fire_at !== undefined)
      .map((r) => r.next_fire_at as string),
    ...(competitorNext === undefined ? [] : [competitorNext]),
    ...(monitorNext === undefined ? [] : [monitorNext]),
  ].sort()[0]
  const summary = next === undefined ? undefined : t('plans.next', { when: whenLabel(next, t) })
  return {
    ...(summary === undefined ? {} : { summary }),
    ...(waiting > 0 ? { dot: 'attention', dotLabel: t('plans.dot.waiting', { n: waiting }) } : {}),
  }
}

/** 这一层要连的：岗位层全部；职责层只要这条职责用得上的（`needed_by` 里有它的名字）。 */
export function connectionsInScope(
  items: readonly PositionConnectionItem[],
  scope: RailScope,
): PositionConnectionItem[] {
  const usable = items.filter((i) => i.status === 'available')
  if (scope.tier === 'position') return usable
  return usable.filter((i) => i.needed_by.length === 0 || i.needed_by.includes(scope.name))
}

/** 连接要人处理吗：必需的没连上（过期 / 要重连也算没连上）。 */
export function connectionNeedsYou(item: PositionConnectionItem): boolean {
  return item.required && !item.connected
}

/** 岗位实体的 id（职责层用上一层的）。 */
export function positionIdOf(scope: RailScope | undefined): string | undefined {
  if (scope === undefined) return undefined
  return scope.tier === 'role' ? scope.parent?.scope_id : scope.scope_id
}

export function useScopeConnections(scope: RailScope | undefined): {
  items: PositionConnectionItem[]
  ready: boolean
  /** WP415：职责要、且已经连上的那几条（服务端给；老服务端没有 = 空）。 */
  connected: string[]
} {
  // 岗位连接接口认的是岗位页地址里那条分配（与岗位页同一个查询键，缓存共用）
  const id = scope?.tier === 'role' ? (scope.assignment ?? '') : (scope?.assignment ?? '')
  const q = useQuery({
    queryKey: ['position-connections', id],
    queryFn: () => getPositionConnections(id),
    enabled: id !== '',
    retry: false,
    staleTime: 60_000,
  })
  if (scope === undefined) return { items: [], ready: true, connected: [] }
  return {
    items: connectionsInScope(q.data?.items ?? [], scope),
    ready: !q.isPending,
    connected: q.data?.connected ?? [],
  }
}

/**
 * WP415（自查 R4，决策 1239）：连接那一行的一句话——只有**真连好且真被用到**时才说「都连好了」。
 *
 * - 必需的没连（含要开发者配置的）→「N 个要处理」+ 红点；
 * - 只缺可选的 →「可选 N 个没连」（不亮红点，但不说「都连好了」）；
 * - 什么都不缺、且这个岗位真有连上在用的 →「都连好了」；
 * - 什么都不要 → 不出这一句。
 */
export function connectionsSummary(
  items: readonly PositionConnectionItem[],
  connected: readonly string[],
): { kind: 'todo' | 'optional' | 'ok'; n: number } | undefined {
  const todo = items.filter(connectionNeedsYou).length
  if (todo > 0) return { kind: 'todo', n: todo }
  const optional = items.filter((i) => !i.connected).length
  if (optional > 0) return { kind: 'optional', n: optional }
  if (connected.length > 0) return { kind: 'ok', n: connected.length }
  return undefined
}

/**
 * WP419（主会话 Mac 自测 / 自查 S10）：这一层的职责要浏览器插件时，插件的状态（与岗位页顶上那张装插件卡同一份查询）。
 * 不要插件 / 还没查到回 `undefined`。
 */
export function useScopeExtensionNeeds(
  scope: RailScope | undefined,
): ExtensionNeedsView | undefined {
  const roleIds = (scope?.roles ?? []).map((r) => r.role_id)
  const assignment = scope?.assignment
  const q = useQuery({
    queryKey: [EXTENSION_NEEDS_KEY, assignment, roleIds.join(',')],
    queryFn: () => getExtensionNeeds(roleIds, assignment),
    enabled: roleIds.length > 0 && assignment !== undefined,
    retry: false,
    staleTime: 30_000,
  })
  return q.data?.needed === true ? q.data : undefined
}

/** 连接：几个要处理（亮红点），都好了就说「都连好了」。 */
export function useConnectionsStatus({ scope }: RailPanelBodyProps): CardStatus | undefined {
  const { t } = useApp()
  const { items, connected } = useScopeConnections(scope)
  // WP419：要插件的岗位，插件没配上 / 配上了还差一步（连 Reddit 之类）→ 红点，不说「都连好了」
  const ext = useScopeExtensionNeeds(scope)
  // WP386：信息监控有拉不到的源 → 红点（汇总那一句照搬：「17 条 · 1 条拉不到」）
  const monitor = useScopeMonitor(scope)?.view
  // WP392：竞品监控有没读到的那几家，也算要处理（红点；照实说几家）。钩子先都调完再判
  const competitor = useCompetitorWatchStatus(scope)
  // WP418（自查 U1）：建站平台还没选时，不许说「都连好了」
  const positionId = positionIdOf(scope)
  const assignment = scope?.assignment
  const platform = useQuery({
    queryKey: ['platform-kit', positionId ?? '', assignment ?? ''],
    queryFn: () => getPlatformKit({ position_id: positionId ?? '' }, assignment),
    enabled: positionId !== undefined && scope?.tier === 'position',
    retry: false,
    staleTime: 60_000,
  })
  if (platform.data?.choose_platform !== undefined)
    return {
      summary: t('conncard.summary.no_platform'),
      dot: 'alert',
      dotLabel: t('conncard.summary.no_platform'),
    }
  if (monitor !== undefined && monitor.failed > 0)
    return { summary: monitor.summary, dot: 'alert', dotLabel: monitor.summary }
  const failed = competitor?.summary.failed ?? 0
  if (failed > 0)
    return {
      summary: t('cwatch.dot.failed', { n: competitor?.summary.failed_labels.length ?? failed }),
      dot: 'alert',
      dotLabel: t('cwatch.dot.failed', { n: competitor?.summary.failed_labels.length ?? failed }),
    }
  // WP419 / WP420（自查 A5 / U1 / S10）：要插件的这一层，插件没配对 / 后台没在插件里连上，不许说「都连好了」
  // （连接卡里插件那几行由 WP420 的 `ExtensionRows` 列，这里只给一句话 + 红点）
  // WP493：ego 能做全部时插件只是备用，不算「要处理」
  if (ext !== undefined && ext.plugin_backup !== true && !ext.paired)
    return {
      summary: t('conncard.summary.ext_install'),
      dot: 'alert',
      dotLabel: t('conncard.summary.ext_install'),
    }
  if (ext?.steps.some((s) => s.done === false) === true)
    return {
      summary: t('conncard.summary.ext_step'),
      dot: 'alert',
      dotLabel: t('conncard.summary.ext_step'),
    }
  const sum = connectionsSummary(items, connected)
  if (sum === undefined) return undefined
  if (sum.kind === 'ok') return { summary: t('conncard.summary.ok') }
  if (sum.kind === 'optional') return { summary: t('conncard.summary.optional', { n: sum.n }) }
  return {
    summary: t('conncard.summary.todo', { n: sum.n }),
    dot: 'alert',
    dotLabel: t('conncard.dot.todo', { n: sum.n }),
  }
}

/** 设定：现在用的 AI 叫什么（品牌默认那一个）。 */
export function useSettingsStatus(
  _props: RailPanelBodyProps,
  detail = true,
): CardStatus | undefined {
  const models = useQuery({
    queryKey: MODEL_CHOICES_KEY,
    queryFn: getFreeChatModels,
    enabled: detail,
    retry: false,
  })
  if (models.data === undefined) return undefined
  const label = models.data.choices.find((c) => c.id === models.data?.default)?.label
  // WP456-T3（决策 1447）：没接时什么都不写——「还没接 AI」只在输入框那一颗说
  return label === undefined ? undefined : { summary: label }
}
