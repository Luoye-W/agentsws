/**
 * WP71（36 §9）：第三栏"现在开着哪个面板"这一个状态，一份真源。
 *
 * 为什么要一个 context 而不是让 `RightRail` 自己拿着：职责页头部那四个按钮
 * （记忆 / 技能 / 知识 / 额度）要能把右栏打开到那一格，而它们在主区里、
 * 不是右栏的子组件。别的办法（写进本机再刷新整页）能跑，但代价是
 * 点一个按钮闪一次白屏——为省一个 context 赔上这个不划算。
 *
 * 开合态**同时**写进本机那一份（`lib/ui-state.ts` 的 `agentsws.rightrail.panel`），所以刷新之后
 * 右栏还开在原处；读也从那里读，`RightRail` 与这里不会各存一份。
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react'
import { RIGHT_RAIL_PANEL_KEY, readString, writeString } from '@/lib/ui-state'

export interface RailState {
  /** 现在开着哪个面板；`null` = 收起成图标轨。 */
  open: string | null
  /** 开一个面板（传 `null` 收起）。 */
  show(panel: string | null): void
  /** 开着就收起、收起就开这一个（`]` 与图标轨点击都用它）。 */
  toggle(panel: string): void
}

const Ctx = createContext<RailState | null>(null)

export function RailStateProvider({ children }: { children: ReactNode }): ReactNode {
  const [open, setOpen] = useState<string | null>(() => {
    const stored = readString(RIGHT_RAIL_PANEL_KEY)
    return stored === null || stored === '' ? null : stored
  })

  const show = useCallback((panel: string | null) => {
    setOpen(panel)
    writeString(RIGHT_RAIL_PANEL_KEY, panel ?? '')
  }, [])

  const toggle = useCallback((panel: string) => {
    setOpen((prev) => {
      const next = prev === panel ? null : panel
      writeString(RIGHT_RAIL_PANEL_KEY, next ?? '')
      return next
    })
  }, [])

  const value = useMemo<RailState>(() => ({ open, show, toggle }), [open, show, toggle])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/**
 * 没有 Provider 时回一个**什么都不做**的实现，而不是抛。
 *
 * 单测里常常只渲染一个页面组件（没有 `AppShell`），那时"把右栏打开"这件事
 * 本来就无处可去；让它静静地什么都不做，比让被测组件因为缺一层 Provider 而炸掉好。
 */
export function useRailState(): RailState {
  const ctx = useContext(Ctx)
  return (
    ctx ?? {
      open: null,
      show: () => {},
      toggle: () => {},
    }
  )
}
