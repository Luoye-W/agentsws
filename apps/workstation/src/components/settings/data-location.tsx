/**
 * WP480（Luoye 10-23）：设置 → 数据与隐私 →「数据放在哪」。
 *
 * 以前数据库与大文件的路径只是显示、改不了。现在：「更改位置…」→ 壳弹系统选文件夹框、查一遍
 * （可写、空间够、不是系统目录……）→ 确认框说清「要搬多少、大约多久、搬的时候工坊会暂停」→ 开搬，
 * 进度就在这一行里显示；搬完旧位置的数据留 7 天（能「现在就删」）。「恢复默认位置」走同一条路。
 *
 * 只在桌面壳（个人档）里出现：服务进程归这台电脑上的壳管才搬得了。路径一律从壳里来，
 * 页面只能说「刚才选好的那个」或「默认位置」（见 `@agentsws/desktop/bridge` 的 `DesktopDataLocationBridge`）。
 */
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, FolderOpen, Loader2 } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { SettingRow } from '@/components/settings-panel/setting-row'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ProgressBar } from '@/components/ui/tremor/progress-bar'
import { useApp } from '@/lib/app-context'
import { formatBytes, formatDate } from '@/lib/format'

// ── 桥的形状（同 `@agentsws/desktop/bridge`；工作台不依赖桌面壳的包，这里抄一份类型） ──

export interface DataTargetCheckLike {
  ok: boolean
  chosen: string
  target: string
  bytes: number
  files: number
  free_bytes?: number
  estimate_seconds: number
  problems: string[]
  warnings: string[]
}

export type DataMoveStatusLike =
  | { state: 'idle' }
  | {
      state: 'running'
      step: string
      to: string
      copied_bytes: number
      total_bytes: number
      files_done: number
      files_total: number
      started_at: string
    }
  | { state: 'done'; to: string; from: string; old?: { path: string; until: string }; at: string }
  | {
      state: 'failed'
      code: string
      step: string
      back_to: string
      recovered: boolean
      at: string
    }

export interface DataLocationLike {
  path: string
  is_default: boolean
  default_path: string
  bytes?: number
  files?: number
  old?: { path: string; until: string }
  status: DataMoveStatusLike
}

export interface DataLocationBridgeLike {
  get(): Promise<DataLocationLike>
  choose(): Promise<DataTargetCheckLike | null>
  checkDefault(): Promise<DataTargetCheckLike>
  move(to: 'chosen' | 'default'): Promise<DataMoveStatusLike>
  onChange(listener: (status: DataMoveStatusLike) => void): () => void
  deleteOld(): Promise<boolean>
  reveal(): Promise<boolean>
}

/** 旧壳、远程档、网页里没有（那就不出这一行）。 */
export function dataLocationBridge(): DataLocationBridgeLike | undefined {
  const w = globalThis.window as unknown as
    | { agentsws?: { dataLocation?: DataLocationBridgeLike } }
    | undefined
  return w?.agentsws?.dataLocation
}

type T = (key: string, vars?: Record<string, string | number>) => string

/** 「大约 3 分钟」。 */
export function durationText(seconds: number, t: T): string {
  if (seconds < 60) return t('dataloc.time.under_minute')
  if (seconds < 3600) return t('dataloc.time.minutes', { n: Math.ceil(seconds / 60) })
  return t('dataloc.time.hours', { n: Math.round((seconds / 3600) * 10) / 10 })
}

function count(n: number, lang: 'zh' | 'en'): string {
  return new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en-US').format(n)
}

/** 一条进度说成一句话。 */
export function stepText(s: Extract<DataMoveStatusLike, { state: 'running' }>, t: T): string {
  if (s.step === 'copy')
    return t('dataloc.step.copy', {
      done: formatBytes(s.copied_bytes),
      total: formatBytes(s.total_bytes),
    })
  if (s.step === 'verify')
    return t('dataloc.step.verify', { done: s.files_done, total: s.files_total })
  return t(`dataloc.step.${s.step}`)
}

/** 失败那一句：原因 + 现在怎么样了（回到原位置照常在用 / 原位置也没起来）。 */
export function failureText(s: Extract<DataMoveStatusLike, { state: 'failed' }>, t: T): string {
  const known = t(`dataloc.failed.${s.code}`)
  const reason = known === `dataloc.failed.${s.code}` ? t('dataloc.failed.unknown') : known
  return t(s.recovered ? 'dataloc.failed' : 'dataloc.failed.stuck', { reason })
}

