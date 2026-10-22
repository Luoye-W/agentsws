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
  | {
      state: 'downloading'
      version: string
      /** 0 = 还没收到进度事件（增量下载不发进度）：只说「正在下载…」，不写 0%。 */
      percent: number
      source: 'primary' | 'github'
      /** WP351：下完了、在摆新版（解压 / 冒烟）→「正在准备新版…」。 */
      phase?: 'prepare'
    }
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
  /** WP409：下载断了时「去下载页」（地址由壳定）。旧壳没有：先判空，没有就不出那个小按钮。 */
  openDownloadPage?(): Promise<boolean>
}

/** WP351：更新状态补拉的间隔。 */
export const UPDATE_POLL_MS = 10_000

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
    /*
     * WP351：每 10 秒补拉一次。事件漏了（窗口刚开、渲染进程重载那一瞬）按钮会一直停在旧状态——
     * Windows 真机上「正在下载 0%」停住，其实壳里早就 ready 了。
     */
    const poll = setInterval(() => {
      void bridge.status().then(
        (s) => {
          if (live) setStatus(s)
        },
        () => undefined,
      )
    }, UPDATE_POLL_MS)
    return () => {
      live = false
      clearInterval(poll)
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
  // WP409：下载那一步失败了，除了「重试」再给一条出路：去下载页手动装
  const pageButton =
    status.state === 'error' &&
    status.stage === 'download' &&
    bridge.openDownloadPage !== undefined ? (
      <button
        type="button"
        data-testid="update-download-page"
        title={t('update.download_page.tip')}
        onClick={() => {
          void bridge.openDownloadPage?.()
        }}
        className="shrink-0 rounded-md px-2 py-1.5 text-xs text-ws-muted-fg hover:bg-sidebar-accent/60 hover:text-ws-fg"
      >
        {t('update.download_page')}
      </button>
    ) : null
  return (
    <div className="flex w-full items-center gap-1">
      <button
        type="button"
        data-testid="update-button"
        data-state={status.state}
        title={view.tip}
        aria-label={view.tip}
        disabled={view.disabled || busy}
        onClick={act}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
          view.tone === 'bad'
            ? 'text-ws-bad hover:bg-ws-bad-bg'
            : 'font-medium text-ws-brand hover:bg-sidebar-accent/60',
          'disabled:cursor-default disabled:opacity-80',
        )}
      >
        <view.Icon aria-hidden className={cn('size-4 shrink-0', view.spin && 'animate-spin')} />
        <span className="flex-1 truncate">{view.label}</span>
        {status.state === 'downloading' && status.phase === undefined && status.percent > 0 ? (
          <span className="ws-num text-ws-tiny text-ws-muted-fg" data-testid="update-percent">
            {status.percent}%
          </span>
        ) : null}
      </button>
      {pageButton}
      <UpdateRestartDialog
        readiness={asking}
        busy={busy}
        onChoose={choose}
        onClose={() => {
          setAsking(undefined)
        }}
      />
    </div>
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
      // WP351：下完了在摆新版 →「正在准备新版…」；没进度事件时只说「正在下载…」（百分比另画，0 不画）
      return {
        ...base,
        Icon: Loader2,
        spin: true,
        disabled: true,
        label: t(s.phase === 'prepare' ? 'update.preparing' : 'update.downloading'),
        tip: t(s.phase === 'prepare' ? 'update.preparing.tip' : 'update.downloading.tip', {
          version: s.version,
        }),
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
        label: t(
          s.stage === 'install'
            ? 'update.failed.install'
            : s.code === 'network'
              ? 'update.failed.download.network'
              : 'update.failed.download',
        ),
        tip: t(`update.error.${s.code}`),
      }
  }
}
