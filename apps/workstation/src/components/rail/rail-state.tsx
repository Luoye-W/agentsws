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
 *
 * WP372（决策 1001 / 1004 / 1005，Luoye 10-17）：右侧面板多一种样子——**五张卡**
 * （`open === RAIL_CARDS`）。每张卡展开 / 收起按桶记（没记过只展开「对话」），
 * 顺序按人记（全部岗位一份）。按资源地址开一个「归卡」的面板（连接卡）= 展开那张卡并滚到那一条。
 *
 * WP412（真机 10-18 #8，决策 1035 更正）：进**岗位 / 职责 / 事项页**时面板**默认打开**（开成卡片；
 * 这个桶上次开的是某一格就开那一格）；人手动开 / 关过（右上角面板开关、面板头 ×、`]`、窄屏遮罩）就**按页面类型记住**——
 * 在一个岗位页关了，进别的岗位页也是关着；职责页、事项页各记各的。窗口窄于 900 时没记过的一律先收着（不挡主区）。
 * 别处自动弹开（连接卡、浏览器要人点、快捷按钮开报表）只开这一次，不改记住的那一份。
 *
 * WP433（Luoye 10-20 问题 5）：上面那条「按页面类型记住开没开」撤掉——岗位 / 职责 / 事项页上面板一直在，没有开关。
 *
 * WP437：第三栏宿主的统一入口 {@link RailState.openRightPane}（`{ kind: 'report', id }` 等）与看板「临时一眼」的开关。
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useLocation } from 'react-router-dom'
import { railLayoutBucket, railPageKind } from '@/components/rail/rail-layout'
import { railCard, resolvePanel, resolvePanelId } from '@/components/rail/registry'
import {
  bindRightPaneHost,
  closeRightPane as closePane,
  currentPane,
  forgetRightPane,
  openRightPane as openPane,
  type RightPane,
  rightPaneRoute,
} from '@/components/rail/right-pane'
import { useApp } from '@/lib/app-context'
import {
  clampRailWidth,
  DEFAULT_RAIL_LAYOUT,
  type RailLayoutEntry,
  type RailPageKind,
  readRailCardFlags,
  readRailCardOrder,
  readRailLayout,
  readRailWide,
  writeRailCardFlags,
  writeRailCardOrder,
  writeRailLayout,
  writeRailWide,
} from '@/lib/ui-state'

/** 面板开成「五张卡」时 `open` 的值（存进布局的也是它）。 */
export const RAIL_CARDS = 'cards'

/** 没记过的桶里默认展开哪几张（决策 1035：对话与计划；WP372 时只有对话）。 */
export const DEFAULT_OPEN_CARDS: readonly string[] = ['conversations', 'plans']

/** 某张卡这会儿展开着吗（显式记过的为准，没记过按默认）。 */
export function cardOpen(flags: Record<string, boolean>, id: string): boolean {
  return flags[id] ?? DEFAULT_OPEN_CARDS.includes(id)
}

