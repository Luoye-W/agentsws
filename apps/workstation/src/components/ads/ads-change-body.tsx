/**
 * WP420（自查 U2 / U3 / U4 / A12）：改预算 / 暂停卡的卡身。
 *
 * 以前走通用的「改之前 / 改之后」双格，把 `value` `platform` `platform label` `spend gate note`
 * 这些字段名原样露出来；总闸那句话一张卡出现三次。现在：
 * - 一行「日预算 $300 → $330」（暂停卡：「暂停「老客再营销」」）；
 * - 一句依据（摘要里去掉总闸那句——总闸只留卡头那个小标签）；
 * - 前面还排着同一条的改动就写一行；插件没连就在卡底一行灰字「批了先排队」。
 */
import type { ReactNode } from 'react'
import { useApp } from '@/lib/app-context'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

const KINDS = new Set(['budget_change', 'pause_ad'])

export interface AdsChangePayload {
  kind: string
  before?: unknown
  after: Record<string, unknown>
}

/** 这张卡是不是投放的改预算 / 暂停卡（上传表卡另有卡身）。 */
export function isAdsChangePayload(p: unknown): p is AdsChangePayload {
  return (
    isRecord(p) &&
    typeof p.kind === 'string' &&
    KINDS.has(p.kind) &&
    isRecord(p.after) &&
    typeof p.after.platform === 'string'
  )
}

/** 金额带币种符号（和上传表卡同一套）。 */
export function money(n: unknown, currency: string | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  const sym =
    currency === 'USD' || currency === 'CAD' || currency === 'AUD'
      ? '$'
      : currency === 'EUR'
        ? '€'
        : currency === 'GBP'
          ? '£'
          : currency === 'CNY' || currency === 'JPY'
            ? '¥'
            : ''
  const v = Number.isInteger(n) ? String(n) : n.toFixed(2)
  return sym === '' && currency !== undefined ? `${v} ${currency}` : `${sym}${v}`
}

/** 摘要里去掉总闸那一段（卡头小标签已经写了）。 */
export function reasonWithoutGate(text: string, gate: string | undefined): string {
  if (gate === undefined) return text
  return text
    .split('｜')
    .filter((s) => s.trim() !== gate.trim())
    .join('｜')
}

export function AdsChangeBody({
  payload,
  reason,
  title,
}: {
  payload: AdsChangePayload
  reason: string
  title: string
}): ReactNode {
  const { t } = useApp()
  const after = payload.after
  const before = isRecord(payload.before) ? payload.before : {}
  const currency = str(after.currency)
  const main =
    payload.kind === 'budget_change'
      ? t('adsc.card.budget', {
          before: money(before.value, currency),
          after: money(after.value, currency),
        })
      : t('adsc.card.pause', { name: title.replace(/^[^：:]*[：:]/u, '') })
  const why = reasonWithoutGate(reason, str(after.spend_gate_note))
  const ahead = str(after.queued_ahead)
  const queue = str(after.queue_note)
  return (
    <div className="mt-2.5 flex flex-col gap-1.5" data-testid="ads-change-body">
      <p className="ws-num text-base font-medium text-ws-ink" data-testid="ads-change-main">
        {main}
      </p>
      {why === '' ? null : (
        <p className="text-sm leading-6 text-ws-body" data-testid="deck-reason">
          {why}
        </p>
      )}
      {ahead === undefined ? null : (
        <p className="text-xs text-ws-warn" data-testid="ads-change-ahead">
          {t('adsc.card.ahead', { what: ahead })}
        </p>
      )}
      {queue === undefined ? null : (
        <p className="text-xs text-ws-muted-fg" data-testid="ads-change-queue-note">
          {t('adsc.card.queue')}
        </p>
      )}
    </div>
  )
}
