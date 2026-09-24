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
  /** WP82（55 §3 末段）：给 AI 起一个**单独的**工作用 Chrome（带调试口）。 */
  openWorkBrowser: string
  /** WP92（55 §10）：「我正在用的浏览器」那一套（扩展 + bsk）装好没有。 */
  checkBrowserExtension: string
  /** WP136（docs/79）：托盘「切换场景」子菜单。 */
  switchScene: string
  /** Agents 工坊自己那个场景在菜单上叫什么。 */
  sceneAgentsws: string
  /** 场景在跑时名字后面挂的那一截。 */
  sceneRunning: string
  sceneStarting: string
  /** 子菜单最后一项：打开工作台里的场景面板（新建 / 删除 / 关闭都在那儿）。 */
  manageScenes: string
  /** 场景起不来时弹的那一句。 */
  sceneOpenFailed: string
  browserExtensionOk: string
  browserExtensionBad: string
  openLogs: string
  /** WP111：托盘「导出诊断包」。 */
  exportDiagnostics: string
  /** WP111：升级出事之后那一项「还原上一份备份」。 */
  restoreBackup: string
  /** WP111：mac / linux 只提示那一档，托盘上挂的那一项。 */
  updateAvailable: string
  /** 弹通知的标题。 */
  updateAvailableTitle: string
  /** 升级没成功，但数据一个字节都没动（迁移在事务里，失败整条回滚）。 */
  upgradeFailedIntact: string
  /** 万一真动了（理论上不该出现，出现了就得说实话）。 */
  upgradeFailedTouched: string
  upgradeBackupAt: string
  upgradeNoBackup: string
  /** 卡在备份那一步：连升级前那份都没做成，所以一条迁移都没跑。 */
  upgradeBackupFailed: string
  /** 托盘状态里那一行「升级没成功」。 */
  upgradeFailedStatus: string
  launchAtLogin: string
  quit: string
  paused: string
  version: string
  // WP36 / 40 §1.3：连公司服务器那一档
  connectedTo: string
  /** WP60：值守中（工作区的服务进程在云上跑，这台电脑只是个窗口）。 */
  standbyRunning: string
  remoteUnreachable: string
  wizardTitle: string
  wizardBody: string
  wizardLocal: string
  wizardRemote: string
  wizardUrlLabel: string
  wizardConfirm: string
  wizardCancel: string
  wizardInvalidUrl: string
  /** WP144（docs/80）：托盘最上面那一行——AI 正在操作这台电脑（`{until}` 是授权到几点）。 */
  computerUseActive: string
  /** 那一行下面的「停止」：撤销授权 + 中断那次运行。 */
  computerUseStop: string
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
  openWorkBrowser: '打开工作用的浏览器',
  checkBrowserExtension: '检查浏览器扩展',
  switchScene: '切换场景',
  sceneAgentsws: 'Agents 工坊',
  sceneRunning: '运行中',
  sceneStarting: '启动中',
  manageScenes: '管理场景…',
  sceneOpenFailed: '场景「{name}」没打开：{detail}',
  browserExtensionOk: '浏览器扩展已连上，可以用你正在用的浏览器干活了。',
  browserExtensionBad: '还没好：{detail}',
  openLogs: '打开日志目录',
  exportDiagnostics: '导出诊断包…',
  restoreBackup: '还原上一份备份',
  updateAvailable: '有新版本 {version}，去下载…',
  updateAvailableTitle: 'Agents 工坊有新版本',
  upgradeFailedIntact: '升级没成功，你的数据一个字节都没动。',
  upgradeFailedTouched: '升级中断了，数据可能只改了一半——先还原备份，别继续用。',
  upgradeBackupAt: '升级前的备份在：{path}',
  upgradeNoBackup: '这次没有留下升级前的备份（这次升级本来就不动数据）。',
  upgradeBackupFailed:
    '升级前的备份没做成，所以一条迁移都没跑——先看看磁盘还剩多少，再导一份诊断包发回来。',
  upgradeFailedStatus: '升级没成功，数据没动',
  launchAtLogin: '开机自启',
  quit: '退出',
  paused: '已暂停',
  version: '版本',
  connectedTo: '已连接',
  standbyRunning: '值守中：云上运行',
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
  computerUseActive: 'AI 正在操作电脑（到 {until}）',
  computerUseStop: '停止',
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
  openWorkBrowser: 'Open the work browser',
  checkBrowserExtension: 'Check the browser extension',
  switchScene: 'Switch scene',
  sceneAgentsws: 'Agents Workshop',
  sceneRunning: 'running',
  sceneStarting: 'starting',
  manageScenes: 'Manage scenes…',
  sceneOpenFailed: 'Scene "{name}" did not open: {detail}',
  browserExtensionOk:
    'The browser extension is connected — your everyday browser is ready to work.',
  browserExtensionBad: 'Not ready: {detail}',
  openLogs: 'Open log folder',
  exportDiagnostics: 'Export a diagnostics bundle…',
  restoreBackup: 'Restore the last backup',
  updateAvailable: 'Version {version} is out — open the download page…',
  updateAvailableTitle: 'A new Agents Workshop is available',
  upgradeFailedIntact: 'The upgrade did not go through. Not one byte of your data was touched.',
  upgradeFailedTouched:
    'The upgrade stopped halfway and your data may be half-changed. Restore the backup before using it again.',
  upgradeBackupAt: 'The pre-upgrade backup is at: {path}',
  upgradeNoBackup: 'No pre-upgrade backup was taken (this upgrade does not touch data).',
  upgradeBackupFailed:
    'The pre-upgrade backup could not be made, so no migration ran at all. Check free disk space, then export a diagnostics bundle.',
  upgradeFailedStatus: 'Upgrade failed, data untouched',
  launchAtLogin: 'Launch at login',
  quit: 'Quit',
  paused: 'Paused',
  version: 'Version',
  connectedTo: 'Connected to',
  standbyRunning: 'Standby: running in the cloud',
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
  computerUseActive: 'AI is operating this computer (until {until})',
  computerUseStop: 'Stop',
}

export function strings(language: Language): Strings {
  return language === 'en-US' ? EN : ZH
}
