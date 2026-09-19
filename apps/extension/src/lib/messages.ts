/**
 * content script ↔ background service worker 的消息协议（WP119 定论 2）。
 *
 * **为什么一定要绕一趟 background**：content script 跑在 youtube.com 的页面里，
 * 它发出去的请求带 `Origin: https://www.youtube.com`，会被浏览器按 CORS 拦下；
 * 而我们**不想**让本机服务开通配 CORS——那等于任何一个网页都能打你的本机服务。
 * service worker 没有页面 origin、持有 `host_permissions`，它发的请求带的是
 * `Origin: chrome-extension://<id>`，正好是本机服务白名单里的那一个。
 *
 * 于是「不开通配 CORS」与「插件能用」这两件事同时成立，靠的就是这一跳。
 */

import type { ExtensionHello, ExtensionObservationInput } from './wire.js'

export type ExtensionMessage =
  /** 页面上按了「收进红人库」/ 批量采集。 */
  | { type: 'observe'; observations: ExtensionObservationInput[] }
  /** 面板开屏要的状态（连上了没有、哪个品牌、会不会上公共库、排了几条）。 */
  | { type: 'status' }
  /** 设置页输入 6 位码。 */
  | { type: 'pair'; code: string }
  /** 设置页改端口。 */
  | { type: 'set-port'; port: number }
  /** 设置页「解除配对」。 */
  | { type: 'unpair' }
  /** 设置页「清空排队」。 */
  | { type: 'clear-queue' }
  /** 工具栏图标被按了 → 页面开 / 关面板。 */
  | { type: 'toggle-panel' }
  /** 页面上按了「体检并复制一行」，只是让 background 记一次 —— 不上行。 */
  | { type: 'noop' }

/** 面板与设置页共用的那一份状态。**全是事实，没有一个推断**。 */
export interface ExtensionStatus {
  paired: boolean
  /** 本机服务现在连得上吗。 */
  online: boolean
  port: number
  workspace_name?: string | undefined
  /** 登录了云账号 = 观测默认共享到公共红人库。 */
  cloud_linked: boolean
  shares_to_public_library: boolean
  /** 排着还没补上去的条数。 */
  queued: number
  /** 上一次出了什么事（人话，直接印在卡片上）。 */
  note?: string | undefined
}

export type ObserveOutcome =
  /** 真的写进本机红人库了。 */
  | { kind: 'saved'; saved: number; deduped: number; forwarded_to_public_library: number }
  /** 应用没开，收在插件里排着。 */
  | { kind: 'queued'; queued: number; message: string }
  /** 配对失效 / 别的错。 */
  | { kind: 'failed'; message: string }

export type ExtensionResponse =
  | { type: 'status'; status: ExtensionStatus }
  | { type: 'observe'; outcome: ObserveOutcome }
  | { type: 'pair'; ok: boolean; message: string; status: ExtensionStatus }
  | { type: 'ack' }

/** content script 侧：给 background 发一条，拿回一条。 */
export async function send(message: ExtensionMessage): Promise<ExtensionResponse | undefined> {
  try {
    return (await chrome.runtime.sendMessage(message)) as ExtensionResponse
  } catch {
    // service worker 刚被回收 / 插件刚更新：不抛给页面，页面自己会重试。
    return undefined
  }
}

/** 面板上那句「收进哪儿」。`hello` 没答上来时也要有话说。 */
export function destinationLine(status: ExtensionStatus): string {
  if (!status.paired) return '还没和这台电脑上的 Agents 工坊配对'
  const where = status.workspace_name ?? '你的红人库'
  if (!status.online) return `收进「${where}」——应用没开，先排着`
  return status.shares_to_public_library
    ? `收进「${where}」，同时共享到公共红人库`
    : `只收进「${where}」（这台电脑上，没登录就不上传）`
}

/** 从 hello 的回答里取状态用得上的那几格。 */
export function statusFromHello(hello: ExtensionHello): {
  workspace_name: string
  cloud_linked: boolean
  shares_to_public_library: boolean
} {
  return {
    workspace_name: hello.workspace_name,
    cloud_linked: hello.cloud_linked,
    shares_to_public_library: hello.shares_to_public_library,
  }
}
