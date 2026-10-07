/**
 * WP247：本机连接器（按需下载、跟着工作台开关）在界面上的三样东西——
 *
 * 1. {@link LocalConnectorLine}：连接页顶上那一行（没下载 / 下载中 / 启动中 / 出错 / 停着），
 *    一句话 + 一个按钮，细节进问号（界面少字）。「就绪」那一格仍是 RuntimeBar 原来的那一行；
 * 2. {@link DownloadConfirm}：点了要连接器的卡、而它还没下载时弹的那一问（「要先下载连接器，约 30 MB」）；
 * 3. {@link useLocalConnectorAction}：下载 / 取消 / 重启 / 回退 / 删除，回来的状态直接塞进缓存。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Download, Loader2, PackageOpen, PauseCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Hint } from '@/components/ui/hint'
import {
  type LocalConnectorAction,
  type LocalConnectorView,
  localConnectorAction,
  type RuntimeStatusView,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

type Translate = (key: string, vars?: Record<string, string>) => string

/** 「约 30 MB」：往上取到 5 的倍数（实测 27.8 MB）。 */
export function aboutMb(bytes: number): string {
  return String(Math.max(5, Math.ceil(bytes / 1_000_000 / 5) * 5))
}

/** 下载进度（锁文件里数得出总包数，所以能给百分比）。 */
export function downloadPercent(local: LocalConnectorView): number {
  const job = local.job
  if (job === undefined || job.total <= 0) return 0
  return Math.min(99, Math.floor((job.fetched / job.total) * 100))
}

/** 下载中 / 启动中：连接页每 1.5 秒问一次状态。 */
export function localBusy(status: RuntimeStatusView | undefined): boolean {
  const s = status?.local?.status
  return s === 'downloading' || s === 'starting'
}

/** 出错时那一句人话 + 问号里的原始码。 */
export function localErrorOf(
  status: RuntimeStatusView,
  t: Translate,
): { sentence: string; detail: string | undefined; retry: 'install' | 'restart' } {
  const local = status.local
  const job = local?.job
  if (local?.installed === undefined && job?.error !== undefined) {
    return {
      sentence: t(`connector.local.err.${job.error.code}`),
      detail:
        job.error.detail === undefined
          ? undefined
          : t('connector.local.detail.code', { code: job.error.detail }),
      retry: 'install',
    }
  }
  if (status.state === 'unhardened') {
    return {
      sentence: t('connector.local.err.unhardened'),
      detail: status.reasons.join('、'),
      retry: 'restart',
    }
  }
  return {
    sentence: t('connector.local.err.crashed'),
    detail: local?.supervisor?.last_error,
    retry: 'restart',
  }
}

export function useLocalConnectorAction(assignment: string | undefined) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (action: LocalConnectorAction) => localConnectorAction(action, assignment),
    onSuccess: (status) => {
      client.setQueryData(['connect-runtime', assignment], status)
      void client.invalidateQueries({ queryKey: ['connect-providers'] })
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['connect-runtime'] })
    },
  })
}

/** 顶上那一行（`local` 在、且还没就绪时）。 */
export function LocalConnectorLine({
  status,
  assignment,
}: {
  status: RuntimeStatusView
  assignment?: string
}): React.ReactNode {
  const { t } = useApp()
  const act = useLocalConnectorAction(assignment)
  const local = status.local
  if (local === undefined || local.status === 'ready') return null
  const mb = aboutMb(local.download_bytes)
  const busy = act.isPending

  let icon = <PackageOpen className="size-4 shrink-0" aria-hidden />
  let tone = 'text-muted-foreground'
  let text: string
  let hint: string | undefined
  let action: { label: string; run: LocalConnectorAction; testId: string } | undefined
  let progress: number | undefined

  if (local.status === 'not_installed') {
    text = t('connector.local.not_installed')
    hint = t('connector.local.not_installed.detail', { mb })
    action = { label: t('connector.local.download', { mb }), run: 'install', testId: 'download' }
  } else if (local.status === 'downloading') {
    const phase = local.job?.phase
    icon = <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
    progress = downloadPercent(local)
    text =
      phase === 'preparing'
        ? t('connector.local.preparing')
        : phase === 'verifying'
          ? t('connector.local.verifying')
          : t('connector.local.downloading', { pct: String(progress) })
    action = { label: t('connector.local.cancel'), run: 'cancel', testId: 'cancel' }
  } else if (local.status === 'starting') {
    icon = <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
    text = t('connector.local.starting')
  } else if (local.status === 'stopped') {
    icon = <PauseCircle className="size-4 shrink-0" aria-hidden />
    text = t('connector.local.stopped')
    action = { label: t('connector.local.start'), run: 'restart', testId: 'start' }
  } else {
    const err = localErrorOf(status, t)
    icon = <AlertTriangle className="size-4 shrink-0" aria-hidden />
    tone = 'text-destructive'
    text = `${t('connector.local.error')}：${err.sentence}`
    hint = err.detail
    action = { label: t('connector.local.retry'), run: err.retry, testId: 'retry' }
  }

  return (
    <div
      data-testid="local-connector"
      data-status={local.status}
      className="flex min-w-0 flex-col gap-1.5 text-sm"
    >
      <p className={cn('flex flex-wrap items-center gap-1.5 font-medium', tone)}>
        {icon}
        <span data-slot="status">{text}</span>
        {hint === undefined || hint === '' ? null : (
          <Hint text={hint} testId="local-connector-detail" />
        )}
        {action === undefined ? null : (
          <Button
            size="xs"
            variant={action.run === 'install' ? 'default' : 'outline'}
            className="ml-1"
            data-testid={`local-connector-${action.testId}`}
            disabled={busy}
            onClick={() => {
              act.mutate(action.run)
            }}
          >
            {action.run === 'install' ? <Download aria-hidden /> : null}
            {action.label}
          </Button>
        )}
      </p>
      {progress === undefined ? null : (
        <div
          className="h-1 w-full max-w-sm overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}
      {act.error === null ? null : (
        <p className="text-xs text-destructive" data-slot="status">
          {act.error.message}
        </p>
      )}
    </div>
  )
}

/** 点了要连接器的卡、它还没下载：先问一句。 */
export function DownloadConfirm({
  open,
  bytes,
  serviceLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean
  bytes: number
  serviceLabel: string
  onConfirm: () => void
  onCancel: () => void
}): React.ReactNode {
  const { t } = useApp()
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent data-testid="connector-download-confirm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('connector.local.confirm.title')}</DialogTitle>
          <DialogDescription>
            {t('connector.local.confirm.body', { mb: aboutMb(bytes), service: serviceLabel })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t('connector.local.confirm.cancel')}
          </Button>
          <Button data-testid="connector-download-ok" onClick={onConfirm}>
            <Download aria-hidden />
            {t('connector.local.confirm.ok')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
