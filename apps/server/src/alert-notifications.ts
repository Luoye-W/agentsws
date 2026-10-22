/**
 * WP466（决策 1311 / 1404）：原来首页告警区的系统卡（`system_alert`）→ 铃铛里一条通知。
 *
 * WP438 首页重排以后告警区（`AlertBlocks`）没挂到任何页面上：店铺日报异常、广告改动提醒、目标市场校正、
 * 退役模型换了、WP448 的改版回归——接口（`GET /v1/home` 的 `alerts`）里都有，界面上看不到。
 * 现在不另做一个区，每张系统卡在铃铛里一条：
 *
 * - **文字** = 卡的标题；**点了去哪** = 卡上的 `detail.payload.open_path`（岗位 / 职责页、事项、设置页）。
 *   系统卡没有 `/cards/:id` 那一页，没写去处的就只是告诉一声；
 * - **键** = `alert:` + 卡的 `dedupe_key`（没有就用 id）：同一张卡一直挂着不加计数、不把读过的变回未读
 *   （它是一个「状态」，不是一件件来的事）；
 * - **卡不在了**（日报异常过了当天、广告改动处理了、改版回归改回去了、7 天到了）→ 那条收成已读；
 * - **紧急档**：店铺日报异常、改版回归·严重、广告改动没做成 / 读回对不上 / 等你确认，以及别的标了 P0 / P1
 *   的系统卡——没读时排最上面、红点；「系统」开着时只有这几条弹系统通知；
 * - 有按钮要人定的（广告改动「确认提交 / 撤销」在职责页那一块里点）仍走原处，铃铛这条只是指过去。
 *
 * 新的告警种类不用改这里：服务端照旧往 `WorkstationData.systemCards` 里放一张 `system_alert`
 * （`payload.kind` + `open_path`，要紧急就 `priority_band: 'P1'` 或 `payload.urgent: true`），铃铛自己就有。
 */
import type { NotificationInput, PersonId, WorkspaceId } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'

/** 告警那几条通知的键都以它开头（同步时只收这一类）。 */
export const ALERT_KEY_PREFIX = 'alert:'

/** 一张系统卡在铃铛里的键。 */
export const alertKey = (card: Pick<DeckCard, 'id' | 'dedupe_key'>): string =>
  `${ALERT_KEY_PREFIX}${card.dedupe_key === '' ? card.id : card.dedupe_key}`

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const payloadOf = (card: DeckCard): Record<string, unknown> => {
  const p = card.detail.payload
  return isRecord(p) ? p : {}
}

/**
 * 每种告警算不算紧急（一张表，测试与装配同一份）。不在表里的按卡的档位：P0 / P1 紧急、其余普通。
 */
const URGENT_BY_KIND: Readonly<Record<string, (p: Record<string, unknown>) => boolean>> = {
  // WP418：店铺日报查出来的异常（销售骤降 / 断货）——东西坏了
  store_anomaly: () => true,
  // WP448：改版回归里严重的那几条（只有「严重」才出卡）
  seo_drift: () => true,
  // WP316：没做成 / 读回对不上 / 平台预览好了等你确认 → 紧急；退回、交给你 → 普通
  ads_change: (p) =>
    p.state === 'failed' || p.readback_ok === false || p.state === 'waiting_confirm',
  // WP169 / WP294：只是告诉一声
  markets_store_sync: () => false,
  retired_model_swap: () => false,
}

export function alertUrgent(card: DeckCard): boolean {
  const p = payloadOf(card)
  if (p.urgent === true) return true
  const kind = typeof p.kind === 'string' ? p.kind : undefined
  const rule = kind === undefined ? undefined : URGENT_BY_KIND[kind]
  if (rule !== undefined) return rule(p)
  return card.priority_band === 'P0' || card.priority_band === 'P1'
}

/** 点了去哪：卡上写的工作台地址（`/` 开头、不是 `//`）；没有就只告诉一声。 */
export function alertHref(card: DeckCard): string | undefined {
  const path = payloadOf(card).open_path
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')
    ? path
    : undefined
}

/** 一张系统卡 → 一条通知（不是 `system_alert` 的回 undefined）。 */
export function alertNotificationOf(
  card: DeckCard,
  actor: { workspace_id: WorkspaceId; person_id: PersonId },
): NotificationInput | undefined {
  if (card.kind !== 'system_alert') return undefined
  const text = card.title.trim()
  if (text === '') return undefined
  const href = alertHref(card)
  const urgent = alertUrgent(card)
  return {
    workspace_id: actor.workspace_id,
    person_id: actor.person_id,
    category: 'alert',
    text,
    ...(href === undefined ? {} : { href }),
    key: alertKey(card),
    ...(urgent ? { urgent: true } : {}),
  }
}
