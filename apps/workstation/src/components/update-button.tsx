/**
 * WP218：左下角（账号区上方）的「有新版本」按钮——像 Claude / Codex 那样点一下就更新。
 *
 * 状态全在桌面壳主进程里（`apps/desktop/src/update-controller.ts`），这里只看、只点：
 * 有新版本 → 点了后台下载（显示进度）→ 「重启并更新」→ 点了壳问一句（有任务在跑时）、自检、退出装、自动重开。
 * 下载 / 安装失败一句人话 + 点了重试。mac 未签名那一档按钮说「去下载」，点了开下载页。
 *
 * 36 §10 少字：一行一个状态图标 + 几个字；长说明进 tooltip（`title`）。
 * 普通浏览器里（没有桌面壳）、旧壳（桥上没有 `update`）、没有新版本时整行不出现。
 */
import { AlertCircle, ArrowDownCircle, Hourglass, Loader2, RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type RestartReadinessView, UpdateRestartDialog } from '@/components/update-restart-dialog'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 形状同 `@agentsws/desktop/bridge` 的 `DesktopUpdateStatus`（工作台不依赖桌面壳这个包）。 */
export type UpdateStatusView =
  | { state: 'idle' }
  | {
      state: 'available'
      version: string
      mode: 'auto' | 'notify'
      source: 'primary' | 'github'
      url?: string
    }
  | { state: 'downloading'; version: string; percent: number; source: 'primary' | 'github' }
  | { state: 'ready'; version: string; source: 'primary' | 'github' }
  /** WP337：等没有正在输出的就自己重启（点一下取消）。 */
  | { state: 'waiting'; version: string; source: 'primary' | 'github' }
  | { state: 'installing'; version: string }
  | {
      state: 'error'
      stage: 'download' | 'install'
      code: 'network' | 'not_found' | 'checksum' | 'disk' | 'smoke' | 'install' | 'unknown'
      version: string
    }

interface UpdateBridge {
  status(): Promise<UpdateStatusView>
  onChange(listener: (status: UpdateStatusView) => void): () => void
  download(): Promise<UpdateStatusView>
  install(): Promise<'installing' | 'cancelled' | 'blocked' | 'not-ready' | 'waiting'>
  /** WP337：旧壳没有这三样——先判空，退回 `install()`（壳自己弹原生框）。 */
  readiness?(): Promise<RestartReadinessView>
  restart?(choice: 'now' | 'idle'): Promise<string>
  cancelWait?(): Promise<boolean>
}

function updateBridge(): UpdateBridge | undefined {
  const w = globalThis.window as unknown as { agentsws?: { update?: UpdateBridge } } | undefined
  return w?.agentsws?.update
}

export function UpdateButton(): React.ReactNode {
  const { t } = useApp()
  const [status, setStatus] = useState<UpdateStatusView>({ state: 'idle' })
  const [busy, setBusy] = useState(false)
  /** WP337：有任务在做时的三选一（开着 = 有值）。 */
  const [asking, setAsking] = useState<RestartReadinessView | undefined>(undefined)

  useEffect(() => {
    const bridge = updateBridge()
    if (bridge === undefined) return
    let live = true
    void bridge.status().then(
      (s) => {
        if (live) setStatus(s)
      },
      () => undefined,
    )
    const off = bridge.onChange((s) => {
      setStatus(s)
    })
    return () => {
      live = false
      off()
    }
  }, [])

  const bridge = updateBridge()
  if (bridge === undefined || status.state === 'idle') return null

  const act = (): void => {
    if (busy) return
    if (status.state === 'waiting') {
      void bridge.cancelWait?.()
      return
    }
    const wantsInstall =
      status.state === 'ready' || (status.state === 'error' && status.stage === 'install')
    const wantsDownload =
      status.state === 'available' || (status.state === 'error' && status.stage === 'download')
    if (!wantsInstall && !wantsDownload) return
    setBusy(true)
    const done = (): void => {
      setBusy(false)
    }
    if (wantsInstall) {
      const { readiness, restart } = bridge
      if (readiness === undefined || restart === undefined) {
        void bridge.install().then(done, done)
        return
      }
      // WP337：先看一眼在做什么——没有就直接重启，有就三选一
      void readiness().then(
        (r) => {
          if (r.total === 0) void restart.call(bridge, 'now').then(done, done)
          else {
            setAsking(r)
            done()
          }
        },
        () => {
          void bridge.install().then(done, done)
        },
      )
    } else
      void bridge.download().then((s) => {
        setStatus(s)
        done()
      }, done)
  }

  const view = describe(status, t)
  const choose = (choice: 'now' | 'idle'): void => {
    setAsking(undefined)
    setBusy(true)
    const done = (): void => {
      setBusy(false)
    }
    void bridge.restart?.(choice).then(done, done)
  }
  return (
    <>
      <button
        type="button"
        data-testid="update-button"
        data-state={status.state}
        title={view.tip}
        aria-label={view.tip}
        disabled={view.disabled || busy}
        onClick={act}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
          view.tone === 'bad'
            ? 'text-ws-bad hover:bg-ws-bad-bg'
            : 'font-medium text-ws-brand hover:bg-sidebar-accent/60',
          'disabled:cursor-default disabled:opacity-80',
        )}
      >
        <view.Icon aria-hidden className={cn('size-4 shrink-0', view.spin && 'animate-spin')} />
        <span className="flex-1 truncate">{view.label}</span>
        {status.state === 'downloading' ? (
          <span className="ws-num text-[11px] text-ws-muted-fg" data-testid="update-percent">
            {status.percent}%
          </span>
        ) : null}
      </button>
      <UpdateRestartDialog
        readiness={asking}
        busy={busy}
        onChoose={choose}
        onClose={() => {
          setAsking(undefined)
        }}
      />
    </>
  )
}

interface View {
  Icon: typeof ArrowDownCircle
  label: string
  tip: string
  tone: 'brand' | 'bad'
  disabled: boolean
  spin: boolean
}

function describe(
  s: Exclude<UpdateStatusView, { state: 'idle' }>,
  t: (key: string, vars?: Record<string, string | number>) => string,
): View {
  const base = { tone: 'brand' as const, disabled: false, spin: false }
  switch (s.state) {
    case 'available':
      return {
        ...base,
        Icon: ArrowDownCircle,
        label: t('update.available'),
        tip: t(s.mode === 'notify' ? 'update.available.notify' : 'update.available.tip', {
          version: s.version,
        }),
      }
    case 'downloading':
      return {
        ...base,
        Icon: Loader2,
        spin: true,
        disabled: true,
        label: t('update.downloading'),
        tip: t('update.downloading.tip', { version: s.version }),
      }
    case 'ready':
      return {
        ...base,
        Icon: RotateCw,
        label: t('update.ready'),
        tip: t('update.ready.tip', { version: s.version }),
      }
    case 'waiting':
      return {
        ...base,
        Icon: Hourglass,
        label: t('update.waiting'),
        tip: t('update.waiting.tip'),
      }
    case 'installing':
      return {
        ...base,
        Icon: Loader2,
        spin: true,
        disabled: true,
        label: t('update.installing'),
        tip: t('update.installing'),
      }
    case 'error':
      return {
        ...base,
        tone: 'bad',
        Icon: AlertCircle,
        label: t(s.stage === 'download' ? 'update.failed.download' : 'update.failed.install'),
        tip: t(`update.error.${s.code}`),
      }
  }
}
