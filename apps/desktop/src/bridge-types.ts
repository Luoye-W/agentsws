/**
 * 原生桥接层的类型（13 §5「原生增强经一个很小的桥接层，做特性检测，浏览器里自动退化」）。
 *
 * **纪律**：工作台的业务界面不 import 任何 electron 东西，只 `import type` 这个文件，
 * 运行时一律先特性检测：
 *
 * ```ts
 * import type { DesktopBridge } from '@agentsws/desktop/bridge'
 *
 * const bridge: DesktopBridge | undefined = globalThis.window?.agentsws
 * if (bridge !== undefined) await bridge.notify({ title: '有 3 条待审批' })
 * else new Notification('有 3 条待审批')       // 普通浏览器里的退化路径
 * ```
 *
 * 桥面只有这几件能力（WP184 加了「打开场景」，WP218 加了「更新」，WP361 加了「开机自启」），多一件都不给：给得越少，"同一份 UI 在普通浏览器里完整可用"
 * 这条就越站得住。凭据类的东西一概不走这里（13 §4.3：原生表单直填，不经渲染进程）。
 */

export interface NotifyInput {
  title: string
  body?: string
  /**
   * WP429：点了这条系统通知去哪（工作台里的地址，`/` 开头）。新壳点了把主窗口叫到前面、
   * 经 {@link DesktopBridge.onNotificationClick} 交回页面去跳；旧壳不认这一格（只弹不跳）。
   */
  path?: string
}

export interface DesktopBridge {
  /** `darwin` / `win32` / `linux`。 */
  readonly platform: string
  /** 桌面壳版本号（不是服务进程的）。 */
  readonly version: string
  /** 原生通知；系统不支持时返回 false。 */
  notify(input: NotifyInput): Promise<boolean>
  /**
   * WP429：点了带 `path` 的系统通知——主进程把窗口叫到前面，再把地址交给这里（页面自己跳）。
   * 旧壳没有这一项：先判空。回取消订阅的函数。
   */
  onNotificationClick?(listener: (path: string) => void): () => void
  /** 用系统浏览器打开；只接受 http / https / mailto，其余返回 false。 */
  openExternal(url: string): Promise<boolean>
  /**
   * WP184（docs/79 §3.1）：打开一个 dsh 网页场景（官方 `web` 或自建的）。壳自己问服务进程、
   * 自己拿那条带一次性 token 的网址——**网址不进渲染进程**；默认开在壳的独立窗口里，
   * 用户在托盘勾了「在浏览器里打开场景」就交给系统浏览器。旧壳没有这一项：先判空。
   */
  openScene?(name: string, options?: { restart?: boolean }): Promise<SceneOpenOutcome>
  /**
   * WP218：应用内一键更新（左下角那颗「有新版本」按钮）。旧壳没有这一项：先判空。
   * 状态由主进程的状态机说了算，页面只看、只点；下载与安装都在主进程里做。
   */
  update?: DesktopUpdateBridge
  /**
   * WP353：应用内搜索浏览器「要人介入」的那一页（Google 人机验证 / 网站要登录）。平时静默、不出现；
   * 有一页要人点时第三栏「浏览器」亮出来，把位置给壳、壳把那一页挂上去。旧壳没有这一项：先判空。
   */
  searchBrowser?: DesktopSearchBridge
  /**
   * WP361（决策 927）：开机自启——设置弹窗「这台电脑 → 桌面端」里的开关。和托盘菜单那一项是同一份，
   * 哪边改了另一边都跟着变。旧壳没有这一项：先判空（没有就不出这个开关）。
   */
  launchAtLogin?: DesktopLaunchAtLoginBridge
  /**
   * WP358：会话丢了（过期 / 服务进程重启）→ 让壳用会话密钥给所有者重换一张，cookie 照旧只进
   * cookie 罐。回 `true` 就再请求一次 `/v1/me`；`remote` 档与旧壳没有这一项或回 `false`，走登录页。
   */
  session?: DesktopSessionBridge
  /**
   * WP424：主窗口藏了系统标题栏（`window-chrome.ts`）。`inset` = Mac 红绿灯嵌在左上（左栏顶部留位置），
   * `overlay` = Windows 三个按钮叠在右上（顶栏右边让出、颜色跟主题）。旧壳与 Linux 没有这一项——
   * 页面就照普通网页排（不留那块空、顶栏不设拖动区）。
   */
  titleBar?: DesktopTitleBarBridge
  /**
   * WP475：反馈框「附上截图」——截当前工坊窗口（只截工坊自己的窗口）。回 JPEG 的 base64；
   * 截不到 / 太大回 `null`。旧壳没有这一项：先判空（页面退回粘贴 / 拖入图片）。
   */
  captureWindow?(): Promise<DesktopCapture | null>
}

