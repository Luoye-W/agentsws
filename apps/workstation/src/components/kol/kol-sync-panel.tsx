/**
 * WP509（决策 1730 B、1811）：**红人同步到表格**在第三栏的样子——「连接」那一格里几行、红人库 ⋯ 里叠开的一层，同一个件。
 *
 * 一个同步一行：表名 + 状态（在同步 · 几点同步过 / 停着 / 写不进去，红点）；点开就地看：
 * 加了几行改了几处、写不进去的那一句、现在同步 / 停 / 开 / 删掉 / 改设置（把「重新设一下飞书同步 <链接>」填进对话框）/
 * 打开表格、最近几次留痕。一个都没有时一句话 +「去设同步」（把「把红人同步到我的飞书表」填进对话框）。
 * 设置本身在对话里改（决策 690「配置在对话流里完成」），这里不做设置表单。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ExternalLink, Sheet } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { openExternal } from '@/components/connections/bridge'
import {
  controlKolSync,
  getKolSyncLog,
  getKolSyncs,
  type KolSyncData,
  removeKolSync,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { prefillComposer } from '@/lib/composer-prefill'
import { cn } from '@/lib/utils'

export const kolSyncKey = (assignment: string): readonly unknown[] => ['kol-sync', assignment]

const pad = (n: number): string => String(n).padStart(2, '0')
/** 「10-24 10:32」（今天的只写时间）。 */
export function syncWhen(iso: string | undefined, now = new Date()): string {
  if (iso === undefined) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === now.toDateString()
    ? hm
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

const BTN =
  'rounded-md bg-ws-surface px-2 py-0.5 text-[12px] font-medium text-ws-body hover:bg-ws-hover disabled:opacity-50'

export function KolSyncRows({
  assignment,
  open: openAll = false,
}: {
  assignment: string
  /** 红人库 ⋯ 叠开的那一层：一行就直接展开。 */
  open?: boolean
}): ReactNode {
  const { t } = useApp()
  const list = useQuery({
    queryKey: kolSyncKey(assignment),
    queryFn: () => getKolSyncs(assignment),
    retry: false,
    refetchInterval: 30_000,
  })
  const syncs = (list.data?.syncs ?? []).filter((s) => s.state !== 'pending_confirm')
  if (list.isPending) return null
  if (list.isError) return null
  if (syncs.length === 0)
    return (
      <div className="flex items-center gap-2 px-1.5 py-1 text-[13px]" data-testid="kol-sync-empty">
        <Sheet aria-hidden className="size-4 shrink-0 text-ws-muted-fg" />
        <span className="min-w-0 flex-1 text-ws-muted-fg">{t('kolsync.rail.empty')}</span>
        <button
          type="button"
          className={BTN}
          data-testid="kol-sync-setup"
          onClick={() => prefillComposer(t('kolsync.prefill'))}
        >
          {t('kolsync.rail.setup')}
        </button>
      </div>
    )
  return (
    <ul className="flex flex-col gap-px" data-testid="kol-sync-rows">
      {syncs.map((s) => (
        <KolSyncRow
          key={s.id}
          sync={s}
          assignment={assignment}
          ego={list.data?.ego !== false}
          defaultOpen={openAll && syncs.length === 1}
        />
      ))}
    </ul>
  )
}

function KolSyncRow({
  sync,
  assignment,
  ego,
  defaultOpen,
}: {
  sync: KolSyncData
  assignment: string
  ego: boolean
  defaultOpen: boolean
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [open, setOpen] = useState(defaultOpen)
  const bad = sync.state === 'broken'
  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: kolSyncKey(assignment) })
    void client.invalidateQueries({ queryKey: ['kol-sync-log', sync.id] })
  }
  const control = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'run') => controlKolSync(sync.id, action, assignment),
    onSettled: refresh,
  })
  const remove = useMutation({
    mutationFn: () => removeKolSync(sync.id, assignment),
    onSettled: refresh,
  })
  const log = useQuery({
    queryKey: ['kol-sync-log', sync.id],
    queryFn: () => getKolSyncLog(sync.id, assignment),
    enabled: open,
    retry: false,
  })
  const meta =
    sync.state === 'active'
      ? sync.last_ok_at === undefined
        ? t('kolsync.never')
        : t('kolsync.last', { when: syncWhen(sync.last_ok_at) })
      : t(`kolsync.state.${sync.state}`)
  const busy = control.isPending || remove.isPending
  return (
    <li
      className="flex flex-col gap-1"
      data-testid="kol-sync-row"
      data-state={sync.state}
      data-todo={bad ? 'true' : undefined}
    >
      <button
        type="button"
        className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-ws-surface"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Sheet aria-hidden className="size-4 shrink-0 text-ws-good" />
        <span className="min-w-0 truncate">{sync.name}</span>
        {bad ? <i aria-hidden className="size-1.5 shrink-0 rounded-full bg-ws-bad" /> : null}
        <span
          className={cn('ml-auto shrink-0 text-[12px]', bad ? 'text-ws-bad' : 'text-ws-muted-fg')}
        >
          {meta}
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-ws-muted-fg transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open ? (
        <div
          className="flex flex-col gap-2 px-1.5 pb-1.5 pl-7 text-[12px]"
          data-testid="kol-sync-detail"
        >
          {sync.problem === undefined ? null : (
            <p className={bad ? 'text-ws-bad' : 'text-ws-muted-fg'} data-testid="kol-sync-problem">
              {sync.problem}
            </p>
          )}
          {ego ? null : <p className="text-ws-bad">{t('kolsync.rail.no_ego')}</p>}
          <p className="text-ws-muted-fg">
            {t('kolsync.totals', { a: sync.totals.appended, u: sync.totals.updated })}
            {' · '}
            {sync.columns
              .filter((c) => c.field_name !== undefined)
              .map((c) => c.column)
              .join('、')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {sync.state === 'paused' ? null : (
              <button
                type="button"
                className={BTN}
                disabled={busy}
                data-testid="kol-sync-run"
                onClick={() => control.mutate('run')}
              >
                {t('kolsync.run')}
              </button>
            )}
            <button
              type="button"
              className={BTN}
              disabled={busy}
              data-testid={sync.state === 'paused' ? 'kol-sync-resume' : 'kol-sync-pause'}
              onClick={() => control.mutate(sync.state === 'paused' ? 'resume' : 'pause')}
            >
              {t(sync.state === 'paused' ? 'kolsync.resume' : 'kolsync.pause')}
            </button>
            <button
              type="button"
              className={BTN}
              data-testid="kol-sync-edit"
              onClick={() => prefillComposer(t('kolsync.edit.prompt', { url: sync.url }))}
            >
              {t('kolsync.edit')}
            </button>
            <button
              type="button"
              className={cn(BTN, 'inline-flex items-center gap-1')}
              onClick={() => openExternal(sync.url)}
            >
              <ExternalLink aria-hidden className="size-3" />
              {t('kolsync.card.open')}
            </button>
            <button
              type="button"
              className={cn(BTN, 'text-ws-bad')}
              disabled={busy}
              data-testid="kol-sync-remove"
              onClick={() => {
                if (window.confirm(t('kolsync.remove.confirm'))) remove.mutate()
              }}
            >
              {t('kolsync.remove')}
            </button>
          </div>
          <section aria-label={t('kolsync.log')} data-testid="kol-sync-log">
            {(log.data?.rows ?? []).length === 0 ? (
              log.isPending ? null : (
                <p className="text-ws-muted-fg">{t('kolsync.log.empty')}</p>
              )
            ) : (
              <ul className="flex flex-col gap-0.5">
                {(log.data?.rows ?? []).slice(0, 5).map((r) => (
                  <li
                    key={r.id}
                    className="flex min-w-0 gap-2"
                    title={r.items.map((i) => `${i.name}：${i.result}`).join('\n')}
                  >
                    <span className="ws-num shrink-0 text-ws-muted-fg">{syncWhen(r.at)}</span>
                    <span
                      className={cn(
                        'min-w-0 truncate',
                        r.state !== 'ok' && r.state !== 'nothing' && 'text-ws-bad',
                      )}
                    >
                      {r.message}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </li>
  )
}
