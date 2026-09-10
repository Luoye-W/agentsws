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
  rotateSecretsKey: string
  openLogs: string
  launchAtLogin: string
  quit: string
  paused: string
  version: string
  // WP36 / 40 §1.3：连公司服务器那一档
  connectedTo: string
  remoteUnreachable: string
  wizardTitle: string
  wizardBody: string
  wizardLocal: string
  wizardRemote: string
  wizardUrlLabel: string
  wizardConfirm: string
  wizardCancel: string
  wizardInvalidUrl: string
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
  rotateSecretsKey: '轮换本机密钥',
  openLogs: '打开日志目录',
  launchAtLogin: '开机自启',
  quit: '退出',
  paused: '已暂停',
  version: '版本',
  connectedTo: '已连接',
  remoteUnreachable: '连不上公司服务器',
  wizardTitle: '这台电脑怎么用？',
  wizardBody:
    '数据永远在公司自己的机器上。选「本机」= 这台电脑就是那台机器（一个人 / 两三人）；选「公司服务器」= 数据在公司那台常开的机器 / NAS 上，这台电脑只是客户端，本机不存真源。',
  wizardLocal: '本机（这台电脑就是服务器）',
  wizardRemote: '连接公司服务器',
  wizardUrlLabel: '公司服务器地址',
  wizardConfirm: '就这样',
  wizardCancel: '下次再说',
  wizardInvalidUrl: '地址要以 http:// 或 https:// 开头',
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
  rotateSecretsKey: 'Rotate local key',
  openLogs: 'Open log folder',
  launchAtLogin: 'Launch at login',
  quit: 'Quit',
  paused: 'Paused',
  version: 'Version',
  connectedTo: 'Connected to',
  remoteUnreachable: 'Cannot reach the company server',
  wizardTitle: 'How will this computer be used?',
  wizardBody:
    'Your data always lives on a machine your company owns. Pick “This computer” if it is that machine (one to three people). Pick “Company server” if the data lives on an always-on machine or NAS — then this computer is only a client and stores no source of truth.',
  wizardLocal: 'This computer (it is the server)',
  wizardRemote: 'Connect to the company server',
  wizardUrlLabel: 'Company server address',
  wizardConfirm: 'Use this',
  wizardCancel: 'Ask me later',
  wizardInvalidUrl: 'The address must start with http:// or https://',
}

export function strings(language: Language): Strings {
  return language === 'en-US' ? EN : ZH
}
