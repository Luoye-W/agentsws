/**
 * WP418（自查 B7）：店铺管理的**每日日报卡 + 异常卡**——以前只在模拟世界里有，真机上只有面板现算。
 *
 * 一天一次（时间读职责 yml 里 `digest.daily_report` 那一行的 `digest_schedule`，默认每天 9 点）：
 *
 * 1. 取店铺管理那一面的面板上下文（`queryContext`，「昨天」那一段）——数只从面板来（29 原则 ③）；
 * 2. 拼日报：用面板上「店铺日报」那一块同一条查询（`store.daily_report`），出一张 `daily_report` 卡
 *    （L3 自动出、看完归档，不进审批队列）；
 * 3. 跑异常检测（`detectAnomalies`：销售骤降 / 断货，阈值读职责 yml 的 `thresholds`）——有异常就在铃铛（WP466，原首页告警区）
 *    出一行（`system_alert`，点进店铺管理），同一天同一种只出一次；没有就不出「一切正常」。
 *
 * 店铺没连 = 不出日报，照实回「店铺没连」（不出一张全是 0 的卡）。
 */
import type { PositionSummary, WorkstationPort } from '@agentsws/api'
import type { ApprovalBus, Assignment, Clock, WorkspaceId } from '@agentsws/contracts'
import {
  type Anomaly,
  actionsFor,
  type DeckCard,
  detectAnomalies,
  labelsFor,
  layoutFor,
  type QueryContext,
  runQuery,
  sourceStatus,
} from '@agentsws/deck'

export const STORE_ROLE = 'dtc.store'
/** 职责 yml 没写时的默认：每天 9 点。 */
export const STORE_DIGEST_DEFAULT_CRON = '0 9 * * *'

export interface StoreDigestOptions {
  workspace_id: WorkspaceId
  clock: Clock
  assignments(): Assignment[]
  approvals: Pick<ApprovalBus, 'create'>
  port(): Promise<WorkstationPort>
}

export interface StoreDigest {
  run(): Promise<{
    approval_item_id?: string
    anomalies?: number
    skipped?: string
    date?: string
  }>
  /** 系统卡那几张（WP466 起每张在铃铛里一条，原首页告警区；只给店铺管理担着的那个人；当天的）。 */
  alerts(person_id: string): DeckCard[]
}

/** 职责 yml 里日报那一行的时间（`digest_schedule`）；没写就默认。 */
export function storeDigestCron(
  notifications: readonly { event: string; digest_schedule?: string }[] | undefined,
): string {
  const hit = (notifications ?? []).find(
    (n) => n.event === 'digest.daily_report' && typeof n.digest_schedule === 'string',
  )
  return hit?.digest_schedule ?? STORE_DIGEST_DEFAULT_CRON
}

