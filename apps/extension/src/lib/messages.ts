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

import type { ActionPlatform } from '@agentsws/browser-action'
import type { PanelActOutcome, PanelState } from './panel/broker.js'
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
  /* ── WP313：广告（只加）──────────────────────────────────────────── */
  /** 设置页：两家后台连上没有、上次问活是什么时候、在做什么。 */
  | { type: 'ads-status' }
  /** 设置页：权限申请成功之后，把「看过风险告知，同意」记到本机服务（决策 562）。 */
  | { type: 'ads-consent'; platform: ActionPlatform; text_version: string }
  /** 设置页：马上问一次有没有活（不等定时）。 */
  | { type: 'ads-poll' }
  /** 广告后台页面顶上的横条：停止 / 确认提交 / 不提交。 */
  | { type: 'ads-stop' }
  | { type: 'ads-confirm'; answer: 'yes' | 'no' }
  /* ── WP328：Reddit 只读（只加）──────────────────────────────────── */
  /** 设置页：连上 Reddit 没有、上次读的结局。 */
  | { type: 'reddit-status' }
  /** 设置页：刚连上 / 断开，马上问一次本机。 */
  | { type: 'reddit-poll' }
  /* ── WP345：跟着工坊更新（只加）──────────────────────────────────── */
  /** 马上问一次「工坊换了新版插件没有」（不等定时；换了就等空闲重载）。 */
  | { type: 'update-check' }
  /* ── WP413：常驻侧边栏（只加）──────────────────────────────────── */
  /** 侧边栏一屏（进度 / 要你处理 / 记录）。 */
  | { type: 'panel-state' }
  /** 「填进页面」：批这张卡（改过就按改过的）并马上交给插件填。 */
  | {
      type: 'panel-fill'
      id: string
      text?: string
      title?: string
      version?: number
      /** WP432：批完就在这个窗口打开（侧边栏所在的窗口）。 */
      windowId?: number
    }
  /** 「不发」。WP445：理由可选（写了理由才跟随同类、进学习回路）。 */
  | { type: 'panel-skip'; id: string; version?: number; reason?: string }
  /** WP445：撤回「同类的也一并不发了」那几张。 */
  | { type: 'panel-follow-undo'; leader: string; ids: string[] }
  /** 没发出去的那一条「再填一次」。 */
  | { type: 'panel-refill'; job: string; text?: string }
  /** 打开设置页（侧边栏里「设置」那一下）。 */
  | { type: 'open-options' }
  /** WP419：在工坊里打开一张卡（侧边栏「去定」那一下；只认 `/cards/<id>`，后台拼本机地址）。 */
  | { type: 'open-workshop-card'; id: string }
  /** WP419（决策 1231）：打开社媒发帖页（只认那几家的站，后台再判一次）。 */
  | { type: 'open-social-compose'; url: string }
  /** WP419：交给你发的那一条：发好了（可带链接）/ 不发了。 */
  | { type: 'panel-post-done'; id: string; link?: string }
  | { type: 'panel-post-skip'; id: string; reason?: string }
  /* ── WP432：侧边栏是发帖台（只加）──────────────────────────────── */
  /**
   * 「打开这一条」：人点的这一下才把批过的那一条交给插件——在**这个窗口**新开标签页、填好、等人点发送。
   * 改过字就带上（`windowId` = 侧边栏所在的窗口）。
   */
  | { type: 'panel-open'; job: string; text?: string; title?: string; windowId?: number }
  /** 「不发了」。 */
  | { type: 'panel-drop'; job: string; reason?: string }
  /* ── WP467：人自己发出去了，帮我记一下（只加）──────────────────────── */
  /**
   * 「我发了，帮我记一下」：贴那一条的链接（`link`），或「认最近一条」（插件读这个帖子里当前登录的号最新发的那一条）。
   * `card` = 还没批的卡（记下 = 在插件里批 + 记已发）；`job` = 批过的那一条。
   */
  | {
      type: 'panel-sent'
      job?: string
      card?: { id: string; version: number }
      how: 'link' | 'latest'
      link?: string
    }

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
  /** WP202：本机说这个品牌还没人持有红人职责（`false`）；不知道就没有这一格。 */
  kol_role_held?: boolean | undefined
  /** WP202：「去建岗位」的工作台深链（hello 给了才有）。 */
  kol_setup_url?: string | undefined
}

export type ObserveOutcome =
  /** 真的写进本机红人库了。 */
  | { kind: 'saved'; saved: number; deduped: number; forwarded_to_public_library: number }
  /** 应用没开，收在插件里排着。 */
  | { kind: 'queued'; queued: number; message: string }
  /** 配对失效 / 别的错。 */
  | { kind: 'failed'; message: string }

/** WP313：设置页上「广告」那一节要的状态。 */
export interface AdsPanelStatus {
  paired: boolean
  connected: Record<ActionPlatform, boolean>
  last_poll_at?: string | undefined
  note?: string | undefined
  needs_consent?: ActionPlatform[] | undefined
  running?: { title: string } | undefined
  last_result?: { title: string; outcome: string; message: string; at: string } | undefined
}

/** WP328：设置页「Reddit」那一节要的状态。 */
export interface RedditPanelStatus {
  paired: boolean
  connected: boolean
  last_poll_at?: string | undefined
  note?: string | undefined
  user?: string | undefined
  last_result?: { outcome: string; message: string; items: number; at: string } | undefined
}

export type ExtensionResponse =
  | { type: 'status'; status: ExtensionStatus }
  | { type: 'reddit-status'; reddit: RedditPanelStatus }
  | { type: 'ads-status'; ads: AdsPanelStatus }
  | { type: 'ads-consent'; ok: boolean; message: string; ads: AdsPanelStatus }
  | { type: 'observe'; outcome: ObserveOutcome }
  | { type: 'pair'; ok: boolean; message: string; status: ExtensionStatus }
  | { type: 'panel-state'; state: PanelState }
  | ({ type: 'panel-act' } & PanelActOutcome)
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
  kol_role_held?: boolean
  kol_setup_url?: string
} {
  return {
    workspace_name: hello.workspace_name,
    cloud_linked: hello.cloud_linked,
    shares_to_public_library: hello.shares_to_public_library,
    ...(hello.kol_role_held === undefined ? {} : { kol_role_held: hello.kol_role_held }),
    ...(hello.kol_setup_url === undefined ? {} : { kol_setup_url: hello.kol_setup_url }),
  }
}

/** WP202：面板上那句「你还没有红人营销岗位」。只在本机明说「没有」时出。 */
export const NO_KOL_ROLE_LINE = '你还没有红人营销岗位，收进来的人暂时看不到。'

export function kolRoleNote(status: ExtensionStatus): { text: string; url?: string } | undefined {
  if (!status.paired || !status.online || status.kol_role_held !== false) return undefined
  return {
    text: NO_KOL_ROLE_LINE,
    ...(status.kol_setup_url === undefined ? {} : { url: status.kol_setup_url }),
  }
}
