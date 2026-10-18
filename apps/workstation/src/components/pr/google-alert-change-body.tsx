/**
 * WP387（docs/103 v2 T1）：「在你的 Google 账号里建 N 条提醒」卡（「改东西」家族）的卡面。
 *
 * - 列出全部 N 条（查询语句 · 语言 · 地区），每条可勾掉；**一次确认**（不逐条）；
 * - 主按钮在卡身里（要带上勾选）：「确认，去建 K 条」——勾掉过就带着改过的那一版批（`approve` + `edited_payload`，
 *   服务端只认勾选这一处改动）；卡底那排不再出一个点不对的「批准」；
 * - 四项设置（即时 / 自动 / 所有结果 / RSS）进问号（界面少字）。个人模式下这叫「确认」，不叫审批。
 */
import { GOOGLE_ALERT_CHANGE_FORM, type GoogleAlertLine } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { InfoTip } from '@/components/design'
import { Button } from '@/components/ui/button'
import { decide } from '@/lib/api'
import { useApp } from '@/lib/app-context'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export interface GoogleAlertChangePayload {
  kind: 'google_alert_change'
  after: {
    form: typeof GOOGLE_ALERT_CHANGE_FORM
    op: 'create' | 'to_rss'
    lines: GoogleAlertLine[]
  }
  [k: string]: unknown
}

/** 这张卡是不是「建 / 改 Google 提醒」卡（账本卡：形状在 `payload.after` 里）。 */
export function isGoogleAlertChangePayload(p: unknown): p is GoogleAlertChangePayload {
  return (
    isRecord(p) &&
    p.kind === 'google_alert_change' &&
    isRecord(p.after) &&
    p.after.form === GOOGLE_ALERT_CHANGE_FORM &&
    Array.isArray(p.after.lines)
  )
}

export function GoogleAlertChangeBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: GoogleAlertChangePayload
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const lines = payload.after.lines
  const [keep, setKeep] = useState<string[]>(lines.map((l) => l.id))
  const decidable = card.available_actions.includes('approve')
  const changed = keep.length !== lines.length
  const send = useMutation({
    mutationFn: () =>
      decide(
        card.id,
        {
          action: 'approve',
          version: card.version,
          via: 'workstation',
          ...(changed
            ? {
                edited_payload: {
                  ...payload,
                  after: {
                    ...payload.after,
                    lines: lines.map((l) => ({ ...l, selected: keep.includes(l.id) })),
                  },
                },
              }
            : {}),
        } as never,
        card.position_id,
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['approval'] })
      void client.invalidateQueries({ queryKey: ['deck'] })
      void client.invalidateQueries({ queryKey: ['matter'] })
    },
  })
  const any = t('galert.any')
  return (
    <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-google-alerts">
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {lines.map((l) => (
          <li key={l.id}>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                data-testid={`google-alert-line-${l.id}`}
                checked={keep.includes(l.id)}
                disabled={!decidable || send.isPending || send.isSuccess}
                onChange={(e) =>
                  setKeep(e.target.checked ? [...keep, l.id] : keep.filter((id) => id !== l.id))
                }
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-ws-ink">{l.query}</span>
                <span className="text-xs text-ws-muted-fg">
                  {t('galert.where', {
                    language: l.language === 'any' ? any : l.language,
                    region: l.region === 'any' ? any : l.region,
                  })}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <InfoTip text={t('galert.settings.hint')}>
        <span className="w-fit text-xs text-ws-muted-fg" data-testid="google-alerts-settings">
          {t('galert.settings')}
        </span>
      </InfoTip>
      {decidable ? (
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            data-testid="google-alerts-confirm"
            disabled={keep.length === 0 || send.isPending || send.isSuccess}
            onClick={() => send.mutate()}
          >
            {t(payload.after.op === 'to_rss' ? 'galert.confirm.rss' : 'galert.confirm', {
              n: keep.length,
            })}
          </Button>
          {send.isError ? (
            <span className="text-xs text-ws-bad">
              {t('galert.failed', {
                message: send.error instanceof Error ? send.error.message : String(send.error),
              })}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
