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
  DesktopInstallOutcome,
  DesktopUpdateStatus,
  NotifyInput,
  SceneOpenOutcome,
} from './bridge-types.js'

import electron = require('electron')

const { contextBridge, ipcRenderer } = electron

const CHANNELS = {
  info: 'agentsws:bridge-info',
  notify: 'agentsws:notify',
  openExternal: 'agentsws:open-external',
  openScene: 'agentsws:open-scene',
  updateStatus: 'agentsws:update-status',
  updateChanged: 'agentsws:update-changed',
  updateDownload: 'agentsws:update-download',
  updateInstall: 'agentsws:update-install',
} as const

const info = ipcRenderer.sendSync(CHANNELS.info) as BridgeInfo

const bridge: DesktopBridge = {
  platform: info.platform,
  version: info.version,
  notify: (input: NotifyInput): Promise<boolean> =>
    ipcRenderer.invoke(CHANNELS.notify, {
      title: input.title,
      body: input.body,
    }) as Promise<boolean>,
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
  },
}

contextBridge.exposeInMainWorld('agentsws', Object.freeze(bridge))
