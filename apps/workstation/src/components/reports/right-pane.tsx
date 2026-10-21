/**
 * WP438（决策 1335 改：报表点开在**右栏（第三栏）**弹出，不盖住中栏）：第三栏的**临时挂载点**。
 *
 * WP437 在做统一的第三栏宿主（浏览器、变更审阅、展开的报表都在里面弹，口子叫
 * `openRightPane({ kind: 'report', id })`）。它合进来之前，报表先挂在这里——**口子同名同形**，
 * 集成时由主会话把 {@link RightPaneHost} 换成 WP437 的宿主、`openRightPane` 转过去即可，调用方一行不改。
 *
 * - 一次只开一格；Esc / 关闭钮收起；
 * - 窗口够宽时和中栏并排、占一栏；不够宽时盖在中栏上（带遮罩，点遮罩收起）。「够宽」看这一页的中栏里有没有看板：
 *   没有看板（首页）≥ 1280 就并排；有看板（岗位 / 职责 / 事项页）要 ≥ 1680，不然中栏会被挤成一条；
 * - 只在内存里（刷新回到关着）。
 */
import {
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useLocation } from 'react-router-dom'
import { ErrorBoundary } from '@/components/error-boundary'
import { railPageKind } from '@/components/rail/rail-layout'
import { useRailState } from '@/components/rail/rail-state'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

export type RightPane =
  | {
      kind: 'report'
      id: string
      /** 岗位模板 id（顶上那排页签：同一个岗位固定的几份）。 */
      position?: string
      /** 职责层打开的：页签只列这条职责上的。 */
      duty?: string
    }
  | {
      kind: 'report-compose'
      position?: string
      duty?: string
      /** 输入框里先带的话（「做一份报表：」）。 */
      prompt?: string
    }

interface PaneState {
  pane: RightPane | null
  /** 刚固定的那一份（看板那一行亮一下）。 */
  pinned: string | null
  nonce: number
}

let state: PaneState = { pane: null, pinned: null, nonce: 0 }
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

/** 开第三栏的一格（和 WP437 的宿主同名同形）。 */
export function openRightPane(pane: RightPane): void {
  publish({ ...state, pane, nonce: state.nonce + 1 })
}

export function closeRightPane(): void {
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

/** 只给测试用。 */
export function resetRightPane(): void {
  state = { pane: null, pinned: null, nonce: 0 }
}

const ReportView = lazy(async () => ({
  default: (await import('@/components/reports/report-view')).ReportView,
}))
const ReportCompose = lazy(async () => ({
  default: (await import('@/components/reports/report-compose')).ReportCompose,
}))

function useMedia(query: string): boolean {
  const [hit, setHit] = useState(false)
  useEffect(() => {
    const mql = globalThis.matchMedia?.(query)
    if (mql === undefined) return
    setHit(mql.matches)
    const on = (e: MediaQueryListEvent): void => {
      setHit(e.matches)
    }
    mql.addEventListener('change', on)
    return () => {
      mql.removeEventListener('change', on)
    }
  }, [query])
  return hit
}

/** 并排的门槛：中栏有看板时要更宽。 */
export const SIDE_BY_SIDE = { plain: 1280, withBoard: 1680 } as const

export function RightPaneHost(): ReactNode {
  const { t } = useApp()
  const { pane } = useRightPane()
  // 换页就收起（第三栏开的是这一页上看的东西）
  const { pathname } = useLocation()
  const rail = useRailState()
  const board = rail.open !== null && railPageKind(pathname) !== undefined
  const wide = useMedia(`(min-width: ${board ? SIDE_BY_SIDE.withBoard : SIDE_BY_SIDE.plain}px)`)
  const last = useRef(pathname)
  useEffect(() => {
    if (last.current === pathname) return
    last.current = pathname
    closeRightPane()
  }, [pathname])
  useEffect(() => {
    if (pane === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const el = e.target as HTMLElement | null
      if (el?.closest?.('[role="dialog"],[role="menu"]') != null) return
      closeRightPane()
    }
    globalThis.addEventListener?.('keydown', onKey)
    return () => {
      globalThis.removeEventListener?.('keydown', onKey)
    }
  }, [pane])
  if (pane === null) return null
  return (
    <>
      {/* 窗口不够宽：盖在中栏上，遮罩点一下收起 */}
      {wide ? null : (
        <button
          type="button"
          aria-label={t('report.pane.close')}
          data-testid="right-pane-scrim"
          className="fixed inset-x-0 top-11 bottom-0 z-40 bg-black/15"
          onClick={closeRightPane}
        />
      )}
      <aside
        className={cn(
          'z-40 flex shrink-0 flex-col border-l border-ws-line bg-ws-paper',
          wide
            ? 'sticky top-11 h-[calc(100vh-2.75rem)] w-[clamp(560px,46vw,900px)]'
            : 'fixed top-11 right-0 bottom-0 w-[min(940px,calc(100vw-3rem))] shadow-[-24px_0_60px_rgba(20,40,30,0.14)]',
        )}
        data-layout={wide ? 'side' : 'over'}
        data-testid="right-pane"
        data-kind={pane.kind}
      >
        <ErrorBoundary
          scope="panel"
          label={`right-pane:${pane.kind}`}
          resetKey={JSON.stringify(pane)}
        >
          <Suspense fallback={null}>
            {pane.kind === 'report' ? (
              <ReportView
                id={pane.id}
                {...(pane.position === undefined ? {} : { position: pane.position })}
                {...(pane.duty === undefined ? {} : { duty: pane.duty })}
              />
            ) : (
              <ReportCompose
                {...(pane.position === undefined ? {} : { position: pane.position })}
                {...(pane.duty === undefined ? {} : { duty: pane.duty })}
                {...(pane.prompt === undefined ? {} : { prompt: pane.prompt })}
              />
            )}
          </Suspense>
        </ErrorBoundary>
      </aside>
    </>
  )
}
