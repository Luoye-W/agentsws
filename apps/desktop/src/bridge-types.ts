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
 * 桥面只有这几件能力（WP184 加了「打开场景」，WP218 加了「更新」），多一件都不给：给得越少，"同一份 UI 在普通浏览器里完整可用"
 * 这条就越站得住。凭据类的东西一概不走这里（13 §4.3：原生表单直填，不经渲染进程）。
 */

export interface NotifyInput {
  title: string
  body?: string
}

export interface DesktopBridge {
  /** `darwin` / `win32` / `linux`。 */
  readonly platform: string
  /** 桌面壳版本号（不是服务进程的）。 */
  readonly version: string
  /** 原生通知；系统不支持时返回 false。 */
  notify(input: NotifyInput): Promise<boolean>
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
  | { state: 'downloading'; version: string; percent: number; source: 'primary' | 'github' }
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
} as const

export interface BridgeInfo {
  platform: string
  version: string
}
