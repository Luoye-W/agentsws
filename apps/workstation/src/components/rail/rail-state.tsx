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
import { resolvePanel } from '@/components/rail/registry'
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
  /**
   * WP97：这一次是**为哪个资源**开的（`agentsws://file/src_1/报价单.xlsx`）；
   * `null` = 人点图标轨开的"页"。
   *
   * **只活在内存里**，不进本机那一份布局：40 §1.2 与 #5 说的"只存结构"里，
   * 结构指的是"开哪个面板、多宽"。刷新之后这一格回到空是**有意的**——
   * 上一次看的是哪份文件不该留在这台电脑上。
   */
  address: string | null
  /** 面板宽度（px，320–520）。 */
  width: number
  /** 这一份布局记在哪个桶里（岗位 / 事项 / 职责）。 */
  bucket: string
  /** 开一个面板（传 `null` 收起）。资源地址跟着清空——换面板 = 换一件事。 */
  show(panel: string | null): void
  /**
   * WP97：**为一个资源地址开面板**——`resolvePanel()` 的第一个真入口（#3）。
   *
   * 知识库里点一份文件走的就是这一句。排序由注册表说了算（`priority` 三档 →
   * pattern 长度 → 注册顺序，`canOpen()` 一票否决），这里不判"这是不是 Office 文件"：
   * 判了就等于把注册表那套排序在调用点抄了第二遍，而第二遍永远会先走歪。
   *
   * 回 `false` = **没有面板认领这个地址**（.zip、.pdf……）。调用方那时该去下载，
   * 不该"打开一个空面板然后说不支持"。
   *
   * **同一份文件再点一次 = 聚焦已经开着的那个**：状态一个字不改，于是面板不重挂、
   * 滚动位置与正在看的那一页都留着（#16 借的那条细节）。
   */
  openAddress(address: string): boolean
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

  // WP97：为哪个资源开的。与布局分开存，因为它**不进本机**（见 `RailState.address`）。
  const [address, setAddress] = useState<string | null>(null)

  const show = useCallback((panel: string | null) => {
    setAddress(null)
    setState((prev) => {
      const next = { ...prev.layout, open_panel_id: panel }
      writeRailLayout(prev.bucket, next)
      return { bucket: prev.bucket, layout: next }
    })
  }, [])

  const toggle = useCallback((panel: string) => {
    setAddress(null)
    setState((prev) => {
      const next = {
        ...prev.layout,
        open_panel_id: prev.layout.open_panel_id === panel ? null : panel,
      }
      writeRailLayout(prev.bucket, next)
      return { bucket: prev.bucket, layout: next }
    })
  }, [])

  const openAddress = useCallback(
    (next_address: string): boolean => {
      const panel = resolvePanel({ address: next_address })
      if (panel === undefined) return false
      // 已经开着同一份 = 聚焦：**一个 setState 都不发**，于是面板不重挂
      if (layout.open_panel_id === panel.id && address === next_address) return true
      setAddress(next_address)
      setState((prev) => {
        const next = { ...prev.layout, open_panel_id: panel.id }
        writeRailLayout(prev.bucket, next)
        return { bucket: prev.bucket, layout: next }
      })
      return true
    },
    [address, layout.open_panel_id],
  )

  const setWidth = useCallback((width: number, persist = true) => {
    setState((prev) => {
      const next = { ...prev.layout, width: clampRailWidth(width) }
      if (persist) writeRailLayout(prev.bucket, next)
      return { bucket: prev.bucket, layout: next }
    })
  }, [])

  const value = useMemo<RailState>(
    () => ({
      open: layout.open_panel_id,
      address,
      width: layout.width,
      bucket,
      show,
      toggle,
      openAddress,
      setWidth,
    }),
    [layout.open_panel_id, address, layout.width, bucket, show, toggle, openAddress, setWidth],
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
      address: null,
      width: DEFAULT_RAIL_LAYOUT.width,
      bucket: 'default',
      show: () => {},
      toggle: () => {},
      // 没有 Provider 时"开不出来"是实话：回假，调用方于是走它的兜底（下载）
      openAddress: () => false,
      setWidth: () => {},
    }
  )
}
