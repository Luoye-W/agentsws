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

/* ── WP504（决策 1777 A）：批量开发信确认卡（F3） ─────────────────────────── */

/** 批量开发信卡（`kol_outreach_batch`）的 payload。 */
export interface KolOutreachBatchPayload {
  form: 'kol_outreach_batch'
  count: number
  creators: { creator_id: string; display_name: string; initial: string }[]
  skipped: { creator_id: string; display_name: string; reason: string }[]
  sample?: { creator_name: string; subject: string; body: string }
  letter?: string
  cadence?: string
  mailbox?: 'connected' | 'none'
  heads_up?: string[]
}

export function isKolOutreachBatchPayload(payload: unknown): payload is KolOutreachBatchPayload {
  return rec(payload).form === 'kol_outreach_batch'
}

/** 「发出 N 封」那个 N（按钮上写）；认不出就 `undefined`。 */
export function kolBatchCount(payload: unknown): number | undefined {
  if (!isKolOutreachBatchPayload(payload)) return undefined
  return typeof payload.count === 'number' ? payload.count : undefined
}

/** 跳过的人按原因数一下：「没邮箱 2 · 30 天内联系过 1」。 */
export function skippedWhy(skipped: readonly { reason: string }[]): string {
  const counts = new Map<string, number>()
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1)
  return [...counts].map(([r, n]) => `${r} ${n}`).join(' · ')
}

/** 名单头像最多露几个（其余「+N」）。 */
const BATCH_FACES = 8

export function KolOutreachBatchBody({
  payload,
}: {
  payload: KolOutreachBatchPayload
}): React.ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(false)
  const creators = Array.isArray(payload.creators) ? payload.creators : []
  const skipped = Array.isArray(payload.skipped) ? payload.skipped : []
  const headsUp = (payload.heads_up ?? []).filter((x): x is string => typeof x === 'string')
  const faces = creators.slice(0, BATCH_FACES)
  const more = creators.length - faces.length
  const sample = payload.sample
  const rows: { id: string; label: string; value: string }[] = [
    {
      id: 'sender',
      label: t('kol.batch.sender'),
      value: t(payload.mailbox === 'none' ? 'kol.batch.sender.none' : 'kol.batch.sender.connected'),
    },
    ...(str(payload.letter) === undefined
      ? []
      : [{ id: 'letter', label: t('kol.batch.letter'), value: payload.letter as string }]),
    ...(str(payload.cadence) === undefined
      ? []
      : [{ id: 'cadence', label: t('kol.batch.cadence'), value: payload.cadence as string }]),
    {
      id: 'skipped',
      label: t('kol.batch.skipped'),
      value:
        skipped.length === 0
          ? t('kol.batch.skipped.none')
          : t('kol.batch.skipped.n', { n: skipped.length, why: skippedWhy(skipped) }),
    },
  ]
  return (
    <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-layout-kol-outreach-batch">
      <div className="flex items-center gap-1">
        <span className="flex items-center gap-1" data-testid="kol-batch-faces">
          {faces.map((c) => (
            <span
              key={c.creator_id}
              title={c.display_name}
              className="inline-flex size-6 items-center justify-center rounded-full bg-ws-surface text-xs font-medium text-ws-body"
            >
              {c.initial}
            </span>
          ))}
          {more > 0 ? (
            <span className="ws-num pl-1 text-xs text-ws-muted-fg" data-testid="kol-batch-more">
              +{more}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          className="ml-auto text-xs text-ws-muted-fg underline-offset-2 hover:underline"
          data-testid="kol-batch-list-toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen((v) => !v)
          }}
        >
          {t(open ? 'kol.batch.list.hide' : 'kol.batch.list')}
        </button>
      </div>
      {open ? (
        <ul className="flex flex-wrap gap-1.5 text-xs text-ws-body" data-testid="kol-batch-list">
          {creators.map((c) => (
            <li key={c.creator_id} className="rounded-sm bg-ws-surface px-1.5 py-0.5">
              {c.display_name}
            </li>
          ))}
        </ul>
      ) : null}
      <dl
        className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm"
        data-testid="kol-batch-facts"
      >
        {rows.map((r) => (
          <div key={r.id} className="contents" data-row={r.id}>
            <dt className="text-ws-muted-fg">{r.label}</dt>
            <dd className="min-w-0 text-ws-body">{r.value}</dd>
          </div>
        ))}
      </dl>
      {headsUp.length === 0 ? null : (
        <ul className="flex flex-col gap-0.5 text-xs text-ws-warn" data-testid="kol-batch-heads-up">
          {headsUp.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      {sample === undefined ? null : (
        <div
          className="rounded-lg bg-ws-surface p-3 text-sm leading-6"
          data-testid="kol-batch-sample"
        >
          <p className="text-xs text-ws-muted-fg">
            {t('kol.batch.sample', { name: sample.creator_name })}
          </p>
          <p className="line-clamp-2 text-ws-body">
            {[sample.subject, ...sample.body.split('\n').filter((l) => l.trim() !== '')]
              .slice(0, 2)
              .join(' — ')}
          </p>
        </div>
      )}
    </div>
  )
}
