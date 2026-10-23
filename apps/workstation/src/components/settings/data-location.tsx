/**
 * WP480（Luoye 10-23）：设置 → 数据与隐私 →「数据放在哪」。
 * WP482（决策 1643 改 B）：拆成两格——**数据库**（小、要快，建议放本机）和**大文件**（附件、录音、图片……
 * 可以放 NAS / 外置硬盘），各自「更改位置…」「恢复默认位置」。同一时间只搬一格。大文件那一格连不上时
 * 只在这里与用到附件 / 录音的地方说一句，工坊照常用。
 *
 * 以前数据库与大文件的路径只是显示、改不了。现在：「更改位置…」→ 壳弹系统选文件夹框、查一遍
 * （可写、空间够、不是系统目录……）→ 确认框说清「要搬多少、大约多久、搬的时候工坊会暂停」→ 开搬，
 * 进度就在这一行里显示；搬完旧位置的数据留 7 天（能「现在就删」）。「恢复默认位置」走同一条路。
 *
 * 只在桌面壳（个人档）里出现：服务进程归这台电脑上的壳管才搬得了。路径一律从壳里来，
 * 页面只能说「刚才选好的那个」或「默认位置」（见 `@agentsws/desktop/bridge` 的 `DesktopDataLocationBridge`）。
 */
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, FolderOpen, Loader2, RotateCw } from 'lucide-react'
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
import { Hint } from '@/components/ui/hint'
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
  /** WP482：哪一格（没有 = 数据库）。 */
  kind?: DataLocationKindLike
  /** WP482：搬数据库时大文件还跟着它放，会一起搬过去。 */
  includes_blobs?: boolean
}

/** WP482：数据库那一格 / 大文件那一格。 */
export type DataLocationKindLike = 'database' | 'blobs'

export type DataMoveStatusLike =
  | { state: 'idle' }
  | {
      state: 'running'
      which?: DataLocationKindLike
      step: string
      to: string
      copied_bytes: number
      total_bytes: number
      files_done: number
      files_total: number
      started_at: string
    }
  | {
      state: 'done'
      which?: DataLocationKindLike
      to: string
      from: string
      old?: { path: string; until: string }
      at: string
    }
  | {
      state: 'failed'
      which?: DataLocationKindLike
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
  /** WP482：大文件那一格（旧壳没有：只出一格，WP480 原样）。 */
  blobs?: BlobLocationLike
}

/** WP482：大文件现在放在哪。 */
export interface BlobLocationLike {
  path: string
  is_default: boolean
  default_path: string
  bytes?: number
  files?: number
  old?: { path: string; until: string }
  /** 硬盘没插、NAS 断网时是 `false`。 */
  reachable: boolean
}

/** WP482：每个方法多一个可选的 `which`（不给 = 数据库）。 */
export interface DataLocationBridgeLike {
  get(): Promise<DataLocationLike>
  choose(which?: DataLocationKindLike): Promise<DataTargetCheckLike | null>
  checkDefault(which?: DataLocationKindLike): Promise<DataTargetCheckLike>
  move(to: 'chosen' | 'default', which?: DataLocationKindLike): Promise<DataMoveStatusLike>
  onChange(listener: (status: DataMoveStatusLike) => void): () => void
  deleteOld(which?: DataLocationKindLike): Promise<boolean>
  reveal(which?: DataLocationKindLike): Promise<boolean>
}

/** 旧壳、远程档、网页里没有（那就不出这一行）。 */
export function dataLocationBridge(): DataLocationBridgeLike | undefined {
  const w = globalThis.window as unknown as
    | { agentsws?: { dataLocation?: DataLocationBridgeLike } }
    | undefined
  return w?.agentsws?.dataLocation
}

type T = (key: string, vars?: Record<string, string | number>) => string

/**
 * WP482：同一个意思，大文件那一格有自己的说法就用（`dataloc.blobs.*`），没有就用数据库那一格的。
 */
