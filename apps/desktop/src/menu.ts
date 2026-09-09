/**
 * 托盘菜单的**数据模型**（13 §5：打开工作台 / 在浏览器打开 / 暂停 / 状态 / 退出）。
 *
 * `main.ts` 只负责把它翻译成 `Menu.buildFromTemplate`——判定全在这里，所以能测。
 */
import type { Language } from './config.js'
import type { ConnectRuntimeStatus } from './connect-runtime.js'
import type { HealthSnapshot } from './health.js'
import { strings } from './i18n.js'
import type { SidecarSnapshot } from './sidecar.js'

export type MenuAction =
  | 'open-workstation'
  | 'open-browser'
  | 'toggle-pause'
  | 'open-logs'
  | 'toggle-launch-at-login'
  | 'restart-server'
  | 'rotate-secrets-key'
  | 'quit'

export interface MenuItemModel {
  id: MenuAction | 'status' | 'separator'
  type: 'normal' | 'separator' | 'checkbox'
  label: string
  enabled: boolean
  checked?: boolean
}

export interface TrayModelInput {
  language: Language
  serverUrl: string
  version: string
  server: SidecarSnapshot
  health: HealthSnapshot | undefined
  paused: boolean
  connect: ConnectRuntimeStatus | undefined
  launchAtLogin: boolean
}

const separator: MenuItemModel = { id: 'separator', type: 'separator', label: '', enabled: false }

export function serverStateLabel(input: TrayModelInput): string {
  const t = strings(input.language)
  switch (input.server.state) {
    case 'running':
      return t.serverRunning
    case 'starting':
      return t.serverStarting
    case 'backoff':
      return t.serverBackoff
    case 'failed':
      return t.serverFailed
    default:
      return t.serverStopped
  }
}

export function connectStateLabel(input: TrayModelInput): string | undefined {
  const t = strings(input.language)
  if (input.connect === undefined) return undefined
  switch (input.connect.state) {
    case 'ready':
      return t.connectReady
    case 'unhardened':
      return t.connectUnhardened
    default:
      return t.connectAbsent
  }
}

/** 工作台只有服务真的健康时才点得开——省得用户点开一个白屏。 */
export function canOpenWorkstation(input: TrayModelInput): boolean {
  return input.health?.ok === true
}

export function buildTrayMenu(input: TrayModelInput): MenuItemModel[] {
  const t = strings(input.language)
  const openable = canOpenWorkstation(input)
  const items: MenuItemModel[] = [
    { id: 'open-workstation', type: 'normal', label: t.openWorkstation, enabled: openable },
    { id: 'open-browser', type: 'normal', label: t.openInBrowser, enabled: openable },
    separator,
    {
      id: 'toggle-pause',
      type: 'checkbox',
      label: input.paused ? t.resume : t.pause,
      enabled: true,
      checked: input.paused,
    },
    separator,
    {
      id: 'status',
      type: 'normal',
      label: `${t.statusHeading}：${serverStateLabel(input)}${statusSuffix(input)}`,
      enabled: false,
    },
  ]
  const connect = connectStateLabel(input)
  if (connect !== undefined)
    items.push({ id: 'status', type: 'normal', label: connect, enabled: false })
  items.push(
    { id: 'restart-server', type: 'normal', label: t.restartServer, enabled: true },
    // WP31：换一把本机秘密库密钥（整库重加密）。服务得活着才换得了。
    {
      id: 'rotate-secrets-key',
      type: 'normal',
      label: t.rotateSecretsKey,
      enabled: input.health?.ok === true,
    },
    { id: 'open-logs', type: 'normal', label: t.openLogs, enabled: true },
    {
      id: 'toggle-launch-at-login',
      type: 'checkbox',
      label: t.launchAtLogin,
      enabled: true,
      checked: input.launchAtLogin,
    },
    separator,
    { id: 'quit', type: 'normal', label: t.quit, enabled: true },
  )
  return items
}

function statusSuffix(input: TrayModelInput): string {
  const t = strings(input.language)
  const parts: string[] = [input.serverUrl]
  if (input.paused || input.health?.halted === true) parts.push(t.paused)
  return `（${parts.join('，')}）`
}

export function trayTooltip(input: TrayModelInput): string {
  const t = strings(input.language)
  return `agentsws ${input.version} · ${serverStateLabel(input)}${
    input.paused ? ` · ${t.paused}` : ''
  }`
}