/** 搬到哪里那一句里的路径：太长就只留头尾，免得一整行路径把框撑开。 */
function PathText({ path, testId }: { path: string; testId?: string }): ReactNode {
  return (
    <code
      className="block font-mono text-xs break-all text-ws-muted-fg"
      title={path}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      {path}
    </code>
  )
}

export function DataLocationSetting(): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const [bridge] = useState(dataLocationBridge)
  const [view, setView] = useState<DataLocationLike | undefined>(undefined)
  const [status, setStatus] = useState<DataMoveStatusLike>({ state: 'idle' })
  /** 确认框里的那一份检查（`reset` = 恢复默认位置）。 */
  const [pending, setPending] = useState<
    { check: DataTargetCheckLike; to: 'chosen' | 'default' } | undefined
  >(undefined)
  const [busy, setBusy] = useState(false)
  const [oldDeleted, setOldDeleted] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (bridge === undefined) return
    try {
      const next = await bridge.get()
      setView(next)
      setStatus((cur) => (cur.state === 'idle' ? next.status : cur))
    } catch {
      // 壳问不到就先不画（下次打开再问）
    }
  }, [bridge])

  useEffect(() => {
    if (bridge === undefined) return
    void refresh()
    const off = bridge.onChange((s) => {
      setStatus(s)
      if (s.state === 'done' || s.state === 'failed') {
        void refresh()
        // 「数据后端」那一格显示的路径、大小、上次备份都跟着变
        void client.invalidateQueries({ queryKey: ['storage'] })
      }
    })
    return off
  }, [bridge, refresh, client])

  if (bridge === undefined || view === undefined) return null

  const running = status.state === 'running'

  const choose = async (): Promise<void> => {
    setBusy(true)
    try {
      const check = await bridge.choose()
      if (check !== null) setPending({ check, to: 'chosen' })
    } finally {
      setBusy(false)
    }
  }
  const resetDefault = async (): Promise<void> => {
    setBusy(true)
    try {
      setPending({ check: await bridge.checkDefault(), to: 'default' })
    } finally {
      setBusy(false)
    }
  }
  const start = async (): Promise<void> => {
    if (pending === undefined) return
    const to = pending.to
    setPending(undefined)
    setOldDeleted(false)
    setStatus(await bridge.move(to))
  }

  const sizeLine =
    view.bytes === undefined
      ? undefined
      : t('dataloc.size', { size: formatBytes(view.bytes), n: count(view.files ?? 0, lang) })

  return (
    <SettingRow
      testId="settings-data-location"
      stacked
      title={t('dataloc.title')}
      desc={t('dataloc.desc')}
      hint={t('dataloc.hint')}
      control={
        <div className="flex flex-col gap-2">
          <div className="rounded-lg border bg-muted/20 p-3">
            <PathText path={view.path} testId="data-location-path" />
            <p className="mt-1 text-xs text-ws-muted-fg">
              {[view.is_default ? t('dataloc.default_tag') : undefined, sizeLine]
                .filter((x) => x !== undefined)
                .join(' · ')}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                data-testid="data-location-change"
                disabled={running || busy}
                onClick={() => void choose()}
              >
                {busy && pending === undefined ? (
                  <Loader2 aria-hidden className="animate-spin" />
                ) : null}
                {t('dataloc.change')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="data-location-reveal"
                disabled={running}
                onClick={() => void bridge.reveal()}
              >
                <FolderOpen aria-hidden />
                {t('dataloc.reveal')}
              </Button>
              {view.is_default ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="link"
                  className="px-0"
                  data-testid="data-location-reset"
                  disabled={running || busy}
                  onClick={() => void resetDefault()}
                >
                  {t('dataloc.reset')}
                </Button>
              )}
            </div>
          </div>

          {status.state === 'running' ? (
            <div
              className="rounded-lg border bg-muted/20 p-3 text-xs"
              data-testid="data-location-progress"
              data-step={status.step}
              role="status"
            >
              <p className="flex items-center gap-1.5 text-sm">
                <Loader2 aria-hidden className="size-3.5 animate-spin" />
                {stepText(status, t)}
              </p>
              <ProgressBar
                className="mt-2"
                value={
                  status.step === 'verify'
                    ? status.files_done
                    : status.total_bytes === 0
                      ? 0
                      : status.copied_bytes
                }
                max={status.step === 'verify' ? status.files_total : status.total_bytes}
                label={t('dataloc.title')}
              />
              <p className="mt-2 text-ws-muted-fg">{t('dataloc.running.note')}</p>
            </div>
          ) : null}

          {status.state === 'done' ? (
            <p
              className="flex items-start gap-1.5 text-xs text-ws-good"
              data-testid="data-location-done"
              role="status"
            >
              <CheckCircle2 aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span className="break-all">{t('dataloc.done', { path: status.to })}</span>
            </p>
          ) : null}

          {status.state === 'failed' ? (
            <p
              className="flex items-start gap-1.5 text-xs text-destructive"
              data-testid="data-location-failed"
              data-code={status.code}
              role="alert"
            >
              <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>{failureText(status, t)}</span>
            </p>
          ) : null}

          {view.old === undefined || running ? null : oldDeleted ? (
            <p className="text-xs text-ws-muted-fg">{t('dataloc.old.deleted')}</p>
          ) : (
            <p
              className="flex flex-wrap items-center gap-x-2 text-xs text-ws-muted-fg"
              data-testid="data-location-old"
            >
              <span title={view.old.path}>
                {t('dataloc.old', { date: formatDate(view.old.until, lang) })}
              </span>
              <Button
                type="button"
                size="xs"
                variant="link"
                className="h-auto px-0 text-xs"
                data-testid="data-location-delete-old"
                onClick={() => {
                  void bridge.deleteOld().then((ok) => {
                    if (ok) setOldDeleted(true)
                    void refresh()
                  })
                }}
              >
                {t('dataloc.old.delete')}
              </Button>
            </p>
          )}

          <MoveDialog
            pending={pending}
            onCancel={() => {
              setPending(undefined)
            }}
            onAgain={() => {
              setPending(undefined)
              void choose()
            }}
            onStart={() => void start()}
          />
        </div>
      }
    />
  )
}

