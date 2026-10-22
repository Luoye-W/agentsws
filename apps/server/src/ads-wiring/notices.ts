/**
 * WP316：广告改动要人知道 / 要人点的那几件，出一张系统卡（`system_alert`，36 §2.2b）；WP466 起每张在铃铛里一条。
 *
 * - **等你确认**：平台预览好了（插件横条上也有同一对按钮）；
 * - **退回 / 交给你 / 读回对不上**：24 小时内的，说一句、点「去处理」到职责页那一块（截图、平台原话、撤销都在那里）。
 *
 * 不是审批卡：这几件的决定（确认提交 / 撤销）在职责页「广告改动」那一块里点，这里只负责让人看见。
 */
import type { AdsLedgerEntryView } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { actionsFor, labelsFor, layoutFor } from '@agentsws/deck'

const DAY_MS = 24 * 60 * 60 * 1000

const NOTICE: Partial<Record<string, string>> = {
  waiting_confirm: '平台预览好了，等你确认提交',
  rejected: '退回了，没提交',
  handover: '插件停下了，交给你',
  failed: '没做成',
}

export function adsNoticeCards(input: {
  rows: readonly AdsLedgerEntryView[]
  now: string
  /** 这个平台在本人身上的职责页地址（本人没有这条职责 = 不提醒）。 */
  hrefOf(platform: string): { href: string; position_id: string; role_id: string } | undefined
}): DeckCard[] {
  const out: DeckCard[] = []
  const nowMs = Date.parse(input.now)
  for (const row of input.rows) {
    if (row.kind === 'export_snapshot') continue
    const recent = nowMs - Date.parse(row.updated_at) < DAY_MS
    const readbackBad = row.state === 'done' && row.readback !== undefined && !row.readback.ok
    const what = readbackBad ? '读回对不上' : NOTICE[row.state]
    if (what === undefined) continue
    if (row.state !== 'waiting_confirm' && !recent) continue
    const where = input.hrefOf(row.platform)
    if (where === undefined) continue
    const title = `${what}：${row.title}`
    const summary =
      (readbackBad ? row.readback?.sentence : undefined) ??
      row.platform_errors ??
      row.sentence ??
      row.title
    const actions = actionsFor('system_alert', 'pending')
    out.push({
      id: `ads_change_${row.change_id}_${row.state}`,
      kind: 'system_alert',
      layout: layoutFor('system_alert'),
      status: 'pending',
      priority_band: row.state === 'waiting_confirm' ? 'P1' : 'P2',
      priority: row.state === 'waiting_confirm' ? 'immediate' : 'queue',
      risk_class: 'medium',
      title,
      summary,
      content_variants: { zh_summary: summary },
      position_id: where.position_id,
      role_id: where.role_id,
      channel: 'system',
      source: 'system',
      highlights: [],
      evidence_chips: [],
      entity_chips: [],
      available_actions: actions,
      action_labels: labelsFor('system_alert', actions),
      detail: {
        payload: {
          kind: 'ads_change',
          change_id: row.change_id,
          open_path: where.href,
          // WP466：铃铛按这两格分紧急档（没做成 / 读回对不上 / 等你确认）
          state: row.state,
          ...(readbackBad ? { readback_ok: false } : {}),
        },
        precheck: {},
        citations: [],
        links: { children: [] },
        created_at: row.updated_at,
        updated_at: row.updated_at,
        proposer: { kind: 'system', id: 'ads_wiring' },
        enrichment: { dropped_refs: 0 },
      },
      dedupe_key: `ads_change|${row.change_id}|${row.state}`,
      snooze_count: 0,
      merge_count: 1,
      version: 1,
    })
  }
  return out
}
