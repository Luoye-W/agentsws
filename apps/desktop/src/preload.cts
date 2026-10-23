/**
 * 桥接层（13 §5「原生增强经一个很小的桥接层」）。整个文件就这么大——桥面越小，
 * "同一份 UI 在普通浏览器里完整可用"越站得住。
 *
 * `sandbox: true` 的 preload 必须是 CommonJS，所以这个文件是 `.cts`（编译成 `preload.cjs`）。
 * 这里不 require 除 electron 以外的任何东西，也不碰 fs / 密钥。
 */
import type {
  BridgeInfo,
  DesktopBridge,
  DesktopCapture,
  DesktopInstallOutcome,
  DesktopRestartChoice,
  DesktopRestartReadiness,
  DesktopSearchHandover,
  DesktopUpdateStatus,
  NotifyInput,
  SceneOpenOutcome,
} from './bridge-types.js'

import electron = require('electron')

const { contextBridge, ipcRenderer } = electron

const CHANNELS = {
  info: 'agentsws:bridge-info',
  notify: 'agentsws:notify',
  notifyClicked: 'agentsws:notify-clicked',
  openExternal: 'agentsws:open-external',
  openScene: 'agentsws:open-scene',
  updateStatus: 'agentsws:update-status',
  updateChanged: 'agentsws:update-changed',
  updateDownload: 'agentsws:update-download',
  updateInstall: 'agentsws:update-install',
  updateReadiness: 'agentsws:update-readiness',
  updateRestart: 'agentsws:update-restart',
  updateCancelWait: 'agentsws:update-cancel-wait',
  updateOpenPage: 'agentsws:update-open-page',
  updateCheck: 'agentsws:update-check',
  searchPending: 'agentsws:search-pending',
  searchChanged: 'agentsws:search-changed',
  searchPlace: 'agentsws:search-place',
  searchDismiss: 'agentsws:search-dismiss',
  launchAtLoginGet: 'agentsws:launch-at-login-get',
  launchAtLoginSet: 'agentsws:launch-at-login-set',
  launchAtLoginChanged: 'agentsws:launch-at-login-changed',
  sessionRenew: 'agentsws:session-renew',
  titleBarTheme: 'agentsws:title-bar-theme',
  captureWindow: 'agentsws:capture-window',
} as const

const info = ipcRenderer.sendSync(CHANNELS.info) as BridgeInfo

