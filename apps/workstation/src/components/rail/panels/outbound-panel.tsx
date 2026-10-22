/**
 * WP323（docs/102 §5，决策 665 / 666 / 667）：右栏「发出记录」——工坊替你发出去的每一条（这个品牌）。
 *
 * - 上面一小块是**记录去处**（只在有的时候出）：显示用户自己交代的名字 + 状态点 + 已写 / 待补写；
 *   出问题才有一句原因和「补写」；停 / 开 / 删放在一行小按钮里。**新建与改不在这里**——在岗位里说一句，
 *   AI 出「定规矩」卡，卡在卡片流里决定（决定只在卡片流，docs/96 P1）。没有任何一家表格的专属设置区。
 * - 下面是记录：时间 · 渠道 · 动作 · 发到哪，我们发的那一句（一行），对方回了几条；可按渠道筛、可导出 CSV。
 * - 徽标：有待补写的才出数（出问题才出声，docs/96 P3）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, ExternalLink, Pause, Play, RotateCw, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { StatusPill } from '@/components/design'
import { InfoTip } from '@/components/design/status-icons'
import { PanelError } from '@/components/rail/panel-error'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useApp } from '@/lib/app-context'
import { formatDateTime } from '@/lib/format'
import {
  exportOutbound,
  listOutbound,
  listSinks,
  OUTBOUND_KEY,
  type OutboundRecord,
  type RecordSinkView,
  removeSink,
  SINKS_KEY,
  saveText,
  sinkAction,
} from '@/lib/outbound-api'

/** 认得的动作（词条 `outbound.action.*`）；别的原样显示。 */
const ACTIONS = new Set(['reply', 'comment', 'post', 'email', 'message', 'broadcast'])

const STATE_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = {
  active: 'good',
  pending_confirm: 'warn',
  paused: 'neutral',
  broken: 'bad',
}