export interface RailState {
  /** 现在开着哪个面板；`null` = 收起；{@link RAIL_CARDS} = 五张卡。 */
  open: string | null
  /**
   * WP97：这一次是**为哪个资源**开的（`agentsws://file/src_1/报价单.xlsx`）；
   * `null` = 人点图标开的"页"。
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
   * 回 `false` = **没有面板认领这个地址**（.zip、.pdf……）。调用方那时该去下载。
   * **同一份文件再点一次 = 聚焦已经开着的那个**：状态一个字不改，于是面板不重挂。
   * WP372：认领它的面板归一张卡（连接卡）时，开成五张卡、展开那一张、滚到那一条。
   */
  openAddress(address: string): boolean
  /** 开着就收起、收起就开这一个（`]` 用它）。 */
  toggle(panel: string): void
  /**
   * 改宽度。拖的过程中 `persist` 传假（一帧写一次本机是纯浪费），
   * 松手 / 键盘调完那一下才写。
   */
  setWidth(width: number, persist?: boolean): void
  /** WP372：这个桶里显式记过的卡展开态（判展开用 {@link cardOpen}）。 */
  cards: Record<string, boolean>
  /** WP372：人拖出来的卡顺序（没拖过是空数组 = 按默认）。 */
  order: readonly string[]
  /** WP372：刚被点名的那张卡（右上角图标 / 连接卡弹出）：面板滚到它。只在内存里。 */
  focus: string | null
  /** WP372：点名那张卡时带的意图（`compose` = 对话卡直接开「新对话」那一格）。只在内存里。 */
  intent: string | null
  /**
   * WP372：开成五张卡并展开这一张、滚到它。
   * 给 `pathname` = 马上要跳去那一页（左栏职责行的「+」）：布局直接写进**那一页的桶**，跳过去就是开着的。
   */
  openCard(id: string, options?: { intent?: string; pathname?: string }): void
  /** WP372：展开 / 收起一张卡（按桶记住）。 */
  setCardOpen(id: string, open: boolean): void
  /** WP372：右上角卡图标：面板开着且这张展开着就收起面板，否则开到它。 */
  toggleCard(id: string): void
  /** WP372：拖完 / 键盘挪完的顺序（全部岗位共用一份）。 */
  setOrder(order: readonly string[]): void
  /** WP372：意图用掉了（对话卡开过「新对话」一次就清掉，免得每次展开都弹）。 */
  clearIntent(): void
  /** WP372（决策 1019）：临时加宽后的宽度；`null` = 平常宽度。全部岗位一份，记住。 */
  wide: number | null
  setWide(width: number | null): void
  /**
   * WP437：**第三栏宿主的统一入口**——浏览器、变更审阅、看一份报表、卡里「显示更多」那一格……都从这里开。
   * 同一时间只开一格；开着别的就换成这一格。回 `false` = 没有面板认得它（调用方走自己的兜底）。
   * 与模块级的 `openRightPane`（`right-pane.ts`，WP438 用的那个）是同一个东西。
   */
  openRightPane(pane: RightPane): boolean
  /** WP437：收起第三栏（岗位 / 职责 / 事项页上看板照旧在）。 */
  closeRightPane(): void
  /**
   * WP437：看板被自动隐藏时，顶栏那颗小图标点开的**临时一眼**（看板浮在内容上，点外面收回）。
   * 只在内存里；宽度够了看板回来时自己收。不是「收起面板」的开关。
   */
  peek: boolean
  setPeek(open: boolean): void
}

const Ctx = createContext<RailState | null>(null)

interface BucketState {
  bucket: string
  /** WP412：这一页是哪类干活的页（岗位 / 职责 / 事项）；别的页没有。 */
  kind: RailPageKind | undefined
  layout: RailLayoutEntry
  cards: Record<string, boolean>
}

/**
 * WP433（Luoye 10-20 问题 5：「这不是一个可以收起来的面板」）：岗位 / 职责 / 事项页上右侧面板**一直在**——
 * 没有开 / 关这回事。这个桶上次开的是某一格就开那一格，否则是卡片堆；「收起」（`show(null)`、`]`、
 * 再点一次浏览器图标）在这几页上一律落回卡片堆。WP412 的「按页面类型记住开没开」不再用（那份本机记录不读也不写）。
 * 别的页（首页、知识库……）没有卡片堆，照旧：工具类的一格开了能收。
 */
function withPageDefault(layout: RailLayoutEntry, kind: RailPageKind | undefined): RailLayoutEntry {
  if (kind === undefined || layout.open_panel_id !== null) return layout
  return { ...layout, open_panel_id: RAIL_CARDS }
}

const readBucket = (bucket: string, kind: RailPageKind | undefined): BucketState => ({
  bucket,
  kind,
  layout: withPageDefault(readRailLayout(bucket), kind),
  cards: readRailCardFlags(bucket),
})

const isThird = (id: string | null): id is string => id !== null && id !== RAIL_CARDS

/**
 * WP481（决策 1632）：**换页时第三栏跟着人走**——开着浏览器 / 教程 / 报表时点进另一页（岗位 → 职责、→ 事项……），
 * 那一格照旧开着（宽度也照旧）；收着进另一页也照旧收着，不按那一页上次记的弹出来。
 * 以前按页记（WP95），换页时第三栏一会儿收一会儿开；现在第三栏开着窗口就向右加宽、收起就缩回，
 * 按页记的话换个页窗口就来回弹。刷新（第一次读）照旧按这一页记的来。只在内存里换，不改本机记录。
 */
function carryThird(prev: BucketState, next: BucketState): BucketState {
  const was = isThird(prev.layout.open_panel_id) ? prev.layout.open_panel_id : null
  const now = isThird(next.layout.open_panel_id) ? next.layout.open_panel_id : null
  if (was === now) return next
  const layout: RailLayoutEntry =
    was === null
      ? withPageDefault({ ...next.layout, open_panel_id: null }, next.kind)
      : { ...next.layout, open_panel_id: was, width: prev.layout.width }
  return { ...next, layout }
}

