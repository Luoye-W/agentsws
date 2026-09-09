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
 * 桥面只有四件能力，多一件都不给：给得越少，"同一份 UI 在普通浏览器里完整可用"
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
}

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
} as const

export interface BridgeInfo {
  platform: string
  version: string
}
