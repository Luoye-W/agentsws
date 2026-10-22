/**
 * WP448（docs/109 §4.4）：改版回归里**严重**的那几条 → 铃铛里一条（`system_alert` 系统卡，WP466 起由铃铛来问时对一遍、紧急档；点了去处理）。
 *
 * 「出卡，指到是哪次改版」：卡上写是哪一次（主题发布那张卡 / 装卸了哪个 App / 每周例行）与几处严重问题；
 * 「去处理」打开交给建站的那件事（开了的话），没开就到 SEO 与 GEO 的职责页「改版回归」那一块。
 * 给担 SEO 与 GEO、担整站搭建的人看（都没担的人看不到）。7 天后自己消失（那时每周那一轮又比过了）。
 * 注意 / 知道一下两级不出卡：进每日 SEO 简报与面板。
 */
import type { DriftRun, SeoDriftView } from '@agentsws/contracts'
import { actionsFor, type DeckCard, labelsFor, layoutFor } from '@agentsws/deck'
import { driftLine } from '@agentsws/seo-core'

/** 严重回归的告警挂几天。 */
export const DRIFT_ALERT_DAYS = 7

const TRIGGER_WORDS: Record<DriftRun['trigger']['kind'], string> = {
  theme_publish: '主题发布',
  app_change: 'App 装卸',
  weekly: '例行检查',
  manual: '手动检查',
}

export function driftAlertCards(input: {
  view: SeoDriftView | undefined
  now: string
  /** 这个人担的、看得到这张卡的那条分配（SEO 与 GEO 或整站搭建）；没有 = 不给他出。 */
  position?: { position_id: string; role_id: string; href: string }
}): DeckCard[] {
  const run = input.view?.last_with_findings
  if (run === undefined || input.position === undefined) return []
  const severe = run.findings.filter((f) => f.severity === 'critical')
  if (severe.length === 0) return []
  const at = run.finished_at ?? run.started_at
  if (!(Date.parse(input.now) - Date.parse(at) < DRIFT_ALERT_DAYS * 86_400_000)) return []
  // 后面又比过一次、严重的都没了（改回去了）就不再提醒
  const last = input.view?.last
  if (
    last !== undefined &&
    last.id !== run.id &&
    !last.findings.some((f) => f.severity === 'critical') &&
    last.status !== 'failed'
  )
    return []
  const which = run.trigger.label ?? TRIGGER_WORDS[run.trigger.kind]
  const title = `改版回归：${which}之后 ${String(severe.length)} 处严重问题`
  const summary = [
    ...severe.slice(0, 3).map(driftLine),
    ...(severe.length > 3 ? [`还有 ${String(severe.length - 3)} 处`] : []),
    run.trigger.change_id === undefined ? '' : `改版：改动卡 ${run.trigger.change_id}`,
  ]
    .filter((x) => x !== '')
    .join('\n')
  const actions = actionsFor('system_alert', 'pending')
  const open_path =
    run.dispatched === undefined
      ? input.position.href
      : `/matters/${encodeURIComponent(run.dispatched.matter_id)}`
  return [
    {
      id: `seo_drift_${run.id}`,
      kind: 'system_alert',
      layout: layoutFor('system_alert'),
      status: 'pending',
      priority_band: 'P1',
      priority: 'queue',
      risk_class: 'medium',
      title,
      summary,
      content_variants: { zh_summary: summary },
      position_id: input.position.position_id,
      role_id: input.position.role_id,
      channel: 'system',
      source: 'system',
      highlights: [],
      evidence_chips: [],
      entity_chips: [],
      available_actions: actions,
      action_labels: labelsFor('system_alert', actions),
      detail: {
        payload: {
          kind: 'seo_drift',
          open_path,
          run_id: run.id,
          trigger: run.trigger,
          findings: severe,
        },
        precheck: {},
        citations: [],
        links: { children: [] },
        created_at: at,
        updated_at: at,
        proposer: { kind: 'system', id: 'seo_drift' },
        enrichment: { dropped_refs: 0 },
      },
      dedupe_key: `seo_drift|${run.id}`,
      snooze_count: 0,
      merge_count: 1,
      version: 1,
    } as DeckCard,
  ]
}