export function wordFor(which: DataLocationKindLike, t: T): T {
  if (which !== 'blobs') return t
  return (key, vars) => {
    const own = key.replace(/^dataloc\./, 'dataloc.blobs.')
    const text = t(own, vars)
    return text === own ? t(key, vars) : text
  }
}

/** 这条进度 / 结果是不是这一格的（没有 `which` = 数据库）。 */
const isFor = (s: DataMoveStatusLike, which: DataLocationKindLike): boolean =>
  s.state !== 'idle' && (s.which ?? 'database') === which

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
  const { t } = useApp()
  const client = useQueryClient()
  const [bridge] = useState(dataLocationBridge)
  const [view, setView] = useState<DataLocationLike | undefined>(undefined)
  const [status, setStatus] = useState<DataMoveStatusLike>({ state: 'idle' })
  /** 确认框里的那一份检查（`default` = 恢复默认位置）。 */
  const [pending, setPending] = useState<
    | { check: DataTargetCheckLike; to: 'chosen' | 'default'; which: DataLocationKindLike }
    | undefined
  >(undefined)
  const [busy, setBusy] = useState<DataLocationKindLike | undefined>(undefined)
  const [oldDeleted, setOldDeleted] = useState<Partial<Record<DataLocationKindLike, boolean>>>({})
  const [retrying, setRetrying] = useState(false)

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
  /** 旧壳只认数据库那一格：数据库那一格调用时不带 `which`（与 WP480 一模一样）。 */
  const arg = (which: DataLocationKindLike): [] | ['blobs'] => (which === 'blobs' ? ['blobs'] : [])

  const choose = async (which: DataLocationKindLike): Promise<void> => {
    setBusy(which)
    try {
      const check = await bridge.choose(...arg(which))
      if (check !== null) setPending({ check, to: 'chosen', which })
    } finally {
      setBusy(undefined)
    }
  }
  const resetDefault = async (which: DataLocationKindLike): Promise<void> => {
    setBusy(which)
    try {
      setPending({ check: await bridge.checkDefault(...arg(which)), to: 'default', which })
    } finally {
      setBusy(undefined)
    }
  }
  const start = async (): Promise<void> => {
    if (pending === undefined) return
    const { to, which } = pending
    setPending(undefined)
    setOldDeleted((cur) => ({ ...cur, [which]: false }))
    setStatus(await bridge.move(to, ...arg(which)))
  }
  const retry = async (): Promise<void> => {
    setRetrying(true)
    try {
      await refresh()
      void client.invalidateQueries({ queryKey: ['storage'] })
    } finally {
      setRetrying(false)
    }
  }

  const split = view.blobs !== undefined
  const cellProps = {
    status,
    running,
    onChange: (which: DataLocationKindLike) => void choose(which),
    onReset: (which: DataLocationKindLike) => void resetDefault(which),
    onReveal: (which: DataLocationKindLike) => void bridge.reveal(...arg(which)),
    onDeleteOld: (which: DataLocationKindLike) => {
      void bridge.deleteOld(...arg(which)).then((ok) => {
        if (ok) setOldDeleted((cur) => ({ ...cur, [which]: true }))
        void refresh()
      })
    },
  }

  return (
    <SettingRow
      testId="settings-data-location"
      stacked
      title={t('dataloc.title')}
      desc={t(split ? 'dataloc.desc.split' : 'dataloc.desc')}
      hint={t(split ? 'dataloc.hint.split' : 'dataloc.hint')}
      control={
        <div className="flex flex-col gap-3">
          <LocationCell
            {...cellProps}
            which="database"
            label={split ? t('dataloc.db.label') : undefined}
            labelHint={split ? t('dataloc.db.hint') : undefined}
            path={view.path}
            isDefault={view.is_default}
            bytes={view.bytes}
            files={view.files}
            old={view.old}
            oldDeleted={oldDeleted.database === true}
            busy={busy === 'database' && pending === undefined}
            disabled={busy !== undefined}
          />
          {view.blobs === undefined ? null : (
            <LocationCell
              {...cellProps}
              which="blobs"
              label={t('dataloc.blobs.label')}
              labelHint={t('dataloc.blobs.hint')}
              path={view.blobs.path}
              isDefault={view.blobs.is_default}
              bytes={view.blobs.bytes}
              files={view.blobs.files}
              old={view.blobs.old}
              oldDeleted={oldDeleted.blobs === true}
              busy={busy === 'blobs' && pending === undefined}
              disabled={busy !== undefined}
              unreachable={
                view.blobs.reachable ? undefined : { retrying, onRetry: () => void retry() }
              }
            />
          )}

          <MoveDialog
            pending={pending}
            onCancel={() => {
              setPending(undefined)
            }}
            onAgain={() => {
              const which = pending?.which ?? 'database'
              setPending(undefined)
              void choose(which)
            }}
            onStart={() => void start()}
          />
        </div>
      }
    />
  )
}

