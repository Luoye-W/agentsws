/**
 * 托盘菜单的**数据模型**（13 §5：打开工作台 / 在浏览器打开 / 暂停 / 状态 / 退出）。
 *
 * `main.ts` 只负责把它翻译成 `Menu.buildFromTemplate`——判定全在这里，所以能测。
 */
import type { Language } from './config.js'
import type { ConnectRuntimeStatus } from './connect-runtime.js'
import type { HealthSnapshot } from './health.js'
import { strings } from './i18n.js'
import type { DesktopMode } from './mode.js'
import type { SidecarSnapshot } from './sidecar.js'

export type MenuAction =
  | 'open-workstation'
  | 'open-browser'
  | 'toggle-pause'
  | 'open-logs'
  | 'toggle-launch-at-login'
  | 'restart-server'
  | 'rotate-secrets-key'
  /** WP82（55 §3 末段）：起一个单独 Profile 的工作用 Chrome，并把地址写进设置。 */
  | 'open-work-browser'
  /** WP92（55 §10）：问一句「我正在用的浏览器」那一套装好没有（跑一次 `bsk doctor`）。 */
  | 'check-browser-extension'
  /** WP111：升级出事之后，回到升级之前那一份。 */
  | 'restore-backup'
  /** WP111：白名单式收集一个 zip 发回来（不含任何凭据 / 正文）。 */
  | 'export-diagnostics'
  /** WP111：mac / linux 只提示那一档，点它开 Releases 下载页。 */
  | 'open-download-page'
  /** WP136（docs/79）：切到某个 dsh 场景（`MenuItemModel.scene` 说是哪一个）。 */
  | 'switch-scene'
  /** WP136：打开工作台里的场景面板（新建 / 关闭 / 删除都在那儿）。 */
  | 'manage-scenes'
  /** WP144（docs/80 §5）：AI 正在操作电脑时的「停止」——撤销授权 + 中断那次运行。 */
  | 'stop-computer-use'
  /** WP148：打开安装包里的第三方许可证说明（`<resources>/licenses/THIRD_PARTY_LICENSES.txt`）。 */
  | 'open-licenses'
  | 'quit'

export interface MenuItemModel {
  id: MenuAction | 'status' | 'separator' | 'submenu'
  type: 'normal' | 'separator' | 'checkbox' | 'submenu'
  label: string
  enabled: boolean
  checked?: boolean
  /** `type: 'submenu'` 时的子项。 */
  submenu?: MenuItemModel[]
  /** `id: 'switch-scene'` 时切到哪个场景。 */
  scene?: string
}

/**
 * WP136（docs/79）：托盘上认得的一个场景（服务进程 `GET /v1/dsh-scenes` 的精简版）。
 * 只列点得开的（Agents 工坊与网页场景）；命令行类场景在工作台的场景面板里才看得到。
 */
export interface TrayScene {
  name: string
  origin: 'agentsws' | 'official' | 'custom'
  state: 'stopped' | 'starting' | 'running' | 'failed'
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
  /** WP36：`remote` 时这台电脑不起服务进程，托盘上说的是"已连接谁"（40 §1.3）。 */
  mode?: DesktopMode
  /** 公司名（登录前退到主机名，见 `mode.companyLabel`）。 */
  company?: string
  /**
   * WP111：服务进程上次启动时升级没成功（数据目录里有 `upgrade-failed.json`）。
   *
   * 托盘要多说一句、多给一项：状态那行改说"升级没成功，数据没动"，
   * 菜单里出现「还原上一份备份」。**没出事的时候这一项不出现**——
   * 一个平时就摆在那儿的"还原"按钮，迟早有人会在没出事的时候点它。
   */
  upgradeFailed?: boolean
  /** 有没有可还原的备份（纸条里带了路径）。没有就那一项灰着。 */
  restorable?: boolean
  /**
   * WP111：查到的新版本号（只在**只提示**那一档有值：mac / linux）。
   *
   * Windows 那一档不用它——那边是应用内自动更新，托盘上挂一句"去下载"反而是
   * 让用户多做一件本来不用做的事。
   */
  updateAvailable?: string
  /**
   * WP60：这台电脑是不是"值守中的远程窗口"（服务地址是 `https://<云>/w/<ws>`）。
   *
   * 与 `mode: 'remote'` 的差别在于用户看到的那句话：连公司 NAS 是"已连接 NAS"，
   * 值守是"值守中：云上运行"——后者要回答的是"我关了电脑还有人接活吗"。
   */
  standby?: boolean
  /**
   * WP136：能切的场景。`undefined` = 还没问到（服务没起来 / 连公司服务器那一档），
   * 那时「切换场景」这一项不出现——摆一个点开是空的子菜单比没有它更糟。
   */
  scenes?: TrayScene[]
  /**
   * WP144（docs/80 §5）：现在有没有 AI 在操作这台电脑（`GET /v1/computer-use/active`）。
   * 有 = 托盘图标变红、菜单最上面一行「AI 正在操作电脑 · 停止」。`until` 是授权到的 ISO 时间。
   */
  computerUse?: { until: string }
  /**
   * WP148：安装包里有没有第三方许可证说明（打包时 `after-pack.mjs` 写的那份）。
   * 有才出「开源软件许可」这一项；开发时直接跑的那一份没有，就不摆一个点了打不开的菜单项。
   */
  licenses?: boolean
}

