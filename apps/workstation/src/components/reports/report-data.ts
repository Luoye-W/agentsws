/**
 * WP372（决策 1019，Luoye 10-17）：右侧面板「报表」卡的取数。
 *
 * 报表 = 岗位路由带回来的「看完即过」那一类（WP141：日报 / 上线检查单；WP331：AI 发布的周报 / 日报；
 * WP224：本周经营一页纸）。原来摊在岗位页「要你处理」下面（`ReportBlocks`），现在中间栏只放要你拍板的卡，
 * 报表搬进右侧面板：卡上列最新几份，点一份在面板里看（`agentsws://report/<卡 id>`）。
 */
import type { DeckCard } from '@agentsws/deck'
import { useQueries } from '@tanstack/react-query'
import type { RailScope } from '@/components/rail/rail-scope'
import { getPositionCards } from '@/lib/api'

/** 在右侧面板里看一份报表的资源地址。 */
export const REPORT_ADDRESS_PREFIX = 'agentsws://report/'

export function reportAddress(id: string): string {
  return `${REPORT_ADDRESS_PREFIX}${encodeURIComponent(id)}`
}

export function reportIdOf(address: string | undefined): string | undefined {
  if (address === undefined || !address.startsWith(REPORT_ADDRESS_PREFIX)) return undefined
  return decodeURIComponent(address.slice(REPORT_ADDRESS_PREFIX.length))
}

export interface ReportItem {
  id: string
  title: string
  /** 这份是哪天出的（AI 发布的报告用 `published_at`，其余用卡的创建时间）。 */
  at: string
  card: DeckCard
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function atOf(card: DeckCard): string {
  const p = card.detail.payload
  if (isRecord(p) && typeof p.published_at === 'string') return p.published_at
  return card.detail.created_at
}

/** 这一层要看哪几条分配的报表：职责层那一条，岗位层本人在这个岗位的每一条。 */
export function scopeAssignments(scope: RailScope | undefined): string[] {
  if (scope === undefined) return []
  if (scope.tier === 'role') return scope.assignment === undefined ? [] : [scope.assignment]
  return [...(scope.assignments ?? (scope.assignment === undefined ? [] : [scope.assignment]))]
}

export const REPORTS_KEY = ['rail-reports'] as const

/** 这一层的报表，新的在前（同一份只留一次）。`enabled` 假 = 不发请求（右上角图标只要点，不要摘要）。 */
export function useScopeReports(
  scope: RailScope | undefined,
  enabled = true,
): { reports: ReportItem[]; ready: boolean } {
  const assignments = scopeAssignments(scope)
  const queries = useQueries({
    queries: assignments.map((a) => ({
      queryKey: [...REPORTS_KEY, a],
      queryFn: async () => (await getPositionCards(a)).reports ?? [],
      enabled,
      retry: false,
      staleTime: 60_000,
    })),
  })
  const seen = new Set<string>()
  const reports = queries
    .flatMap((q) => q.data ?? [])
    .filter((c) => {
      if (seen.has(c.id)) return false
      seen.add(c.id)
      return true
    })
    .map((card) => ({ id: card.id, title: card.title, at: atOf(card), card }))
    .sort((a, b) => b.at.localeCompare(a.at))
  return { reports, ready: queries.every((q) => !q.isPending) }
}

/** 「10-12」：月-日（本地时间）。 */
export function shortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}-${dd}`
}