export function OutboundPanel(_props: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  const [channel, setChannel] = useState('')
  const records = useQuery({
    queryKey: [...OUTBOUND_KEY, channel],
    queryFn: () => listOutbound(channel === '' ? {} : { channel }),
  })
  const all = useQuery({ queryKey: [...OUTBOUND_KEY, ''], queryFn: () => listOutbound() })
  const sinks = useQuery({ queryKey: SINKS_KEY, queryFn: listSinks })
  const exporter = useMutation({
    mutationFn: () => exportOutbound('csv', channel === '' ? {} : { channel }),
    onSuccess: (f) => saveText(f.filename, f.content, 'text/csv;charset=utf-8'),
  })
  if (records.isPending || sinks.isPending) return <Skeleton className="h-40 w-full" />
  if (records.isError) return <PanelError error={records.error} />
  const channels = [...new Set((all.data ?? []).map((r) => r.channel))].sort()
  const rows = records.data ?? []
  return (
    <div className="space-y-4" data-testid="rail-outbound">
      <SinkList sinks={sinks.data ?? []} />
      <div className="flex items-center gap-2">
        {channels.length < 2 ? null : (
          <select
            className="h-7 rounded-md border bg-transparent px-1.5 text-xs"
            value={channel}
            aria-label={t('outbound.all')}
            data-testid="outbound-channel"
            onChange={(e) => setChannel(e.target.value)}
          >
            <option value="">{t('outbound.all')}</option>
            {channels.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        {rows.length === 0 ? null : (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={exporter.isPending}
            data-testid="outbound-export"
            onClick={() => exporter.mutate()}
          >
            <Download className="size-4" aria-hidden />
            {t('outbound.export')}
          </Button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="outbound-empty">
          {t('outbound.empty')}
        </p>
      ) : (
        <ol className="flex flex-col gap-3" data-testid="outbound-records">
          {rows.map((r) => (
            <RecordRow key={r.id} record={r} />
          ))}
        </ol>
      )}
    </div>
  )
}

function RecordRow({ record: r }: { record: OutboundRecord }): ReactNode {
  const { t, lang } = useApp()
  const replies = r.follow_ups.filter((f) => f.from === 'them').length
  return (
    <li className="border-l pl-3" data-testid="outbound-row" data-status={r.status}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
        <time dateTime={r.sent_at}>{formatDateTime(r.sent_at, lang)}</time>
        <span>
          {r.channel} · {ACTIONS.has(r.action) ? t(`outbound.action.${r.action}`) : r.action}
        </span>
        {r.destination === undefined ? null : <span className="truncate">{r.destination}</span>}
        {r.status === 'sent' ? null : (
          <StatusPill tone={r.status === 'failed' ? 'bad' : 'neutral'}>
            {t(`outbound.status.${r.status}`)}
          </StatusPill>
        )}
      </div>
      <p className="line-clamp-2 text-sm" title={r.content}>
        {r.subject === undefined ? '' : `${r.subject} — `}
        {r.content}
      </p>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {replies === 0 ? null : <span>{t('outbound.followups', { count: replies })}</span>}
        {r.counterpart_deleted === true ? <span>{t('outbound.deleted')}</span> : null}
        {r.approved_via === 'extension' ? (
          <span data-testid="outbound-via-extension">{t('outbound.via_extension')}</span>
        ) : null}
        {r.link === undefined ? null : (
          <a
            href={r.link}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center rounded-sm text-ws-muted-fg hover:text-ws-ink focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={r.link}
            title={r.link}
          >
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        )}
      </div>
    </li>
  )
}

/** 记录去处（有才出）：名字 + 状态 + 已写 / 待补写；出问题一句原因 + 补写。 */
function SinkList({ sinks }: { sinks: RecordSinkView[] }): ReactNode {
  const { t } = useApp()
  if (sinks.length === 0) return null
  return (
    <section className="space-y-2" data-testid="outbound-sinks">
      <h4 className="text-xs text-muted-foreground">
        <InfoTip text={t('outbound.sinks.hint')}>{t('outbound.sinks')}</InfoTip>
      </h4>
      {sinks.map((s) => (
        <SinkRow key={s.id} sink={s} />
      ))}
    </section>
  )
}

function SinkRow({ sink: s }: { sink: RecordSinkView }): ReactNode {
  const { t } = useApp()
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: SINKS_KEY })
  }
  const act = useMutation({
    mutationFn: (verb: 'pause' | 'resume' | 'retry') => sinkAction(s.id, verb),
    onSettled: refresh,
  })
  const del = useMutation({ mutationFn: () => removeSink(s.id), onSettled: refresh })
  return (
    <div
      className="rounded-md border border-[var(--ws-line,var(--border))] p-2"
      data-testid="outbound-sink"
      data-state={s.state}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">{s.name}</span>
        <StatusPill tone={STATE_TONE[s.state] ?? 'neutral'}>
          {t(`outbound.sink.state.${s.state}`)}
        </StatusPill>
      </div>
      <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
        <span>{t('outbound.sink.counts', { written: s.written })}</span>
        {s.pending === 0 ? null : (
          <span>· {t('outbound.sink.pending', { pending: s.pending })}</span>
        )}
        <span className="ml-auto flex items-center">
          {s.state === 'broken' ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={act.isPending}
              data-testid="outbound-sink-retry"
              onClick={() => act.mutate('retry')}
            >
              <RotateCw className="size-3.5" aria-hidden />
              {t('outbound.sink.retry')}
            </Button>
          ) : null}
          {s.state === 'active' || s.state === 'paused' ? (
            <Button
              size="xs"
              variant="ghost"
              aria-label={t(s.state === 'paused' ? 'outbound.sink.resume' : 'outbound.sink.pause')}
              title={t(s.state === 'paused' ? 'outbound.sink.resume' : 'outbound.sink.pause')}
              disabled={act.isPending}
              onClick={() => act.mutate(s.state === 'paused' ? 'resume' : 'pause')}
            >
              {s.state === 'paused' ? (
                <Play className="size-3.5" aria-hidden />
              ) : (
                <Pause className="size-3.5" aria-hidden />
              )}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            aria-label={t('outbound.sink.remove')}
            title={t('outbound.sink.remove')}
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </span>
      </div>
      {s.last_error === undefined || s.state !== 'broken' ? null : (
        <p
          className="mt-1 text-xs text-[var(--ws-bad,var(--destructive))]"
          data-testid="outbound-sink-error"
        >
          {s.last_error.message}
        </p>
      )}
      {!confirming ? null : (
        <div className="mt-2 flex items-center gap-1 border-t pt-2 text-xs">
          <span className="flex-1">{t('outbound.sink.remove.confirm', { name: s.name })}</span>
          <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
            {t('action.cancel')}
          </Button>
          <Button
            size="xs"
            variant="destructive"
            disabled={del.isPending}
            data-testid="outbound-sink-remove"
            onClick={() => del.mutate()}
          >
            {t('outbound.sink.remove')}
          </Button>
        </div>
      )}
    </div>
  )
}