const separator: MenuItemModel = { id: 'separator', type: 'separator', label: '', enabled: false }

export function serverStateLabel(input: TrayModelInput): string {
  const t = strings(input.language)
  // WP111：升级没成功时，"服务反复启动失败"是对的但没用——用户要的是
  // "我的数据还在吗"。所以这一行先回答那个。
  if (input.mode !== 'remote' && input.upgradeFailed === true) return t.upgradeFailedStatus
  // remote：这台电脑没有 sidecar，`server.state` 永远是 `stopped`——
  // 把那句"服务已停止"端给用户是错的，他要看的是"连上公司了没有"。
  if (input.mode === 'remote') {
    if (input.health?.ok !== true) return t.remoteUnreachable
    // WP60 值守：这台电脑关了也照常接活——这是用户唯一真正关心的一句
    if (input.standby === true) return t.standbyRunning
    return `${t.connectedTo} ${input.company ?? ''}`.trim()
  }
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

/** 授权到几点（本地时间 HH:MM）；解析不了就原样给。 */
function clockOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * WP144：AI 正在操作这台电脑时，托盘菜单**最上面**的两行——一行说明（灰的）、一行「停止」。
 * 放最上面：这是那一刻用户最该看见、最可能想点的东西。没在操作时一行都不出。
 */
export function computerUseItems(input: TrayModelInput): MenuItemModel[] {
  if (input.mode === 'remote' || input.computerUse === undefined) return []
  const t = strings(input.language)
  return [
    {
      id: 'status',
      type: 'normal',
      label: t.computerUseActive.replace('{until}', clockOf(input.computerUse.until)),
      enabled: false,
    },
    { id: 'stop-computer-use', type: 'normal', label: t.computerUseStop, enabled: true },
    separator,
  ]
}

export function buildTrayMenu(input: TrayModelInput): MenuItemModel[] {
  const t = strings(input.language)
  const openable = canOpenWorkstation(input)
  const items: MenuItemModel[] = [
    ...computerUseItems(input),
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
  const scenes = sceneSubmenu(input)
  if (scenes !== undefined) items.splice(3 + computerUseItems(input).length, 0, scenes, separator)
  const connect = connectStateLabel(input)
  if (connect !== undefined)
    items.push({ id: 'status', type: 'normal', label: connect, enabled: false })
  // remote：服务进程与本机秘密库都不在这台电脑上，这两项没有意义——
  // 摆一个点了不生效的菜单项比没有它更糟（`SEED_POSITIONS` 那条同一个道理）。
  if (input.mode !== 'remote')
    items.push(
      { id: 'restart-server', type: 'normal', label: t.restartServer, enabled: true },
      // WP31：换一把本机秘密库密钥（整库重加密）。服务得活着才换得了。
      {
        id: 'rotate-secrets-key',
        type: 'normal',
        label: t.rotateSecretsKey,
        enabled: input.health?.ok === true,
      },
      /*
       * WP82（55 §3 末段）：「打开工作用的浏览器」。
       *
       * 只在本机档出现，与上面两项同一条理由：`remote` 档下服务不在这台电脑上，
       * 起在这儿的浏览器那边根本连不到（`127.0.0.1` 指的是各自那一台）。
       * 服务得活着才点得动——起完浏览器要把地址 `PUT` 回设置，服务不在就写不进去。
       */
      {
        id: 'open-work-browser',
        type: 'normal',
        label: t.openWorkBrowser,
        enabled: input.health?.ok === true,
      },
      /*
       * WP92（55 §10）：「检查浏览器扩展」。与上面那条同一条理由——扩展与 `bsk`
       * 都在**这台电脑**上，`remote` 档问不出所以然。服务得活着：体检是服务端跑的。
       */
      {
        id: 'check-browser-extension',
        type: 'normal',
        label: t.checkBrowserExtension,
        enabled: input.health?.ok === true,
      },
    )
  // WP111：只有真出事了才出现。`restorable: false` 时灰着但仍然摆出来——
  // 用户需要看见"有这么一个东西，只是这次没有备份可还原"。
  if (input.mode !== 'remote' && input.upgradeFailed === true)
    items.push({
      id: 'restore-backup',
      type: 'normal',
      label: t.restoreBackup,
      enabled: input.restorable === true,
    })
  // WP111：mac / linux 那一档查到新版本就挂一项，点了开 Releases。
  // 摆在「打开日志目录」上面：它是这一刻用户最可能想点的那一个。
  if (input.updateAvailable !== undefined && input.updateAvailable !== '')
    items.push({
      id: 'open-download-page',
      type: 'normal',
      label: t.updateAvailable.replace('{version}', input.updateAvailable),
      enabled: true,
    })
  items.push(
    { id: 'open-logs', type: 'normal', label: t.openLogs, enabled: true },
    // WP111：**一直在**，不像「还原上一份备份」那样只在出事时出现——
    // 出问题的时候她第一反应是找托盘，那一刻不该还要先让某个东西"出现"。
    { id: 'export-diagnostics', type: 'normal', label: t.exportDiagnostics, enabled: true },
  )
  // WP148：安装包里的「关于 / 许可证」——这个应用没有主窗口也没有应用菜单，托盘就是它的「关于」
  if (input.licenses === true)
    items.push({ id: 'open-licenses', type: 'normal', label: t.openLicenses, enabled: true })
  items.push(
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

/**
 * WP136：「切换场景」子菜单。Agents 工坊第一个、打着勾（这个托盘本身就是它）；
 * 其余网页场景跟在后面，在跑的挂「运行中」；最后一项「管理场景…」去工作台。
 *
 * 只在本机档、服务健康、问到过场景清单时出现：场景是这台电脑上的 dsh 起的，
 * 连公司服务器那一档这台电脑上没有服务进程可问。
 */
export function sceneSubmenu(input: TrayModelInput): MenuItemModel | undefined {
  if (input.mode === 'remote' || input.scenes === undefined || input.health?.ok !== true)
    return undefined
  const t = strings(input.language)
  const suffix = (s: TrayScene): string =>
    s.state === 'running'
      ? `（${t.sceneRunning}）`
      : s.state === 'starting'
        ? `（${t.sceneStarting}）`
        : ''
  const others = input.scenes.filter((s) => s.origin !== 'agentsws')
  return {
    id: 'submenu',
    type: 'submenu',
    label: t.switchScene,
    enabled: true,
    submenu: [
      {
        id: 'switch-scene',
        type: 'checkbox',
        label: t.sceneAgentsws,
        enabled: true,
        checked: true,
        scene: 'agentsws',
      },
      ...others.map(
        (s): MenuItemModel => ({
          id: 'switch-scene',
          type: 'normal',
          label: `${s.name}${suffix(s)}`,
          enabled: true,
          scene: s.name,
        }),
      ),
      separator,
      { id: 'manage-scenes', type: 'normal', label: t.manageScenes, enabled: true },
    ],
  }
}

function statusSuffix(input: TrayModelInput): string {
  const t = strings(input.language)
  const parts: string[] = [input.serverUrl]
  if (input.paused || input.health?.halted === true) parts.push(t.paused)
  return `（${parts.join('，')}）`
}

export function trayTooltip(input: TrayModelInput): string {
  const t = strings(input.language)
  const cu =
    input.mode !== 'remote' && input.computerUse !== undefined
      ? ` · ${t.computerUseActive.replace('{until}', clockOf(input.computerUse.until))}`
      : ''
  return `Agents 工坊 ${input.version} · ${serverStateLabel(input)}${
    input.paused ? ` · ${t.paused}` : ''
  }${cu}`
}