export function RailStateProvider({ children }: { children: ReactNode }): ReactNode {
  const location = useLocation()
  const { position } = useApp()
  const bucket = railLayoutBucket(location.pathname, position)
  const kind = railPageKind(location.pathname)

  // 换桶 = 换一份布局。用 render 期比较而不是 `useEffect`：effect 那一版
  // 会先拿旧桶的值画一帧，人眼看得见第三栏"闪"一下别的岗位的面板。
  // WP412：同一个桶换了页面类型（首页 → 那个岗位页）也重读一次——进干活的页要按「默认打开」算。
  const [state, setState] = useState<BucketState>(() => readBucket(bucket, kind))
  const current =
    state.bucket === bucket && state.kind === kind
      ? state
      : carryThird(state, readBucket(bucket, kind))
  if (current !== state) setState(current)
  const layout = current.layout

  // WP97：为哪个资源开的。与布局分开存，因为它**不进本机**（见 `RailState.address`）。
  const [address, setAddress] = useState<string | null>(null)
  const [order, setOrderState] = useState<readonly string[]>(() => readRailCardOrder())
  const [focus, setFocus] = useState<string | null>(null)
  const [intent, setIntent] = useState<string | null>(null)
  const [wide, setWideState] = useState<number | null>(() => readRailWide())
  /** WP437：看板自动隐藏时的「临时一眼」（只在内存里；换页就收）。 */
  const [peek, setPeek] = useState(false)
  const [peekPath, setPeekPath] = useState(location.pathname)
  if (peekPath !== location.pathname) {
    setPeekPath(location.pathname)
    if (peek) setPeek(false)
  }
  const setWide = useCallback((next: number | null) => {
    writeRailWide(next)
    setWideState(next)
  }, [])

  const setOpen = useCallback((panel: string | null) => {
    setState((prev) => {
      // WP433：岗位 / 职责 / 事项页上面板收不起来——「收起」就是回到卡片堆
      const next = withPageDefault({ ...prev.layout, open_panel_id: panel }, prev.kind)
      writeRailLayout(prev.bucket, next)
      return { ...prev, layout: next }
    })
  }, [])

  /** 开一格 / 收起（岗位 / 职责 / 事项页上「收起」= 回到卡片堆，见 {@link withPageDefault}）。 */
  const show = useCallback(
    (panel: string | null) => {
      setAddress(null)
      setFocus(null)
      setOpen(panel)
    },
    [setOpen],
  )

  const toggle = useCallback((panel: string) => {
    setAddress(null)
    setFocus(null)
    setState((prev) => {
      const next = withPageDefault(
        {
          ...prev.layout,
          open_panel_id: prev.layout.open_panel_id === panel ? null : panel,
        },
        prev.kind,
      )
      writeRailLayout(prev.bucket, next)
      return { ...prev, layout: next }
    })
  }, [])

  const expandIn = useCallback((prev: BucketState, id: string): BucketState => {
    const cards = { ...prev.cards, [id]: true }
    const next = { ...prev.layout, open_panel_id: RAIL_CARDS }
    writeRailCardFlags(prev.bucket, cards)
    writeRailLayout(prev.bucket, next)
    return { ...prev, layout: next, cards }
  }, [])

  const openCard = useCallback(
    (id: string, options: { intent?: string; pathname?: string } = {}) => {
      // WP456-T3（决策 1448）：合进清单卡的那几张没有「展开」——点名它 = 在第三栏开它的完整一格
      const listed = railCard(id)
      if (listed?.list === true && listed.panel !== undefined && options.pathname === undefined) {
        setAddress(null)
        setFocus(null)
        setIntent(options.intent ?? null)
        setOpen(listed.panel)
        return
      }
      setAddress(null)
      setFocus(id)
      setIntent(options.intent ?? null)
      const target =
        options.pathname === undefined ? undefined : railLayoutBucket(options.pathname, position)
      if (target !== undefined && target !== bucket) {
        // 马上要换页：写进那一页的桶，换过去时 render 期那一下读到的就是开着的
        expandIn(readBucket(target, railPageKind(options.pathname ?? '')), id)
        return
      }
      setState((prev) => expandIn(prev, id))
    },
    [bucket, position, expandIn, setOpen],
  )

  const setCardOpen = useCallback((id: string, open: boolean) => {
    setState((prev) => {
      const cards = { ...prev.cards, [id]: open }
      writeRailCardFlags(prev.bucket, cards)
      return { ...prev, cards }
    })
  }, [])

  const toggleCard = useCallback(
    (id: string) => {
      if (layout.open_panel_id === RAIL_CARDS && cardOpen(current.cards, id)) {
        // WP433：面板收不起来了——在卡片堆上再点一次 = 收起这张卡
        if (current.kind !== undefined) setCardOpen(id, false)
        else show(null)
        return
      }
      openCard(id)
    },
    [layout.open_panel_id, current.cards, current.kind, show, openCard, setCardOpen],
  )

  const setOrder = useCallback((next: readonly string[]) => {
    writeRailCardOrder(next)
    setOrderState(next)
  }, [])

  const clearIntent = useCallback(() => {
    setIntent(null)
  }, [])

  const openAddress = useCallback(
    (next_address: string): boolean => {
      const panel = resolvePanel({ address: next_address })
      if (panel === undefined) return false
      // WP372：归卡的面板（连接卡）= 展开那张卡、滚到那一条（同一份再点一次也只是再滚一次）
      // WP456-T3（决策 1448）：那张卡合进了清单卡 = 在第三栏开它的完整一格，带着这份地址（连接卡在那一格顶上就地连）
      const listed = panel.card === undefined ? undefined : railCard(panel.card)
      if (listed?.list === true && listed.panel !== undefined) {
        const target = listed.panel
        if (layout.open_panel_id === target && address === next_address) return true
        setAddress(next_address)
        setFocus(null)
        setIntent(null)
        setOpen(target)
        return true
      }
      if (panel.card !== undefined) {
        const card = panel.card
        setAddress(next_address)
        setFocus(card)
        setIntent(null)
        setState((prev) => expandIn(prev, card))
        return true
      }
      // 已经开着同一份 = 聚焦：**一个 setState 都不发**，于是面板不重挂
      if (layout.open_panel_id === panel.id && address === next_address) return true
      setAddress(next_address)
      setFocus(null)
      setOpen(panel.id)
      return true
    },
    [address, layout.open_panel_id, expandIn, setOpen],
  )

  const setWidth = useCallback((width: number, persist = true) => {
    setState((prev) => {
      const next = { ...prev.layout, width: clampRailWidth(width) }
      if (persist) writeRailLayout(prev.bucket, next)
      return { ...prev, layout: next }
    })
  }, [])

  /*
   * WP437：把外壳的第三栏接到模块级的 `openRightPane` / `closeRightPane` 上（`right-pane.ts`，WP438 的报表从那里开）。
   * 第三栏换成别的格子 / 被收起时，那一次带的参数（报表 id……）跟着清掉。
   */
  useEffect(
    () =>
      bindRightPaneHost({
        open: (route) => {
          if ('address' in route) return openAddress(route.address)
          show(route.panel)
          return true
        },
        close: () => {
          show(null)
        },
      }),
    [openAddress, show],
  )
  const openPanel = layout.open_panel_id
  useEffect(() => {
    const { pane } = currentPane()
    if (pane === null) return
    const route = rightPaneRoute(pane)
    const want = 'panel' in route ? route.panel : resolvePanel({ address: route.address })?.id
    const now = openPanel === null || openPanel === RAIL_CARDS ? undefined : openPanel
    if (
      now === undefined ||
      (want !== undefined && resolvePanelId(now).id !== resolvePanelId(want).id)
    )
      forgetRightPane()
  }, [openPanel])

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
      cards: current.cards,
      order,
      focus,
      intent,
      openCard,
      setCardOpen,
      toggleCard,
      setOrder,
      clearIntent,
      wide,
      setWide,
      openRightPane: openPane,
      closeRightPane: closePane,
      peek,
      setPeek,
    }),
    [
      layout.open_panel_id,
      address,
      layout.width,
      bucket,
      show,
      toggle,
      openAddress,
      setWidth,
      current.cards,
      order,
      focus,
      intent,
      openCard,
      setCardOpen,
      toggleCard,
      setOrder,
      clearIntent,
      wide,
      setWide,
      peek,
    ],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

const noop = (): void => {}

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
      show: noop,
      toggle: noop,
      // 没有 Provider 时"开不出来"是实话：回假，调用方于是走它的兜底（下载）
      openAddress: () => false,
      setWidth: noop,
      cards: {},
      order: [],
      focus: null,
      intent: null,
      openCard: noop,
      setCardOpen: noop,
      toggleCard: noop,
      setOrder: noop,
      clearIntent: noop,
      wide: null,
      setWide: noop,
      openRightPane: () => false,
      closeRightPane: noop,
      peek: false,
      setPeek: noop,
    }
  )
}
