/**
 * WP506（决策 1788 B）：批量开发信**分时发**的两小块——卡上 / 红人库里共用。
 *
 * - `BatchPace`：「每小时最多 [10] 封」一格，改了就存到这一批上（卡没批时改的是批了之后的节奏，
 *   在发的时候改下一封就按新的来）；
 * - `BatchProgress`：已发几封 / 一共几封、为什么还没发下一封（间隔 / 这一小时满了 / 今天额度满了 / 没连邮箱）、
 *   暂停 / 继续、取消剩下的（已发的不撤）。
 *
 * 少字：为什么要分时发写进问号，卡面只露数和一句。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'
import { Hint } from '@/components/ui/hint'
import {
  controlKolOutreachBatch,
  getKolOutreachBatches,
  type KolOutreachBatchProgress,
  OUTREACH_PER_HOUR,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 这一批还在路上（在发 / 暂停）——要定时刷新进度。 */
export const batchLive = (p: Pick<KolOutreachBatchProgress, 'state'> | undefined): boolean =>
  p?.state === 'sending' || p?.state === 'paused'

/** 一张批量卡的进度（没有这一批 = `undefined`）。在发的时候 20 秒刷一次。 */
export function useBatchProgress(
  approval_item_id: string | undefined,
  assignment: string | undefined,
): KolOutreachBatchProgress | undefined {
  const q = useQuery({
    queryKey: ['kol-outreach-batch', approval_item_id ?? '', assignment ?? ''],
    queryFn: async () =>
      (
        await getKolOutreachBatches({ approval_item_id: approval_item_id as string }, assignment)
      )[0] ?? null,
    enabled: approval_item_id !== undefined,
    retry: false,
    refetchInterval: (query) => (batchLive(query.state.data ?? undefined) ? 20_000 : false),
  })
  return q.data ?? undefined
}

