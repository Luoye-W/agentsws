/**
 * WP416（自查 kol U5 / U6）：红人两张卡的卡面。
 *
 * - 开发信卡：卡面直接放标题 + 正文前 6 行（可展开）；要人先看一眼的几句（没连邮箱、英文信混了中文、
 *   介绍取自品牌档案…）一行一句放在正文上面——以前卡面只有标题、下面空一大块，提醒藏在 notes 里看不见。
 * - 验收结论卡：一句话「把这件交付物判为『通过』」，不出露字段名的改之前 / 改之后双格。
 */
import { useState } from 'react'
import { useApp } from '@/lib/app-context'

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined

export function isKolOutreachPayload(payload: unknown): boolean {
  return rec(payload).kind === 'kol_outreach'
}

export function isKolReviewPayload(payload: unknown): boolean {
  return rec(payload).kind === 'kol_deliverable_review'
}

export function KolOutreachBody({ payload }: { payload: unknown }): React.ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const after = rec(rec(payload).after)
  const subject = str(after.subject)
  const body = str(after.body) ?? ''
  const headsUp = Array.isArray(after.heads_up)
    ? after.heads_up.filter((x): x is string => typeof x === 'string')
    : []
  const lines = body.split('\n')
  const long = lines.length > 6
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="deck-layout-kol-outreach">
      {headsUp.length === 0 ? null : (
        <ul
          className="flex flex-col gap-0.5 text-xs text-ws-warn"
          data-testid="kol-outreach-heads-up"
        >
          {headsUp.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      <div className="rounded-lg bg-ws-surface p-3 text-sm leading-6 text-ws-body">
        {subject === undefined ? null : (
          <p className="font-medium" data-testid="kol-outreach-subject">
            {subject}
          </p>
        )}
        <p className="whitespace-pre-wrap" data-testid="kol-outreach-body">
          {open || !long ? body : lines.slice(0, 6).join('\n')}
        </p>
        {long ? (
          <button
            type="button"
            className="mt-1 text-xs text-ws-muted-fg underline-offset-2 hover:underline"
            data-testid="kol-outreach-expand"
            onClick={() => {
              setOpen((v) => !v)
            }}
          >
            {open ? t('kol.card.collapse') : t('kol.card.expand')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function KolReviewBody({ payload }: { payload: unknown }): React.ReactNode {
  const { t } = useApp()
  const after = rec(rec(payload).after)
  const label = str(after.review_label) ?? str(after.review) ?? ''
  const notes = str(after.notes)
  return (
    <div className="mt-2.5 flex flex-col gap-1.5" data-testid="deck-layout-kol-review">
      <p className="text-sm text-ws-body">{t('kol.card.review', { label })}</p>
      {notes === undefined ? null : <p className="text-xs text-ws-muted-fg">{notes}</p>}
    </div>
  )
}
