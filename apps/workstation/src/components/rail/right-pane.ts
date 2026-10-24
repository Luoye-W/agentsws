/**
 * WP437（Luoye 10-21）：**第三栏宿主的统一口子**——浏览器、变更审阅、看一份报表、卡里「显示更多」那一格……都从这里开。
 *
 * 形状和 WP438 的临时挂载点（`components/reports/right-pane.tsx`）**同名同形**：
 * `openRightPane(pane)` / `closeRightPane()` / `markPinned(id)` / `useRightPane()` → `{ pane, pinned, nonce }`。
 * 集成时 WP438 那个文件改成从这里转出去即可，调用方一行不改。
 *
 * 和临时挂载点的区别：这里**不自己画一栏**——开什么由外壳里的第三栏宿主（`right-rail.tsx` 的 `RailHost`）画，
 * 同一时间一格、头上 × 收、拖宽记住、窄了盖在中栏上，跟浏览器 / 变更审阅是同一个宿主。
 * 外壳挂上时用 {@link bindRightPaneHost} 把「开哪一格 / 收起」接过去；没有外壳（单测、单独渲染的页面）时开不出来，回 `false`。
 *
 * 只在内存里（刷新回到关着）；`pane` 是这一次开的那一格要的参数（报表 id、哪个岗位 / 职责、带进输入框的话），
 * 面板身体按它取数。人用 × / `]` / 换成别的格子收起时，`pane` 跟着清掉。
 */
import { useSyncExternalStore } from 'react'

export type RightPane =
  | {
      kind: 'report'
      id: string
      /** 岗位模板 id（报表顶上那排页签：同一个岗位固定的几份）。 */
      position?: string
      /** 职责层打开的：页签只列这条职责上的。 */
      duty?: string
    }
  | {
      /** WP438：跟 AI 说想看什么 → 做一份报表。 */
      kind: 'report-compose'
      position?: string
      duty?: string
      /** 输入框里先带的话（「做一份报表：」）。 */
      prompt?: string
    }
  | { kind: 'browser' }
  | { kind: 'changes' }
  /** 任何注册过的面板（`id` 可以是旧别名，如 `memory` → 「设定」的「记忆」）。 */
  | { kind: 'panel'; id: string }
  /** 按资源地址开（`agentsws://file/…`），谁认领谁来开（归卡的连接项照旧展开那张卡）。 */
  | { kind: 'address'; address: string }

/** 报表的资源地址前缀（与 `components/reports/report-data.ts` 的 `REPORT_ADDRESS_PREFIX` 同一个）。 */
export const REPORT_PANE_PREFIX = 'agentsws://report/'

/** 报表那两格的面板 id。 */
export const REPORT_PANELS: readonly string[] = ['report', 'report-compose']

/** 报表那两格最窄多宽（两列小块 + 大趋势图放得下；人拖得更宽照旧记住）。 */
export const REPORT_PANE_MIN_WIDTH = 560

/** 一个目标落到哪儿——开一格（面板 id）还是按地址开。纯函数。 */
export function rightPaneRoute(pane: RightPane): { panel: string } | { address: string } {
  switch (pane.kind) {
    case 'report':
      return { address: `${REPORT_PANE_PREFIX}${pane.id}` }
    case 'report-compose':
      return { panel: 'report-compose' }
    case 'browser':
      return { panel: 'browser' }
    case 'changes':
      return { panel: 'changes' }
    case 'panel':
      return { panel: pane.id }
    case 'address':
      return { address: pane.address }
  }
}

/**
 * 第三栏这一格要多宽：报表那两格至少 {@link REPORT_PANE_MIN_WIDTH}；WP504 起面板自己声明的 `minWidth`
 * （库面板）也算；别的照拖出来的宽度。
 */
export function paneWidth(panel: string | undefined, width: number, minWidth?: number): number {
  const floor =
    panel !== undefined && REPORT_PANELS.includes(panel) ? REPORT_PANE_MIN_WIDTH : (minWidth ?? 0)
  return Math.max(width, floor)
}

export interface PaneState {
  pane: RightPane | null
  /** 刚固定的那一份（看板那一行亮一下）。 */
  pinned: string | null
  nonce: number
}

export interface RightPaneHost {
  /** 开这一格；回 `false` = 没有面板认得它。 */
  open(route: { panel: string } | { address: string }): boolean
  close(): void
}

let state: PaneState = { pane: null, pinned: null, nonce: 0 }
let host: RightPaneHost | undefined
const listeners = new Set<() => void>()
const publish = (next: PaneState): void => {
  state = next
  for (const l of listeners) l()
}
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** 外壳的第三栏宿主挂上来（回一个解绑）。 */
export function bindRightPaneHost(next: RightPaneHost): () => void {
  host = next
  return () => {
    if (host === next) host = undefined
  }
}

/** 开第三栏的一格（同一时间一格，开着别的就换掉）。回 `false` = 没有宿主或没有面板认得它。 */
export function openRightPane(pane: RightPane): boolean {
  if (host === undefined) return false
  const opened = host.open(rightPaneRoute(pane))
  if (opened) publish({ ...state, pane, nonce: state.nonce + 1 })
  return opened
}

/** 收起第三栏。 */
export function closeRightPane(): void {
  if (state.pane !== null) publish({ ...state, pane: null })
  host?.close()
}

/** 宿主自己收起 / 换成别的格子时清掉参数（不再回调宿主）。 */
export function forgetRightPane(): void {
  if (state.pane !== null) publish({ ...state, pane: null })
}

/** 记下刚固定的那一份（看板那一行亮一下）。 */
export function markPinned(id: string | null): void {
  publish({ ...state, pinned: id })
}

export function useRightPane(): PaneState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
}

/** 现在这一份（不订阅）。 */
export function currentPane(): PaneState {
  return state
}

/** 只给测试用。 */
export function resetRightPane(): void {
  state = { pane: null, pinned: null, nonce: 0 }
}
