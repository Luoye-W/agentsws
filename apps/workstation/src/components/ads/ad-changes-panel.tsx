/**
 * WP316（docs/101 §5.1② ③，决策 556）：投放职责页上的**广告改动**——广告变更账本的那一块。
 *
 * 一行一条批过的改动：状态、一句话；等你确认的那条带平台预览截图和「确认提交 / 不提交」
 * （与插件横条上那两个按钮是同一件事）；做完的带读回结果、前后截图、「撤销」（出一张 L1 卡）。
 * 界面少字：说明全进问号；截图点一下放大。
 */
import type { AdsLedgerEntryView, AdsLedgerState } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ScrollText } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { InfoTip, StatusPill } from '@/components/design'
import type { Tone } from '@/components/design/tone'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import {
  ADS_LEDGER_KEY,
  confirmAdChange,
  getAdsEvidence,
  listAdsLedger,
  undoAdChange,
} from '@/lib/ads-changes-api'
import { useApp } from '@/lib/app-context'

const MAX_ROWS = 8

const TONE: Record<AdsLedgerState, Tone> = {
  queued: 'neutral',
  running: 'info',
  waiting_confirm: 'warn',
  done: 'good',
  failed: 'bad',
  rejected: 'bad',
  handover: 'warn',
  stopped: 'neutral',
  expired: 'neutral',
}

const LIVE: readonly AdsLedgerState[] = ['queued', 'running', 'waiting_confirm']

/** 一张截图（点一下放大 / 收回）。 */
function Shot({
  assignment,
  id,
  label,
  big = false,
}: {
  assignment: string
  id: string
  label: string
  big?: boolean
}): ReactNode {
  const [open, setOpen] = useState(big)
  const shot = useQuery({
    queryKey: [...ADS_LEDGER_KEY, 'evidence', id],
    queryFn: () => getAdsEvidence(assignment, id),
    staleTime: Number.POSITIVE_INFINITY,
  })
  if (shot.data === undefined) return null
  return (
    <button
      type="button"
      data-testid="ads-change-shot"
      onClick={() => setOpen((v) => !v)}
      className="flex cursor-zoom-in flex-col items-start gap-0.5 rounded text-xs text-ws-muted-fg outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <img
        src={`data:image/png;base64,${shot.data.png_base64}`}
        alt={label}
        className={
          open
            ? 'max-h-80 w-full rounded border object-contain'
            : 'h-10 w-16 rounded border object-cover'
        }
      />
      {label}
    </button>
  )
}

function Row({ assignment, row }: { assignment: string; row: AdsLedgerEntryView }): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [note, setNote] = useState<string | undefined>()
  const refresh = () => client.invalidateQueries({ queryKey: ADS_LEDGER_KEY })
  const confirm = useMutation({
    mutationFn: (submit: boolean) => confirmAdChange(assignment, row.change_id, submit),
    onSuccess: (r) => {
      setNote(r.message)
      void refresh()
    },
  })
  const undo = useMutation({
    mutationFn: () => undoAdChange(assignment, row.change_id),
    onSuccess: (r) => {
      setNote(
        r.views[0]?.staged === true ? t('adsc.undo.staged') : (r.message ?? r.views[0]?.message),
      )
      void refresh()
    },
  })
  const waiting = row.state === 'waiting_confirm'
  const lastJob = row.jobs[row.jobs.length - 1]?.job_id
  const preview = [...row.evidence]
    .reverse()
    .find((e) => e.tag === 'preview' && e.job_id === lastJob)
  // 做完的：每种截图留最后一张（多张表时只看最后一张的前 / 后）
  const shots = waiting
    ? []
    : (['before', 'preview', 'after'] as const).flatMap((tag) => {
        const hit = [...row.evidence].reverse().find((e) => e.tag === tag)
        return hit === undefined ? [] : [hit]
      })
  return (
    <li className="flex flex-col gap-1.5 border-b py-2 last:border-0" data-testid="ads-change-row">
      <div className="flex items-center gap-2">
        <StatusPill tone={TONE[row.state]} data-testid="ads-change-state">
          {t(`adsc.state.${row.state}`)}
        </StatusPill>
        {row.stop_loss === true ? <StatusPill tone="warn">{t('adsc.stop_loss')}</StatusPill> : null}
        <span className="min-w-0 flex-1 truncate text-sm font-medium" data-testid="ads-change-line">
          {row.line ?? row.title}
        </span>
        {row.readback === undefined ? null : (
          <InfoTip text={row.readback.sentence} testId="ads-change-readback">
            <StatusPill tone={row.readback.ok ? 'good' : 'bad'}>
              {t(row.readback.ok ? 'adsc.readback.ok' : 'adsc.readback.bad')}
            </StatusPill>
          </InfoTip>
        )}
        {row.evidence_missing.length === 0 ? null : (
          <InfoTip text={t('adsc.missing.hint')} testId="ads-change-missing">
            <StatusPill tone="neutral">{t('adsc.missing')}</StatusPill>
          </InfoTip>
        )}
        {row.undo.available && row.state === 'done' ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="ads-change-undo"
            disabled={undo.isPending}
            onClick={() => undo.mutate()}
          >
            {t('adsc.undo')}
          </Button>
        ) : null}
        {row.undo.available && row.state === 'done' ? <Hint text={t('adsc.undo.hint')} /> : null}
      </div>
      {row.sentence === undefined ? null : (
        <p className="truncate text-xs text-ws-muted-fg">{row.sentence}</p>
      )}
      {row.platform_errors === undefined ? null : (
        <p className="text-xs text-ws-bad" data-testid="ads-change-errors">
          {row.platform_errors}
        </p>
      )}
      {waiting ? (
        <div className="flex flex-col gap-2" data-testid="ads-change-confirm">
          {preview === undefined ? null : (
            <Shot assignment={assignment} id={preview.id} label={t('adsc.tag.preview')} big />
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              data-testid="ads-change-submit"
              disabled={confirm.isPending}
              onClick={() => confirm.mutate(true)}
            >
              {t('adsc.confirm')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="ads-change-reject"
              disabled={confirm.isPending}
              onClick={() => confirm.mutate(false)}
            >
              {t('adsc.reject')}
            </Button>
            <Hint text={t('adsc.confirm.hint')} />
          </div>
        </div>
      ) : shots.length === 0 ? null : (
        <div className="flex flex-wrap gap-2">
          {shots.map((e) => (
            <Shot key={e.id} assignment={assignment} id={e.id} label={t(`adsc.tag.${e.tag}`)} />
          ))}
        </div>
      )}
      {note === undefined ? null : <p className="text-xs text-ws-muted-fg">{note}</p>}
    </li>
  )
}

export function AdChangesPanel({ assignment }: { assignment: string }): ReactNode {
  const { t } = useApp()
  const list = useQuery({
    queryKey: [...ADS_LEDGER_KEY, assignment],
    queryFn: () => listAdsLedger(assignment),
    // 有在跑 / 等确认的就十秒刷一次（插件那一侧会一步步回报）
    refetchInterval: (q) =>
      (q.state.data?.rows ?? []).some((r) => LIVE.includes(r.state)) ? 10_000 : false,
  })
  const rows = (list.data?.rows ?? [])
    .filter((r) => r.kind !== 'export_snapshot')
    .slice(0, MAX_ROWS)
  return (
    <Card data-testid="ad-changes-panel">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ScrollText className="size-4 text-muted-foreground" aria-hidden />
          {t('adsc.title')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-ws-muted-fg">{t('adsc.empty')}</p>
        ) : (
          <ul>
            {rows.map((r) => (
              <Row key={r.change_id} assignment={assignment} row={r} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
