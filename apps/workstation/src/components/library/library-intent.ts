/**
 * WP504（决策 1778 A / 1761 A）：**开一个库面板到某一格、叠开某一条**——通用口子。
 *
 * 旧地址跳过来（`/influencer/creators?creator=…`、`/knowledge`）、中栏卡里点红人名、`agentsws://creator/<id>`……
 * 都走这里：记下「开到哪一格、叠开哪一条、带什么筛选」，再按面板 id 开第三栏那一格；面板身体挂上后读一次、用掉。
 * 只在内存里（同 `creator-pane.ts` / 收件箱那一格的做法）。
 */
import { useSyncExternalStore } from 'react'
import { openRightPane } from '@/components/rail/right-pane'

export interface LibraryIntent {
  /** 开到哪一格（`creators` / `campaign` / `collab`；知识库 `both` / `presales` / `postsales`）。 */
  tab?: string
  /** 叠开哪一条（红人 id、知识条目 id）。 */
  item?: string
  /** 别的参数原样带过去（`batch`、`channel`、`creator`（handle 或 id）……），面板自己认。 */
  params?: Readonly<Record<string, string>>
  /** 每开一次 +1（同一条再开一次也要叠开）。 */
  nonce: number
}

let intents: Readonly<Record<string, LibraryIntent>> = {}
let seq = 0
const listeners = new Set<() => void>()
const publish = (next: Readonly<Record<string, LibraryIntent>>): void => {
  intents = next
  for (const l of listeners) l()
}
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** 记下这一次要开到哪（不开面板；测试 / 面板已经开着时用）。 */
export function setLibraryIntent(panel: string, intent: Omit<LibraryIntent, 'nonce'>): void {
  seq += 1
  publish({ ...intents, [panel]: { ...intent, nonce: seq } })
}

/**
 * 开这个库面板（第三栏那一格），并带上要开到哪 / 叠开哪一条。
 * 回 `false` = 没有外壳的第三栏（单独渲染的页面、单测）。
 */
export function openLibrary(panel: string, intent: Omit<LibraryIntent, 'nonce'> = {}): boolean {
  setLibraryIntent(panel, intent)
  return openRightPane({ kind: 'panel', id: panel })
}

/** 这个面板现在要开到哪（没有 = `undefined`）。面板用完调 {@link consumeLibraryIntent}。 */
export function useLibraryIntent(panel: string): LibraryIntent | undefined {
  return useSyncExternalStore(
    subscribe,
    () => intents[panel],
    () => intents[panel],
  )
}

/** 用掉了（同一个 nonce 只用一次；新的一次来了不受影响）。 */
export function consumeLibraryIntent(panel: string, nonce: number): void {
  if (intents[panel]?.nonce !== nonce) return
  const { [panel]: _gone, ...rest } = intents
  publish(rest)
}

/** 只给测试用。 */
export function resetLibraryIntents(): void {
  intents = {}
}

/**
 * 地址栏上的 `?panel=` 那一组（旧整页路由跳过来带的）：`panel` 之外的 `tab` / `item` 单独认，其余原样当参数。
 * 纯函数。没有 `panel` 回 `undefined`。
 */
export function intentFromSearch(
  search: URLSearchParams,
): { panel: string; intent: Omit<LibraryIntent, 'nonce'> } | undefined {
  const panel = search.get('panel')
  if (panel === null || panel === '') return undefined
  const params: Record<string, string> = {}
  for (const [k, v] of search.entries())
    if (k !== 'panel' && k !== 'tab' && k !== 'item') params[k] = v
  const tab = search.get('tab')
  const item = search.get('item')
  return {
    panel,
    intent: {
      ...(tab === null || tab === '' ? {} : { tab }),
      ...(item === null || item === '' ? {} : { item }),
      ...(Object.keys(params).length === 0 ? {} : { params }),
    },
  }
}

/** 地址栏里属于 `?panel=` 那一组的键（认完从地址栏收掉）。 */
export const LIBRARY_SEARCH_KEYS = ['panel', 'tab', 'item', 'creator', 'batch', 'channel'] as const