export function createStoreDigest(options: StoreDigestOptions): StoreDigest {
  const ws = options.workspace_id
  let latest:
    | { date: string; person_id: string; assignment_id: string; anomalies: Anomaly[] }
    | undefined

  const holder = (): Assignment | undefined =>
    options.assignments().find((a) => a.role_id === STORE_ROLE && a.revoked_at === undefined)

  const contextOf = async (a: Assignment): Promise<QueryContext | undefined> => {
    const port = await options.port()
    const actor = { workspace_id: ws, person_id: a.person_id }
    const position = (await port.positions(actor)).find(
      (p: PositionSummary) => p.position_id === a.id,
    )
    if (position === undefined) return undefined
    try {
      return await port.queryContext(actor, position, 'yesterday')
    } catch {
      return undefined
    }
  }

  return {
    async run() {
      const a = holder()
      if (a === undefined) return { skipped: '这个品牌没人担「店铺管理」' }
      const ctx = await contextOf(a)
      if (ctx === undefined) return { skipped: '店铺管理那一面的面板读不到' }
      if (!sourceStatus(ctx, 'shop')) return { skipped: '店铺没连上，日报没有数可写' }
      const report = runQuery('store.daily_report', ctx, 'yesterday')
      if (report.status !== 'ok') return { skipped: '店铺没连上，日报没有数可写' }
      const table = 'columns' in report.data ? report.data : undefined
      const rows = (table?.rows ?? []).map((r) => ({
        item: String((r as Record<string, unknown>).item ?? ''),
        value: String((r as Record<string, unknown>).value ?? ''),
      }))
      const date = String(table?.columns[0]?.label ?? ctx.now.slice(0, 10))
      const value = (item: string): string | undefined => rows.find((r) => r.item === item)?.value
      const anomalies = detectAnomalies({ ctx, range: 'yesterday' })
      const lines = [
        `销售额 ${value('销售额') ?? '—'}（环比 ${value('环比') ?? '—'}），订单 ${value('订单数') ?? '—'} 笔`,
        `库存告急 ${value('库存告急') ?? '—'}，待审改动 ${value('待审改动') ?? '—'}`,
        ...anomalies.map((x) => `异常：${x.title}`),
      ]
      const item = await options.approvals.create({
        workspace_id: ws,
        schema_version: 1,
        kind: 'daily_report',
        role_id: STORE_ROLE,
        subject: { object: { type: 'workspace', id: ws } },
        dedupe_key: `dk_${ws}|daily_report|${date}`,
        title: `店铺日报 ${date}${anomalies.length === 0 ? '' : ` · ${anomalies.length} 项异常`}`,
        summary: lines.join('\n'),
        payload: {
          date,
          rows,
          anomalies: anomalies.map((x) => ({
            kind: x.kind,
            title: x.title,
            threshold: x.threshold,
            actual: x.actual,
          })),
        },
        evidence: {
          run_id: `run_store_digest_${date}`,
          source_events: [],
          provenance: { seen: [] },
          precheck: {},
        },
        proposer: { kind: 'agent', id: `agent_${STORE_ROLE}`, assignment_id: a.id },
        automation: {
          // L3：日报看一眼就归档，不在谁的队列里压着
          level_at_creation: 'L3',
          auto_approved: true,
          mandate_check: { within: true, caps_hit: [] },
          sampling: { selected: false },
        },
        routing: {
          recipients: [{ person: a.person_id, via: 'role_holder' }],
          rule: 'role_holder',
          escalation: { after_hours: 24, business_hours: true, chain: [], escalated_at: [] },
          separation_of_duties: false,
        },
        priority: 'digest',
      })
      latest = { date, person_id: a.person_id, assignment_id: a.id, anomalies }
      return { approval_item_id: item.id, anomalies: anomalies.length, date }
    },

    alerts(person_id) {
      if (latest === undefined || latest.person_id !== person_id) return []
      const at = options.clock.now()
      const href = `/positions/${encodeURIComponent(latest.assignment_id)}/duties/${STORE_ROLE}`
      return latest.anomalies.map((x) => {
        const actions = actionsFor('system_alert', 'pending')
        const summary = `${x.title}（阈值 ${x.threshold}，实测 ${x.actual}）`
        return {
          id: `store_anomaly_${latest?.date}_${x.kind}`,
          kind: 'system_alert',
          layout: layoutFor('system_alert'),
          status: 'pending',
          priority_band: 'P2',
          priority: 'queue',
          risk_class: 'low',
          title: x.title,
          summary,
          content_variants: { zh_summary: summary },
          position_id: latest?.assignment_id ?? '',
          role_id: STORE_ROLE,
          channel: 'system',
          source: 'system',
          highlights: [],
          evidence_chips: [],
          entity_chips: [],
          available_actions: actions,
          action_labels: labelsFor('system_alert', actions),
          detail: {
            payload: {
              kind: 'store_anomaly',
              anomaly: x.kind,
              open_path: href,
              refs: x.refs ?? [],
            },
            precheck: {},
            citations: [],
            links: { children: [] },
            created_at: at,
            updated_at: at,
            proposer: { kind: 'system', id: 'store_digest' },
            enrichment: { dropped_refs: 0 },
          },
          dedupe_key: `store_anomaly|${latest?.date}|${x.kind}`,
          snooze_count: 0,
          merge_count: 1,
          version: 1,
        } as DeckCard
      })
    },
  }
}
