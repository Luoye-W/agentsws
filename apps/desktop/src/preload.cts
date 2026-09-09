/**
 * 桥接层（13 §5「原生增强经一个很小的桥接层」）。整个文件就这么大——桥面越小，
 * "同一份 UI 在普通浏览器里完整可用"越站得住。
 *
 * `sandbox: true` 的 preload 必须是 CommonJS，所以这个文件是 `.cts`（编译成 `preload.cjs`）。
 * 这里不 require 除 electron 以外的任何东西，也不碰 fs / 密钥。
 */
import type { BridgeInfo, DesktopBridge, NotifyInput } from './bridge-types.js'

import electron = require('electron')

const { contextBridge, ipcRenderer } = electron

const CHANNELS = {
  info: 'agentsws:bridge-info',
  notify: 'agentsws:notify',
  openExternal: 'agentsws:open-external',
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
}

contextBridge.exposeInMainWorld('agentsws', Object.freeze(bridge))
