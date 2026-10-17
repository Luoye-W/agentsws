/**
 * WP387：`report_google_alerts` 真接上（定义在 `@agentsws/stand-ins` 的 `runtime/google-alerts.ts`）。
 *
 * 只做入参清洗：认得出的字段原样交给 {@link PrAlertsService.report}，认不出的丢掉；
 * 这次运行请求上带的凭据（`browser_grants`）一起交过去——结果只有那张卡同意过的那一次运行能交。
 */
import type {
  ExistingGoogleAlert,
  GoogleAlertOutcome,
  GoogleAlertReportLine,
  GoogleAlertsReport,
  GoogleAlertsStop,
} from '@agentsws/contracts'
import { GOOGLE_ALERTS_TOOL_NAMES, type ToolExecutor } from '@agentsws/stand-ins'
import type { PrAlertsService } from './service.js'

const OUTCOMES: readonly GoogleAlertOutcome[] = [
  'created',
  'existing',
  'switched',
  'existing_email',
  'failed',
  'not_attempted',
]
const STOPS: readonly GoogleAlertsStop[] = [
  'done',
  'not_signed_in',
  'captcha',
  'page_changed',
  'other',
]

const str = (v: unknown, max = 500): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined
const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** 工具入参 → 报告（认不出的行 / 字段丢掉）。 */
export function reportOfInput(input: Record<string, unknown>): GoogleAlertsReport {
  const lines: GoogleAlertReportLine[] = []
  for (const raw of Array.isArray(input.lines) ? input.lines : []) {
    const r = rec(raw)
    const id = str(r.id, 40)
    const outcome = OUTCOMES.find((x) => x === r.outcome)
    if (id === undefined || outcome === undefined) continue
    const feed_url = str(r.feed_url)
    const reason = str(r.reason, 200)
    lines.push({
      id,
      outcome,
      ...(feed_url === undefined ? {} : { feed_url }),
      ...(reason === undefined ? {} : { reason }),
    })
  }
  const existing: ExistingGoogleAlert[] = []
  for (const raw of Array.isArray(input.existing) ? input.existing.slice(0, 500) : []) {
    const r = rec(raw)
    const query = str(r.query, 300)
    if (query === undefined) continue
    const delivery = r.delivery === 'rss' || r.delivery === 'email' ? r.delivery : 'unknown'
    const feed_url = str(r.feed_url)
    const language = str(r.language, 20)
    const region = str(r.region, 20)
    existing.push({
      query,
      delivery,
      ...(feed_url === undefined ? {} : { feed_url }),
      ...(language === undefined ? {} : { language }),
      ...(region === undefined ? {} : { region }),
    })
  }
  const change_id = str(input.change_id, 80)
  const note = str(input.note, 300)
  return {
    ...(change_id === undefined ? {} : { change_id }),
    lines,
    ...(existing.length === 0 ? {} : { existing }),
    stop: STOPS.find((s) => s === input.stop) ?? 'other',
    ...(note === undefined ? {} : { note }),
  }
}

export function createGoogleAlertsTool(service: () => PrAlertsService | undefined): ToolExecutor {
  return async (call) => {
    if (!GOOGLE_ALERTS_TOOL_NAMES.includes(call.name))
      return { status: 'error', reason: `unknown_tool: ${call.name}` }
    const svc = service()
    if (svc === undefined) return { status: 'error', reason: '信息监控还没准备好，结果没记下。' }
    const data = await svc.report(reportOfInput(call.input), {
      ...(call.request.browser_grants === undefined ? {} : { grants: call.request.browser_grants }),
    })
    return { status: data.ok ? 'ok' : 'error', data, ...(data.ok ? {} : { reason: data.message }) }
  }
}
