/**
 * WP438（WP434 设计第二阶段）：报表的几条接口。形状照 `@agentsws/deck` 的报表类型（数全在服务端算）。
 */
import type {
  ReportData,
  ReportMetricValue,
  ReportRange,
  ReportRefresh,
  ReportSpec,
  ReportSummary,
} from '@agentsws/deck'
import { api } from '@/lib/api'

export type { ReportData, ReportMetricValue, ReportRange, ReportRefresh, ReportSpec, ReportSummary }

const withAssignment = (assignment: string | undefined): { assignment?: string } =>
  assignment === undefined ? {} : { assignment }

export interface ReportList {
  reports: ReportSummary[]
  limit: number
  examples: string[]
}

export function listReports(input: {
  position: string
  duty?: string
  assignment?: string
}): Promise<ReportList> {
  const q = new URLSearchParams({ position: input.position })
  if (input.duty !== undefined) q.set('duty', input.duty)
  return api<ReportList>(`/v1/reports?${q.toString()}`, withAssignment(input.assignment))
}

export function getReport(input: {
  id: string
  range?: ReportRange
  at?: string
  assignment?: string
}): Promise<ReportData & { snapshot?: true }> {
  const q = new URLSearchParams()
  if (input.range !== undefined) q.set('range', input.range)
  if (input.at !== undefined) q.set('at', input.at)
  const qs = q.toString()
  return api(
    `/v1/reports/${encodeURIComponent(input.id)}${qs === '' ? '' : `?${qs}`}`,
    withAssignment(input.assignment),
  )
}

export function getReportSnapshots(
  id: string,
  assignment?: string,
): Promise<{ snapshots: { at: string; range: string }[] }> {
  return api(`/v1/reports/${encodeURIComponent(id)}/snapshots`, withAssignment(assignment))
}

export interface ComposeResult {
  draft: ReportData
  spec: ReportSpec
  reads: string[]
  answer: string
  matched: boolean
  suggest: { position: string; duty?: string; refresh: ReportRefresh }
}

export function composeReport(input: {
  prompt: string
  position?: string
  duty?: string
  assignment?: string
}): Promise<ComposeResult> {
  const { assignment, ...body } = input
  return api('/v1/reports/compose', { method: 'POST', body, ...withAssignment(assignment) })
}

export function pinReport(input: {
  id: string
  position: string
  duty?: string
  refresh: ReportRefresh
  assignment?: string
}): Promise<ReportSummary> {
  const { id, assignment, ...body } = input
  return api(`/v1/reports/${encodeURIComponent(id)}/pin`, {
    method: 'POST',
    body,
    ...withAssignment(assignment),
  })
}

export function reviseReport(input: {
  id: string
  prompt: string
  assignment?: string
}): Promise<{ changed: boolean; answer: string; version?: number }> {
  return api(`/v1/reports/${encodeURIComponent(input.id)}/revise`, {
    method: 'POST',
    body: { prompt: input.prompt },
    ...withAssignment(input.assignment),
  })
}

export function unpinReport(id: string, assignment?: string): Promise<{ removed: true }> {
  return api(`/v1/reports/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...withAssignment(assignment),
  })
}

export interface ReportsOverview {
  range: ReportRange
  key: { position: string; report_id: string; metric: ReportMetricValue; spark?: number[] }[]
  sentence?: { text: string; report_id: string; title: string }
  missing?: { label: string; source: string; unlocks: string }
  positions: {
    position: string
    report_id: string
    title: string
    headline_label: string
    headline: ReportMetricValue
    spark?: number[]
  }[]
}

export function getReportsOverview(range: ReportRange): Promise<ReportsOverview> {
  return api(`/v1/reports/overview?range=${range}`)
}

/** react-query 的 key 前缀（固定 / 拿掉之后整组重取）。 */
export const REPORTS_QUERY = ['reports'] as const