/** 一格：路径、默认位置 / 大小、按钮；这一格在搬时的进度、结果；旧位置留到哪天。 */
function LocationCell({
  which,
  label,
  labelHint,
  path,
  isDefault,
  bytes,
  files,
  old,
  oldDeleted,
  status,
  running,
  busy,
  disabled,
  unreachable,
  onChange,
  onReset,
  onReveal,
  onDeleteOld,
}: {
  which: DataLocationKindLike
  label: string | undefined
  labelHint: string | undefined
  path: string
  isDefault: boolean
  bytes: number | undefined
  files: number | undefined
  old: { path: string; until: string } | undefined
  oldDeleted: boolean
  status: DataMoveStatusLike
  running: boolean
  busy: boolean
  disabled: boolean
  /** 大文件那一格连不上（硬盘没插、NAS 断网）。 */
  unreachable?: { retrying: boolean; onRetry: () => void } | undefined
  onChange: (which: DataLocationKindLike) => void
  onReset: (which: DataLocationKindLike) => void
  onReveal: (which: DataLocationKindLike) => void
  onDeleteOld: (which: DataLocationKindLike) => void
}): ReactNode {
  const { t: base, lang } = useApp()
  const t = wordFor(which, base)
  /** 数据库那一格沿用 WP480 的 testid；大文件那一格换前缀。 */
  const id = (name: string): string =>
    which === 'blobs' ? `blob-location-${name}` : `data-location-${name}`
  const mine = isFor(status, which)
  const sizeLine =
    bytes === undefined
      ? undefined
      : base('dataloc.size', { size: formatBytes(bytes), n: count(files ?? 0, lang) })

  return (
    <div className="flex flex-col gap-2" data-testid={id('cell')} data-which={which}>
      <div className="rounded-lg border bg-muted/20 p-3">
        {label === undefined ? null : (
          <p className="mb-1 flex items-center gap-1 text-sm font-medium text-ws-ink">
            {label}
            {labelHint === undefined ? null : <Hint text={labelHint} />}
          </p>
        )}
        <PathText path={path} testId={id('path')} />
        <p className="mt-1 text-xs text-ws-muted-fg">
          {[isDefault ? t('dataloc.default_tag') : undefined, sizeLine]
            .filter((x) => x !== undefined)
            .join(' · ')}
        </p>
        {unreachable === undefined ? null : (
          <p
            className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-ws-warn-bg px-2 py-1.5 text-xs text-ws-warn"
            data-testid="blob-location-unreachable"
            role="status"
          >
            <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
            <span>{base('dataloc.blobs.unreachable')}</span>
            <Button
              type="button"
              size="xs"
              variant="link"
              className="h-auto px-0 text-xs"
              data-testid="blob-location-retry"
              disabled={unreachable.retrying}
              onClick={unreachable.onRetry}
            >
              <RotateCw aria-hidden className={unreachable.retrying ? 'animate-spin' : undefined} />
              {base('blobloc.retry')}
            </Button>
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            data-testid={id('change')}
            disabled={running || disabled}
            onClick={() => {
              onChange(which)
            }}
          >
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {t('dataloc.change')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid={id('reveal')}
            disabled={running || unreachable !== undefined}
            onClick={() => {
              onReveal(which)
            }}
          >
            <FolderOpen aria-hidden />
            {t('dataloc.reveal')}
          </Button>
          {isDefault ? null : (
            <Button
              type="button"
              size="sm"
              variant="link"
              className="px-0"
              data-testid={id('reset')}
              disabled={running || disabled}
              onClick={() => {
                onReset(which)
              }}
            >
              {t('dataloc.reset')}
            </Button>
          )}
        </div>
      </div>

      {mine && status.state === 'running' ? (
        <div
          className="rounded-lg border bg-muted/20 p-3 text-xs"
          data-testid={id('progress')}
          data-step={status.step}
          role="status"
        >
          <p className="flex items-center gap-1.5 text-sm">
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
            {stepText(status, base)}
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
          />
          <p className="mt-2 text-ws-muted-fg">{base('dataloc.running.note')}</p>
        </div>
      ) : null}

      {mine && status.state === 'done' ? (
        <p
          className="flex items-start gap-1.5 text-xs text-ws-good"
          data-testid={id('done')}
          role="status"
        >
          <CheckCircle2 aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-all">{t('dataloc.done', { path: status.to })}</span>
        </p>
      ) : null}

      {mine && status.state === 'failed' ? (
        <p
          className="flex items-start gap-1.5 text-xs text-destructive"
          data-testid={id('failed')}
          data-code={status.code}
          role="alert"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{failureText(status, base)}</span>
        </p>
      ) : null}

      {old === undefined || running ? null : oldDeleted ? (
        <p className="text-xs text-ws-muted-fg">{t('dataloc.old.deleted')}</p>
      ) : (
        <p
          className="flex flex-wrap items-center gap-x-2 text-xs text-ws-muted-fg"
          data-testid={id('old')}
        >
          <span title={old.path}>{t('dataloc.old', { date: formatDate(old.until, lang) })}</span>
          <Button
            type="button"
            size="xs"
            variant="link"
            className="h-auto px-0 text-xs"
            data-testid={id('delete-old')}
            onClick={() => {
              onDeleteOld(which)
            }}
          >
            {t('dataloc.old.delete')}
          </Button>
        </p>
      )}
    </div>
  )
}

/** 确认框：能搬就说清要搬多少、多久、会暂停；不能搬就说为什么。 */
function MoveDialog({
  pending,
  onCancel,
  onAgain,
  onStart,
}: {
  pending:
    | { check: DataTargetCheckLike; to: 'chosen' | 'default'; which: DataLocationKindLike }
    | undefined
  onCancel: () => void
  onAgain: () => void
  onStart: () => void
}): ReactNode {
  const { t: base, lang } = useApp()
  const which = pending?.which ?? 'database'
  const t = wordFor(which, base)
  const check = pending?.check
  return (
    <Dialog
      open={pending !== undefined}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="data-location-dialog" data-which={which}>
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
                  time: durationText(check.estimate_seconds, base),
                })}
                {check.free_bytes === undefined ? null : (
                  <span className="ml-1 text-xs text-ws-muted-fg">
                    {t('dataloc.confirm.free', { size: formatBytes(check.free_bytes) })}
                  </span>
                )}
              </li>
              {check.includes_blobs === true ? (
                <li data-testid="data-location-dialog-includes-blobs">
                  {base('dataloc.confirm.includes_blobs')}
                </li>
              ) : null}
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
                {base('dataloc.confirm.cancel')}
              </Button>
              <Button type="button" data-testid="data-location-start" onClick={onStart}>
                {base('dataloc.confirm.start')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{base('dataloc.problem.title')}</DialogTitle>
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
                {base('dataloc.confirm.cancel')}
              </Button>
              {pending?.to === 'default' ? null : (
                <Button type="button" data-testid="data-location-again" onClick={onAgain}>
                  {base('dataloc.problem.again')}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