/** 确认框：能搬就说清要搬多少、多久、会暂停；不能搬就说为什么。 */
function MoveDialog({
  pending,
  onCancel,
  onAgain,
  onStart,
}: {
  pending: { check: DataTargetCheckLike; to: 'chosen' | 'default' } | undefined
  onCancel: () => void
  onAgain: () => void
  onStart: () => void
}): ReactNode {
  const { t, lang } = useApp()
  const check = pending?.check
  return (
    <Dialog
      open={pending !== undefined}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="data-location-dialog">
        {check === undefined ? null : check.ok ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {pending?.to === 'default'
                  ? t('dataloc.confirm.reset_title')
                  : t('dataloc.confirm.title')}
              </DialogTitle>
              <DialogDescription asChild>
                <div>
                  <PathText path={check.target} testId="data-location-dialog-target" />
                </div>
              </DialogDescription>
            </DialogHeader>
            <ul className="flex flex-col gap-1.5 text-sm" data-testid="data-location-dialog-facts">
              <li>
                {t('dataloc.confirm.amount', {
                  size: formatBytes(check.bytes),
                  n: count(check.files, lang),
                  time: durationText(check.estimate_seconds, t),
                })}
                {check.free_bytes === undefined ? null : (
                  <span className="ml-1 text-xs text-ws-muted-fg">
                    {t('dataloc.confirm.free', { size: formatBytes(check.free_bytes) })}
                  </span>
                )}
              </li>
              <li>{t('dataloc.confirm.pause')}</li>
              <li className="text-ws-muted-fg">{t('dataloc.confirm.safety')}</li>
            </ul>
            {check.warnings.length === 0 ? null : (
              <ul
                className="flex flex-col gap-1.5 rounded-lg bg-ws-warn-bg p-3 text-xs text-ws-warn"
                data-testid="data-location-dialog-warnings"
              >
                {check.warnings.map((w) => (
                  <li key={w} className="flex items-start gap-1.5" data-warning={w}>
                    <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                    {t(`dataloc.warn.${w}`)}
                  </li>
                ))}
              </ul>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onCancel}>
                {t('dataloc.confirm.cancel')}
              </Button>
              <Button type="button" data-testid="data-location-start" onClick={onStart}>
                {t('dataloc.confirm.start')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('dataloc.problem.title')}</DialogTitle>
              <DialogDescription asChild>
                <div>
                  <PathText path={check.chosen} />
                </div>
              </DialogDescription>
            </DialogHeader>
            <ul
              className="flex flex-col gap-1.5 text-sm"
              data-testid="data-location-dialog-problems"
            >
              {check.problems.map((p) => (
                <li key={p} data-problem={p}>
                  {t(`dataloc.problem.${p}`, {
                    need: formatBytes(Math.ceil(check.bytes * 1.2)),
                    free: formatBytes(check.free_bytes),
                  })}
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onCancel}>
                {t('dataloc.confirm.cancel')}
              </Button>
              {pending?.to === 'default' ? null : (
                <Button type="button" data-testid="data-location-again" onClick={onAgain}>
                  {t('dataloc.problem.again')}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