/** WP475：截到的那一张。 */
export interface DesktopCapture {
  content_type: 'image/jpeg'
  data_base64: string
}

/** WP424：藏起来的标题栏（只有样子与「换主题」一件事）。 */
export interface DesktopTitleBarBridge {
  readonly style: 'inset' | 'overlay'
  /** 工作台换了深 / 浅色：Windows 叠加按钮那一块跟着换底色（Mac 上是空操作，回 false）。 */
  setTheme(theme: 'light' | 'dark'): Promise<boolean>
}

/** WP361：开机自启（读 / 写系统登录项；真源是壳的配置）。 */
export interface DesktopLaunchAtLoginBridge {
  get(): Promise<boolean>
  /** 设成开 / 关，回改完的值。 */
  set(on: boolean): Promise<boolean>
  /** 别处（托盘）改了时回调；返回取消订阅。 */
  onChange(listener: (on: boolean) => void): () => void
}

/** WP358：页面只拿到「换没换成」，拿不到会话本身。 */
export interface DesktopSessionBridge {
  renew(): Promise<boolean>
}

/** WP353：要人介入的那一页。 */
export interface DesktopSearchHandover {
  workspace_id: string
  reason: 'captcha' | 'login' | 'consent'
  /** 第三栏上那一句（服务进程定）。 */
  message: string
  url: string
}

export interface DesktopSearchBridge {
  pending(): Promise<DesktopSearchHandover | null>
  /** 亮出来 / 收起时回调；返回取消订阅。 */
  onChange(listener: (handover: DesktopSearchHandover | null) => void): () => void
  /** 第三栏那块地方在窗口里的位置；`null` = 收起（面板关了 / 切走了）。 */
  place(rect: { x: number; y: number; width: number; height: number } | null): Promise<boolean>
  /** 「先不管了」：收起那一页（不算验证过）。 */
  dismiss(): Promise<boolean>
}

/** WP218：更新状态（主进程 `update-controller.ts` 的 `UpdateStatus` 去掉原始错误文本）。 */
export type DesktopUpdateStatus =
  | { state: 'idle' }
  | {
      state: 'available'
      version: string
      /** `auto` = 点了在应用里下；`notify` = 这台电脑只能去下载页（mac 未签名）。 */
      mode: 'auto' | 'notify'
      source: 'primary' | 'github'
      url?: string
    }
  | {
      state: 'downloading'
      version: string
      /** 0 = 还没收到进度事件（增量下载不发进度）。 */
      percent: number
      source: 'primary' | 'github'
      /** WP351：下完了、在摆新版（解压 / 冒烟）。 */
      phase?: 'prepare'
    }
  | { state: 'ready'; version: string; source: 'primary' | 'github' }
  /** WP337：等没有正在输出的运行就自己重启（按钮显示「等空闲后重启」，点一下取消）。 */
  | { state: 'waiting'; version: string; source: 'primary' | 'github' }
  | { state: 'installing'; version: string }
  | {
      state: 'error'
      stage: 'download' | 'install'
      /** 人话分类，界面按它挑文案。 */
      code: 'network' | 'not_found' | 'checksum' | 'disk' | 'smoke' | 'install' | 'unknown'
      version: string
    }

export type DesktopInstallOutcome = 'installing' | 'cancelled' | 'blocked' | 'not-ready' | 'waiting'

/** WP337：有任务在做时的三个选项（「稍后」页面自己关框，不用告诉壳）。 */
export type DesktopRestartChoice = 'now' | 'idle'

/** WP337：现在在做什么（弹窗那一句「还有 N 件在做」+ 展开的清单）。 */
export interface DesktopRestartReadiness {
  /** 三类加起来几件。 */
  total: number
  /** 没有正在输出的。 */
  idle: boolean
  counts: { output: number; background: number; scheduled: number }
  /** 每件一句话；`kind` 决定图标。 */
  items: { kind: 'output' | 'background' | 'scheduled'; title: string }[]
}

