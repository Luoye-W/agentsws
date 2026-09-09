/** 托盘文案。配置里的 `language` 决定用哪一份；只有托盘用得上，业务界面的文案在工作台。 */
import type { Language } from './config.js'

export interface Strings {
  openWorkstation: string
  openInBrowser: string
  pause: string
  resume: string
  statusHeading: string
  serverRunning: string
  serverStarting: string
  serverBackoff: string
  serverFailed: string
  serverStopped: string
  connectReady: string
  connectAbsent: string
  connectUnhardened: string
  restartServer: string
  openLogs: string
  launchAtLogin: string
  quit: string
  paused: string
  version: string
}

const ZH: Strings = {
  openWorkstation: '打开工作台',
  openInBrowser: '在浏览器打开',
  pause: '暂停（急停）',
  resume: '恢复运行',
  statusHeading: '状态',
  serverRunning: '服务运行中',
  serverStarting: '服务启动中',
  serverBackoff: '服务已退出，等待重启',
  serverFailed: '服务反复启动失败',
  serverStopped: '服务已停止',
  connectReady: '连接器 runtime：已加固',
  connectAbsent: '连接器 runtime：未检测到',
  connectUnhardened: '连接器 runtime：未加固，已拒绝接入',
  restartServer: '重启服务',
  openLogs: '打开日志目录',
  launchAtLogin: '开机自启',
  quit: '退出',
  paused: '已暂停',
  version: '版本',
}

const EN: Strings = {
  openWorkstation: 'Open workstation',
  openInBrowser: 'Open in browser',
  pause: 'Pause (halt)',
  resume: 'Resume',
  statusHeading: 'Status',
  serverRunning: 'Service running',
  serverStarting: 'Service starting',
  serverBackoff: 'Service exited, retrying',
  serverFailed: 'Service keeps failing',
  serverStopped: 'Service stopped',
  connectReady: 'Connector runtime: hardened',
  connectAbsent: 'Connector runtime: not detected',
  connectUnhardened: 'Connector runtime: not hardened, refused',
  restartServer: 'Restart service',
  openLogs: 'Open log folder',
  launchAtLogin: 'Launch at login',
  quit: 'Quit',
  paused: 'Paused',
  version: 'Version',
}

export function strings(language: Language): Strings {
  return language === 'en-US' ? EN : ZH
}