const bridge: DesktopBridge = {
  platform: info.platform,
  version: info.version,
  notify: (input: NotifyInput): Promise<boolean> =>
    ipcRenderer.invoke(CHANNELS.notify, {
      title: input.title,
      body: input.body,
      path: input.path,
    }) as Promise<boolean>,
  // WP429：点了系统通知 → 页面跳到那一页（只转一个地址字符串）
  onNotificationClick: (listener: (path: string) => void): (() => void) => {
    const handler = (_event: unknown, path: unknown): void => {
      if (typeof path === 'string') listener(path)
    }
    ipcRenderer.on(CHANNELS.notifyClicked, handler)
    return () => {
      ipcRenderer.removeListener(CHANNELS.notifyClicked, handler)
    }
  },
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke(CHANNELS.openExternal, url) as Promise<boolean>,
  // WP184：场景名与「要不要重启」两样，网址由主进程自己去拿
  openScene: (name: string, options?: { restart?: boolean }): Promise<SceneOpenOutcome> =>
    ipcRenderer.invoke(CHANNELS.openScene, name, {
      restart: options?.restart === true,
    }) as Promise<SceneOpenOutcome>,
  // WP218：一键更新。状态在主进程，这里只转话；监听函数不把 IPC 事件对象交给页面
  update: {
    status: (): Promise<DesktopUpdateStatus> =>
      ipcRenderer.invoke(CHANNELS.updateStatus) as Promise<DesktopUpdateStatus>,
    onChange: (listener: (status: DesktopUpdateStatus) => void): (() => void) => {
      const handler = (_event: unknown, status: DesktopUpdateStatus): void => {
        listener(status)
      }
      ipcRenderer.on(CHANNELS.updateChanged, handler)
      return () => {
        ipcRenderer.removeListener(CHANNELS.updateChanged, handler)
      }
    },
    download: (): Promise<DesktopUpdateStatus> =>
      ipcRenderer.invoke(CHANNELS.updateDownload) as Promise<DesktopUpdateStatus>,
    install: (): Promise<DesktopInstallOutcome> =>
      ipcRenderer.invoke(CHANNELS.updateInstall) as Promise<DesktopInstallOutcome>,
    // WP337：有任务在做时页面上三选一
    readiness: (): Promise<DesktopRestartReadiness> =>
      ipcRenderer.invoke(CHANNELS.updateReadiness) as Promise<DesktopRestartReadiness>,
    restart: (choice: DesktopRestartChoice): Promise<DesktopInstallOutcome> =>
      ipcRenderer.invoke(
        CHANNELS.updateRestart,
        choice === 'idle' ? 'idle' : 'now',
      ) as Promise<DesktopInstallOutcome>,
    cancelWait: (): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.updateCancelWait) as Promise<boolean>,
    // WP409：下载断了时「去下载页」（地址由壳定）
    openDownloadPage: (): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.updateOpenPage) as Promise<boolean>,
    // WP426：设置里「检查更新」
    check: (): Promise<DesktopUpdateStatus> =>
      ipcRenderer.invoke(CHANNELS.updateCheck) as Promise<DesktopUpdateStatus>,
  },
  // WP353：搜索要人介入的那一页（只转话；位置是几个数字，页面内容不经过这里）
  searchBrowser: {
    pending: (): Promise<DesktopSearchHandover | null> =>
      ipcRenderer.invoke(CHANNELS.searchPending) as Promise<DesktopSearchHandover | null>,
    onChange: (listener: (h: DesktopSearchHandover | null) => void): (() => void) => {
      const handler = (_event: unknown, h: DesktopSearchHandover | null): void => {
        listener(h)
      }
      ipcRenderer.on(CHANNELS.searchChanged, handler)
      return () => {
        ipcRenderer.removeListener(CHANNELS.searchChanged, handler)
      }
    },
    place: (
      rect: { x: number; y: number; width: number; height: number } | null,
    ): Promise<boolean> =>
      ipcRenderer.invoke(
        CHANNELS.searchPlace,
        rect === null ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      ) as Promise<boolean>,
    dismiss: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.searchDismiss) as Promise<boolean>,
  },
  // WP361：开机自启（设置弹窗里的开关；托盘那一项改了这边跟着变）
  launchAtLogin: {
    get: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.launchAtLoginGet) as Promise<boolean>,
    set: (on: boolean): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.launchAtLoginSet, on === true) as Promise<boolean>,
    onChange: (listener: (on: boolean) => void): (() => void) => {
      const handler = (_event: unknown, on: unknown): void => {
        listener(on === true)
      }
      ipcRenderer.on(CHANNELS.launchAtLoginChanged, handler)
      return () => {
        ipcRenderer.removeListener(CHANNELS.launchAtLoginChanged, handler)
      }
    },
  },
  // WP358：会话丢了让壳重换（只回是否；cookie 不经过这里）
  session: {
    renew: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.sessionRenew) as Promise<boolean>,
  },
  // WP475：反馈框「附上截图」（只截工坊自己的窗口；回 base64，不经文件）
  captureWindow: (): Promise<DesktopCapture | null> =>
    ipcRenderer.invoke(CHANNELS.captureWindow) as Promise<DesktopCapture | null>,
  // WP424：藏了系统标题栏才有这一项（页面据此给红绿灯 / 系统按钮留位置、设拖动区）
  ...(info.title_bar === undefined
    ? {}
    : {
        titleBar: {
          style: info.title_bar,
          setTheme: (theme: 'light' | 'dark'): Promise<boolean> =>
            ipcRenderer.invoke(
              CHANNELS.titleBarTheme,
              theme === 'dark' ? 'dark' : 'light',
            ) as Promise<boolean>,
        },
      }),
}

contextBridge.exposeInMainWorld('agentsws', Object.freeze(bridge))