/** 「14:06」；不是今天的写「10-25 09:00」。 */
export function clockOf(iso: string | undefined, now: Date = new Date()): string {
  if (iso === undefined) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay
    ? hm
    : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`
}

function useControl(approval_item_id: string, assignment: string | undefined) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { action?: 'pause' | 'resume' | 'cancel'; per_hour?: number }) =>
      controlKolOutreachBatch(approval_item_id, input, assignment),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['kol-outreach-batch'] })
      void client.invalidateQueries({ queryKey: ['kol-outreach-batches'] })
      void client.invalidateQueries({ queryKey: ['kol-creators'] })
    },
  })
}

/** 「每小时最多 [10] 封」：失焦或回车才存（改成同一个数不发请求）。 */
export function BatchPace({
  approval_item_id,
  assignment,
  perHour,
  editable,
}: {
  approval_item_id: string | undefined
  assignment: string | undefined
  perHour: number
  editable: boolean
}): ReactNode {
  const { t } = useApp()
  const [draft, setDraft] = useState(String(perHour))
  useEffect(() => {
    setDraft(String(perHour))
  }, [perHour])
  const control = useControl(approval_item_id ?? '', assignment)
  const save = (): void => {
    const n = Math.round(Number(draft))
    if (!Number.isFinite(n) || n < OUTREACH_PER_HOUR.min || n > OUTREACH_PER_HOUR.max) {
      setDraft(String(perHour))
      return
    }
    if (n === perHour || approval_item_id === undefined) return
    control.mutate({ per_hour: n })
  }
  return (
    <span className="inline-flex items-center gap-1" data-testid="kol-batch-pace">
      {t('kol.batch.pace.pre')}
      {editable && approval_item_id !== undefined ? (
        <input
          type="number"
          inputMode="numeric"
          min={OUTREACH_PER_HOUR.min}
          max={OUTREACH_PER_HOUR.max}
          value={draft}
          aria-label={t('kol.batch.pace.label')}
          data-testid="kol-batch-pace-input"
          disabled={control.isPending}
          className="ws-num h-6 w-12 rounded-md border border-ws-line bg-ws-card px-1.5 text-center text-xs text-ws-ink"
          onChange={(e) => {
            setDraft(e.target.value)
          }}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              save()
            }
          }}
        />
      ) : (
        <span className="ws-num font-medium text-ws-ink" data-testid="kol-batch-pace-value">
          {perHour}
        </span>
      )}
      {t('kol.batch.pace.post')}
      {control.isError ? (
        <span className="text-xs text-ws-bad" data-testid="kol-batch-pace-failed">
          {control.error instanceof Error ? control.error.message : String(control.error)}
        </span>
      ) : null}
    </span>
  )
}

/** 为什么还没发下一封（在发的时候才有这一句）。 */
function waitLine(p: KolOutreachBatchProgress, t: ReturnType<typeof useApp>['t']): string {
  const at = clockOf(p.next_at)
  switch (p.waiting) {
    case 'gap':
      return t('kol.batch.wait.gap', { at })
    case 'hour':
      return t('kol.batch.wait.hour', { at })
    case 'quota':
      return at === '' ? t('kol.batch.wait.quota.later') : t('kol.batch.wait.quota', { at })
    case 'mailbox':
      return t('kol.batch.wait.mailbox')
    default:
      return t('kol.batch.wait.now')
  }
}

/** 已发 / 一共、为什么还没发下一封、暂停 / 继续、取消剩下的、节奏。 */
export function BatchProgress({
  progress,
  assignment,
}: {
  progress: KolOutreachBatchProgress
  assignment: string | undefined
}): ReactNode {
  const { t } = useApp()
  const control = useControl(progress.approval_item_id, assignment)
  const live = batchLive(progress)
  const pct = progress.total === 0 ? 0 : Math.round((progress.sent / progress.total) * 100)
  const skippedWhy = progress.rows
    .filter((r) => r.state === 'skipped')
    .map((r) => `${r.display_name}：${r.reason ?? ''}`)
    .join('\n')
  const btn =
    'inline-flex h-6 items-center rounded-md px-2 text-xs font-medium text-ws-body hover:bg-ws-hover hover:text-ws-ink disabled:opacity-50'
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid="kol-batch-progress"
      data-state={progress.state}
      data-waiting={progress.waiting ?? ''}
    >
      <div className="flex items-center gap-2 text-xs">
        <span
          aria-hidden
          className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-ws-surface"
        >
          <span className="block h-full rounded-full bg-ws-brand" style={{ width: `${pct}%` }} />
        </span>
        <span className="ws-num font-medium text-ws-ink" data-testid="kol-batch-progress-sent">
          {t('kol.batch.progress.sent', { sent: progress.sent, total: progress.total })}
        </span>
        {progress.skipped === 0 ? null : (
          <span className="text-ws-muted-fg" title={skippedWhy}>
            {t('kol.batch.progress.skipped', { n: progress.skipped })}
          </span>
        )}
        {progress.state === 'sending' ? null : (
          <span className="text-ws-muted-fg" data-testid="kol-batch-progress-state">
            {t(`kol.batch.progress.state.${progress.state}`)}
          </span>
        )}
      </div>
      {progress.state === 'sending' ? (
        <p
          className={cn(
            'text-xs',
            progress.waiting === 'mailbox' ? 'text-ws-warn' : 'text-ws-muted-fg',
          )}
          data-testid="kol-batch-progress-wait"
        >
          {waitLine(progress, t)}
        </p>
      ) : null}
      {live ? (
        <div className="flex flex-wrap items-center gap-1 text-xs text-ws-muted-fg">
          <BatchPace
            approval_item_id={progress.approval_item_id}
            assignment={assignment}
            perHour={progress.per_hour}
            editable
          />
          <span className="flex-1" />
          <button
            type="button"
            className={btn}
            disabled={control.isPending}
            data-testid={progress.state === 'paused' ? 'kol-batch-resume' : 'kol-batch-pause'}
            onClick={() => {
              control.mutate({ action: progress.state === 'paused' ? 'resume' : 'pause' })
            }}
          >
            {t(progress.state === 'paused' ? 'kol.batch.resume' : 'kol.batch.pause')}
          </button>
          <button
            type="button"
            className={cn(btn, 'text-ws-bad hover:bg-ws-bad-bg hover:text-ws-bad')}
            disabled={control.isPending || progress.queued === 0}
            title={t('kol.batch.cancel.hint')}
            data-testid="kol-batch-cancel"
            onClick={() => {
              control.mutate({ action: 'cancel' })
            }}
          >
            {t('kol.batch.cancel')}
          </button>
          <Hint text={t('kol.batch.pace.hint')} />
        </div>
      ) : null}
      {control.isError ? (
        <p className="text-xs text-ws-bad" data-testid="kol-batch-control-failed">
          {control.error instanceof Error ? control.error.message : String(control.error)}
        </p>
      ) : null}
    </div>
  )
}

/**
 * 红人库「红人」格顶上：这条渠道正在发 / 暂停着的批量开发信（没有就什么都不画）。
 * 卡在中栏被处理掉之后，进度在这里还看得见、还能暂停 / 取消剩下的。
 */
export function LiveBatches({
  channel,
  assignment,
}: {
  channel: KolOutreachBatchProgress['channel']
  assignment: string | undefined
}): ReactNode {
  const { t } = useApp()
  const q = useQuery({
    queryKey: ['kol-outreach-batches', channel, assignment ?? ''],
    queryFn: () => getKolOutreachBatches({ channel }, assignment),
    retry: false,
    refetchInterval: (query) => ((query.state.data ?? []).some(batchLive) ? 20_000 : false),
  })
  const live = (q.data ?? []).filter(batchLive)
  if (live.length === 0) return null
  return (
    <ul className="flex flex-col gap-2" data-testid="kol-live-batches">
      {live.map((p) => (
        <li
          key={p.approval_item_id}
          className="rounded-lg bg-ws-surface px-3 py-2"
          data-testid={`kol-live-batch-${p.batch_id}`}
        >
          <p className="pb-1 text-xs font-medium text-ws-ink">{t('kol.batch.strip')}</p>
          <BatchProgress progress={p} assignment={assignment} />
        </li>
      ))}
    </ul>
  )
}
