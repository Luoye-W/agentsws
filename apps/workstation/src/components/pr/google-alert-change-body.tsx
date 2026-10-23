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
import { FootButtons, useCardFootActions } from '@/components/deck/card-foot'
import { InfoTip } from '@/components/design'
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
  // WP478：主按钮并进卡底那一排（没有卡底时照旧画在卡身里）
  const actions = decidable
    ? [
        {
          key: 'google-alerts-confirm',
          label: t(payload.after.op === 'to_rss' ? 'galert.confirm.rss' : 'galert.confirm', {
            n: keep.length,
          }),
          primary: true,
          disabled: keep.length === 0 || send.isPending || send.isSuccess,
          testId: 'google-alerts-confirm',
          onSelect: () => {
            send.mutate()
          },
        },
      ]
    : null
  const hosted = useCardFootActions(actions)
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
                {/* WP419（自查 U11）：主文字说人话，原始查询语句放悬停 */}
                <span
                  className="truncate text-ws-ink"
                  title={l.query}
                  data-testid="google-alert-readable"
                >
                  {readableAlertQuery(l.query)}
                </span>
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
          {hosted ? null : <FootButtons actions={actions ?? []} />}
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

const HIRING = new Set(['job', 'jobs', 'hiring', 'career', 'careers', 'recruit', 'recruiting'])

/**
 * WP419（自查 U11）：Google 提醒的查询语句 → 人话：`"Aventon" -job -jobs` → `Aventon（排除招聘）`；
 * 别的排除词照写（`排除 used`）；`OR` 写成「或」。认不出就原样。
 */
export function readableAlertQuery(query: string): string {
  const exclude: string[] = []
  const words: string[] = []
  for (const m of query.matchAll(/(-?)"([^"]+)"|(-?)(\S+)/gu)) {
    const neg = (m[1] ?? m[3] ?? '') === '-'
    const word = (m[2] ?? m[4] ?? '').trim()
    if (word === '') continue
    if (neg) exclude.push(word)
    else words.push(word === 'OR' ? '或' : word)
  }
  if (words.length === 0) return query
  const hiring = exclude.filter((x) => HIRING.has(x.toLowerCase()))
  const other = exclude.filter((x) => !HIRING.has(x.toLowerCase()))
  const notes = [...(hiring.length > 0 ? ['招聘'] : []), ...other]
  return `${words.join(' ')}${notes.length === 0 ? '' : `（排除${notes.join('、')}）`}`
}
