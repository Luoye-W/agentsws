/**
 * WP71（36 §9）：第三栏"现在开着哪个面板"这一个状态，一份真源。
 * WP95（36 §11）：这一份**按作用域分桶**，而且只存结构。
 *
 * 为什么要一个 context 而不是让 `RightRail` 自己拿着：职责页头部那四个按钮
 * （记忆 / 技能 / 知识 / 额度）要能把右栏打开到那一格，而它们在主区里、
 * 不是右栏的子组件。别的办法（写进本机再刷新整页）能跑，但代价是
 * 点一个按钮闪一次白屏——为省一个 context 赔上这个不划算。
 *
 * **分桶**（`rail-layout.ts` 的 `railLayoutBucket`）：布局跟着岗位 / 事项 / 职责走，
 * 从岗位 A 切到 B 再切回来，A 那边还开在原处（`sidebar-compare` #8 的语义，
 * 官方绑 session，我们绑岗位）。地址一换这里就换桶重读——"换桶"在界面上
 * 就是换一份 `{ open_panel_id, width }`，没有第二种状态。
 *
 * **只存结构**（#5）：写进本机的永远只有面板 id 与宽度。面板里的内容由面板
 * 自己按作用域重新取，一个字都不落到这台电脑上。
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { railLayoutBucket } from '@/components/rail/rail-layout'
import { useApp } from '@/lib/app-context'
import {
  clampRailWidth,
  DEFAULT_RAIL_LAYOUT,
  type RailLayoutEntry,
  readRailLayout,
  writeRailLayout,
} from '@/lib/ui-state'

export interface RailState {
  /** 现在开着哪个面板；`null` = 收起成图标轨。 */
  open: string | null
  /** 面板宽度（px，320–520）。 */
  width: number
  /** 这一份布局记在哪个桶里（岗位 / 事项 / 职责）。 */
  bucket: string
  /** 开一个面板（传 `null` 收起）。 */
  show(panel: string | null): void
  /** 开着就收起、收起就开这一个（`]` 与图标轨点击都用它）。 */
  toggle(panel: string): void
  /**
   * 改宽度。拖的过程中 `persist` 传假（一帧写一次本机是纯浪费），
   * 松手 / 键盘调完那一下才写。
   */
  setWidth(width: number, persist?: boolean): void
}

const Ctx = createContext<RailState | null>(null)

export function RailStateProvider({ children }: { children: ReactNode }): ReactNode {
  const location = useLocation()
  const { position } = useApp()
  const bucket = railLayoutBucket(location.pathname, position)

  // 换桶 = 换一份布局。用 render 期比较而不是 `useEffect`：effect 那一版
  // 会先拿旧桶的值画一帧，人眼看得见第三栏"闪"一下别的岗位的面板。
  const [state, setState] = useState<{ bucket: string; layout: RailLayoutEntry }>(() => ({
    bucket,
    layout: readRailLayout(bucket),
  }))
  const current = state.bucket === bucket ? state : { bucket, layout: readRailLayout(bucket) }
  if (current !== state) setState(current)
  const layout = current.layout

  const show = useCallback((panel: string | null) => {
    setState((prev) => {
      const next = { ...prev.layout, open_panel_id: panel }
      writeRailLayout(prev.bucket, next)
      return { bucket: prev.bucket, layout: next }
    })
  }, [])

  const toggle = useCallback((panel: string) => {
    setState((prev) => {
      const next = {
        ...prev.layout,
        open_panel_id: prev.layout.open_panel_id === panel ? null : panel,
      }
      writeRailLayout(prev.bucket, next)
      return { bucket: prev.bucket, layout: next }
    })
  }, [])

  const setWidth = useCallback((width: number, persist = true) => {
    setState((prev) => {
      const next = { ...prev.layout, width: clampRailWidth(width) }
      if (persist) writeRailLayout(prev.bucket, next)
      return { bucket: prev.bucket, layout: next }
    })
  }, [])

  const value = useMemo<RailState>(
    () => ({ open: layout.open_panel_id, width: layout.width, bucket, show, toggle, setWidth }),
    [layout.open_panel_id, layout.width, bucket, show, toggle, setWidth],
  )
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
      width: DEFAULT_RAIL_LAYOUT.width,
      bucket: 'default',
      show: () => {},
      toggle: () => {},
      setWidth: () => {},
    }
  )
}