export interface DesktopUpdateBridge {
  status(): Promise<DesktopUpdateStatus>
  /** 状态一变就回调；返回取消订阅。 */
  onChange(listener: (status: DesktopUpdateStatus) => void): () => void
  /** 点「更新」/「重试」：auto 档后台下载，notify 档打开下载页。 */
  download(): Promise<DesktopUpdateStatus>
  /** 点「重启并更新」：有任务在跑会先弹原生确认框。 */
  install(): Promise<DesktopInstallOutcome>
  /** WP337：点「重启并更新」之前看一眼在做什么（问不到回 total 0）。旧壳没有：先判空。 */
  readiness?(): Promise<DesktopRestartReadiness>
  /** WP337：页面上已经三选一了——现在重启 / 空闲时重启（不再弹原生框）。 */
  restart?(choice: DesktopRestartChoice): Promise<DesktopInstallOutcome>
  /** WP337：「等空闲后重启」时点一下取消。 */
  cancelWait?(): Promise<boolean>
  /**
   * WP409：下载断了时的另一条出路——打开官网下载页手动装（地址由壳定，页面不传网址）。
   * 旧壳没有：先判空（没有就不出「去下载页」）。
   */
  openDownloadPage?(): Promise<boolean>
  /**
   * WP426：设置里「检查更新」——立刻去查一次（与托盘那一项同一个 `check`），回查完的状态。
   * 旧壳没有：先判空（没有就不出那个按钮）。
   */
  check?(): Promise<DesktopUpdateStatus>
}

/** WP184：`openScene` 的结果。`where` 说开在了哪（界面据此说一句「已在窗口 / 浏览器里打开」）。 */
export type SceneOpenOutcome =
  | { ok: true; where: 'window' | 'browser' }
  | { ok: false; reason: string }

declare global {
  interface Window {
    /** 只有在 Electron 壳里才存在——业务代码必须先判空。 */
    readonly agentsws?: DesktopBridge
  }
}

/** 桥接对象挂在 `window` 上的名字。preload 与前端各引一次，别写字面量。 */
export const BRIDGE_KEY = 'agentsws'

/** IPC 通道名；只有 preload 与 main 用得着。 */
export const BRIDGE_CHANNELS = {
  info: 'agentsws:bridge-info',
  notify: 'agentsws:notify',
  /** WP429：点了系统通知（主进程 → 页面，带地址） */
  notifyClicked: 'agentsws:notify-clicked',
  openExternal: 'agentsws:open-external',
  /** WP184 */
  openScene: 'agentsws:open-scene',
  /** WP218 */
  updateStatus: 'agentsws:update-status',
  updateChanged: 'agentsws:update-changed',
  updateDownload: 'agentsws:update-download',
  updateInstall: 'agentsws:update-install',
  /** WP337 */
  updateReadiness: 'agentsws:update-readiness',
  updateRestart: 'agentsws:update-restart',
  updateCancelWait: 'agentsws:update-cancel-wait',
  /** WP409 */
  updateOpenPage: 'agentsws:update-open-page',
  /** WP426 */
  updateCheck: 'agentsws:update-check',
  /** WP353 */
  searchPending: 'agentsws:search-pending',
  searchChanged: 'agentsws:search-changed',
  searchPlace: 'agentsws:search-place',
  searchDismiss: 'agentsws:search-dismiss',
  /** WP361 */
  launchAtLoginGet: 'agentsws:launch-at-login-get',
  launchAtLoginSet: 'agentsws:launch-at-login-set',
  launchAtLoginChanged: 'agentsws:launch-at-login-changed',
  /** WP358 */
  sessionRenew: 'agentsws:session-renew',
  /** WP424 */
  titleBarTheme: 'agentsws:title-bar-theme',
  /** WP475 */
  captureWindow: 'agentsws:capture-window',
} as const

export interface BridgeInfo {
  platform: string
  version: string
  /** WP424：主窗口藏了系统标题栏时是哪一种（见 `window-chrome.ts`）；没藏就没有。 */
  title_bar?: 'inset' | 'overlay'
}
