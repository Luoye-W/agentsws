/**
 * WP71（36 §9）：**第三栏 = 跟着"当前岗位 + 当前这件事"走的工具抽屉**。
 * WP95（36 §11 C 档）：面板改成注册表出的（`registry.ts`），布局按作用域分桶、只存结构，身体 `lazy()`。
 *
 * WP372（决策 1001 / 1004 / 1005 / 1019，Luoye 10-17，学 Claude 桌面版）：
 *
 * - 原来最右那一竖条 44px 图标轨**改成窗口右上角一排**（{@link RailTopBar}，在外壳的顶栏里）：
 *   六张卡各一个图标（点了打开面板并展开那张卡，卡的状态点同步亮在图标上）；最右一个「⋮」菜单——
 *   全部卡片、浏览器、变更审阅、教程。窄窗（< 900）六个图标也收进「⋮」。
 * - 右侧面板（{@link RailHost}）两种样子：**六张卡**（`RAIL_CARDS`，`rail-cards.tsx`）与**一格**
 *   （「显示更多」的完整列表、浏览器、教程、看一份报表……，面板头左边「←」回到卡片）。
 * - 宽屏挤在主区右边；**< 1200 盖在主区上**（不挤压），点遮罩收起。面板可临时加宽（决策 1019，宽度记住）。
 * - `]` 开 / 关（输入框里按不算）；面板内容永远按当前岗位 / 职责取（`rail-scope.ts`）。
 *
 * WP375（决策 1035）：右上角不再放六张卡的图标（卡片入口只在面板里），只放面板里没有的工具。
 * WP412（决策 1035 更正）：最右是专门的**面板开关**（侧栏图标，红 / 黄点汇总挂在它上面）；「⋮」回到溢出菜单，
 * 只收不常用的工具（教程、记忆、第三方面板；窄于 900 时露出来的工具也收进来）。
 *
 * WP431（Luoye 10-19，照 Claude 桌面版顶栏右边那一排）：从左到右——**面板开关**（开着时一块浅底；只有岗位 / 职责 /
 * 事项页才有，别的页没有右侧面板）→ 一条很浅的细竖线 → 露出的工具（浏览器、变更审阅）→ 外壳给的插槽（WP429 的通知铃铛、
 * 这一页的「岗位设置 / 职责设置」）→「⋮」。面板本身没有标题条、关闭叉与放大钮，开关只在顶栏。
 *
 * WP433（Luoye 10-20 问题 5 / 6）：右侧面板在岗位 / 职责 / 事项页上**一直在**，不是能收起来的抽屉——顶栏那颗面板开关
 * （和挂在它上面的汇总点、后面那条细竖线）去掉；各卡自己的红 / 黄点照旧亮在卡的标题行上。面板顶上的「岗位层 / 职责层」
 * 切换也去掉：岗位页看岗位层，职责页看职责层。
 *
 * WP433（Luoye 10-21 澄清）：那一列卡**属于中栏**（常驻、不能收、不像侧栏；窗口太窄时自动隐藏）；真正的**第三栏**是
 * 点了才弹出、能开能关的那一格（浏览器、变更审阅、「显示更多」、看一份报表），出现在卡片列的再右边。
 *
 * {@link RightRail} 两样一起画（老测试与只渲染右栏的地方用）；外壳把两样分开摆。
 */
import {
  BookOpen,
  Brain,
  Gauge,
  IdCard,
  LayoutDashboard,
  type LucideIcon,
  MoreVertical,
  Wrench,
} from 'lucide-react'
import { type ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { CountBadge } from '@/components/design/kit'
import { ErrorBoundary } from '@/components/error-boundary'
import { intentFromSearch, setLibraryIntent } from '@/components/library/library-intent'
import { type ColumnsLayout, columnsLayout, useShellSize } from '@/components/rail/board-fit'
import { ensureBuiltinPanels } from '@/components/rail/builtin-panels'
import { ComputerUseStrip } from '@/components/rail/computer-use-strip'
import { useOverlayOutsideClick } from '@/components/rail/overlay-dismiss'
import { useOpenBrowserOnHandover } from '@/components/rail/panels/search-handover'
import { RailCards } from '@/components/rail/rail-cards'
import { railPageKind } from '@/components/rail/rail-layout'
import { RailPanel } from '@/components/rail/rail-panel'
import { type RailScope, type RailTier, railContextOf } from '@/components/rail/rail-scope'
import { RAIL_CARDS, useRailState } from '@/components/rail/rail-state'
import {
  menuPanels,
  type PanelTypeDefinition,
  panelBody,
  panelType,
  pinnedItems,
  type RailPanelBodyProps,
  resolvePanelId,
} from '@/components/rail/registry'
import { paneWidth } from '@/components/rail/right-pane'
import { TOPBAR_ICON, TOPBAR_ICON_ACTIVE, TOPBAR_ICON_IDLE } from '@/components/shell/top-bar-slots'
import type { PositionInstanceData } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { type SidePaneMode, useSidePaneMode, useSidePaneSync } from '@/lib/side-pane-window'
import { clampRailWidth } from '@/lib/ui-state'
import { cn } from '@/lib/utils'

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

/**
 * 第三栏（浏览器、变更审阅、「显示更多」那一格……）：窗口窄于 900（接近手机宽）才盖在主区上、点遮罩收起；
 * 900 以上并排占一栏。窄一些的窗口靠 `maxWidth` 让它让位。
 */
const NARROW = '(max-width: 899px)'
/**
 * WP412（Luoye 10-19）：「⋮」里先列「设定」卡的几个标签——岗位定义（职责页叫职责定义）、技能、知识、记忆、额度，
 * 顺序照 Luoye 给的；`id` 就是 `registerPanelAlias` 的那几个 sub。
 */
const SETTINGS_SHORTCUTS: readonly { id: string; icon: LucideIcon }[] = [
  { id: 'role', icon: IdCard },
  { id: 'skills', icon: Wrench },
  { id: 'knowledge', icon: BookOpen },
  { id: 'memory', icon: Brain },
  { id: 'caps', icon: Gauge },
]

/** WP412：窗口窄于 900 时，露在右上角的工具也收进「⋮」。 */
const COMPACT = '(max-width: 899px)'

/**
 * 这一页看哪一层（顶栏图标与面板都要）。
 *
 * WP433（Luoye 10-20 问题 6）：**不能切**——岗位页就是岗位层，职责页就是职责层（事项页照旧看岗位层）。
 * 原来面板顶上那个「岗位层 / 职责层」分段切换去掉；职责页要回岗位，走左栏岗位行或顶栏标题里的岗位名。
 */
function useRailContext(instances: PositionInstanceData[] | undefined): {
  scope?: RailScope
  tier: RailTier
  pathname: string
} {
  const { lang, position } = useApp()
  const { pathname } = useLocation()
  const context = railContextOf(pathname, instances, position, lang)
  const tier: RailTier =
    context.preferred === 'role' && context.role !== undefined ? 'role' : 'position'
  const scope = tier === 'role' ? context.role : context.position
  return {
    ...(scope === undefined ? {} : { scope }),
    tier,
    pathname,
  }
}

/**
 * WP437：这一页三栏怎么摆（看板放不放得下、第三栏并排还是盖上去）——顶栏（看板「临时一眼」那颗图标）和
 * 宿主（看板、第三栏）各自算，用的是同一份宽度与同一个函数（`board-fit.ts`）。
 *
 * WP481（决策 1632）：第三栏不挤中栏——窗口为它向右加宽了（桌面壳回 `widened`）才并排，不然一律盖上去；
 * 刚开、等壳回话那一下（`pending`）先不画，免得先挤一下中栏再弹开。
 */
function useColumns(): ColumnsLayout & {
  workPage: boolean
  /** 第三栏要多宽（收着 = `null`），宿主拿它去跟壳说。 */
  want: number | null
  mode: SidePaneMode
} {
  const rail = useRailState()
  const size = useShellSize()
  const narrow = useMedia(NARROW)
  const mode = useSidePaneMode()
  const { pathname } = useLocation()
  const openId =
    rail.open === null || rail.open === RAIL_CARDS ? undefined : resolvePanelId(rail.open).id
  const thirdOpen = openId !== undefined && panelType(openId) !== undefined
  // 报表那两格至少 560 宽（right-pane.ts），按它要的宽度算挤不挤得下
  const want = thirdOpen ? paneWidth(openId, rail.width, panelType(openId)?.minWidth) : null
  const layout = columnsLayout({
    size,
    third: mode === 'pending' ? null : want,
    narrow,
    docking: mode === 'widened' ? 'widened' : 'overlay',
  })
  return { ...layout, workPage: railPageKind(pathname) !== undefined, want, mode }
}

export function RightRail({ instances }: { instances?: PositionInstanceData[] }): ReactNode {
  return (
    <>
      <RailTopBar {...(instances === undefined ? {} : { instances })} />
      <RailHost {...(instances === undefined ? {} : { instances })} />
    </>
  )
}
/**
 * WP412（真机 10-18 #8，决策 1035 更正，照 Claude 桌面版）：右上角从左到右——
 *
 * - 露出来的工具（浏览器、变更审阅；注册表 `pinned` 排序）；
 * - 「⋮」**溢出菜单**：先是「设定」卡的几个标签（岗位 / 职责定义、技能、知识、记忆、额度，直达那一格），
 *   再是放不下 / 不常用的工具（教程，以及没给 `pinned` 的第三方面板）；窗口窄于 900 时
 *   露出来的那几个也收进来。它**不再**开关面板；
 * - 最右一个专门的**面板开关**（侧栏图标）：点它开 / 关右侧面板；任何一张卡有红 / 黄点时汇总点挂在它上面（红的压过黄的）。
 */
export function RailTopBar({
  instances,
  extra,
}: {
  instances?: PositionInstanceData[]
  /** WP431：外壳插进来的那几颗（通知铃铛的位置、这一页的设置按钮），排在「⋮」前面。 */
  extra?: ReactNode
}): ReactNode {
  ensureBuiltinPanels()
  const { t } = useApp()
  const rail = useRailState()
  const ctx = useRailContext(instances)
  const compact = useMedia(COMPACT)
  const cols = useColumns()
  const [menu, setMenu] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)
  const body: RailPanelBodyProps = {
    ...(ctx.scope === undefined ? {} : { scope: ctx.scope }),
    tier: ctx.tier,
    pathname: ctx.pathname,
  }
  const openDef =
    rail.open === null || rail.open === RAIL_CARDS
      ? undefined
      : panelType(resolvePanelId(rail.open).id)

  // 点菜单外面 / Esc 收起菜单
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setMenu(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(false)
    }
    globalThis.addEventListener?.('mousedown', onDown)
    globalThis.addEventListener?.('keydown', onKey)
    return () => {
      globalThis.removeEventListener?.('mousedown', onDown)
      globalThis.removeEventListener?.('keydown', onKey)
    }
  }, [menu])

  const pinned = pinnedItems().flatMap((i) => (i.kind === 'panel' ? [i.panel] : []))
  // 窄窗：露出来的那几个也收进「⋮」
  const shown = compact ? [] : pinned
  const overflow = [...(compact ? pinned : []), ...menuPanels()]
  const pick = (panel: string): void => {
    setMenu(false)
    rail.show(panel)
  }
  return (
    <nav
      className="flex items-center gap-0.5"
      aria-label={t('rail.title')}
      data-testid="right-rail"
      data-open={rail.open ?? ''}
    >
      {/*
        WP437：看板因为中栏太窄自动隐藏了，才出这一颗——点了看板浮在内容上看一眼，点外面收回。
        它不是「收起面板」的开关：宽度够了看板自己回来，这颗也就不见了。
      */}
      {cols.workPage && !cols.board ? (
        <button
          type="button"
          aria-pressed={rail.peek}
          aria-label={t('rail.board.peek')}
          title={t('rail.board.peek')}
          data-testid="board-peek"
          data-board-peek=""
          className={cn(ICON, rail.peek ? ICON_ACTIVE : ICON_IDLE)}
          onClick={() => {
            rail.setPeek(!rail.peek)
          }}
        >
          <LayoutDashboard aria-hidden className="size-4" />
        </button>
      ) : null}
      {shown.map((panel) => (
        <PanelIcon
          key={panel.id}
          definition={panel}
          body={body}
          active={openDef?.id === panel.id}
          onClick={() => {
            rail.show(openDef?.id === panel.id ? null : panel.id)
          }}
        />
      ))}
      {extra}
      <div ref={box} className="relative">
        <button
          type="button"
          aria-label={t('rail.overflow')}
          title={t('rail.overflow')}
          aria-haspopup="menu"
          aria-expanded={menu}
          data-testid="rail-overflow"
          className={cn(ICON, menu ? ICON_ACTIVE : ICON_IDLE)}
          onClick={() => {
            setMenu((v) => !v)
          }}
        >
          <MoreVertical aria-hidden className="size-4" />
        </button>
        {menu ? (
          <div
            role="menu"
            data-testid="rail-menu"
            className="absolute top-9 right-0 z-50 flex w-48 flex-col gap-px rounded-lg border border-ws-line bg-popover p-1 text-[13px] shadow-lg"
          >
            {/*
              「设定」卡里那几个标签（Luoye 10-19：只藏在卡里会以为没了）：点了打开面板直达那一格
              （别名 role / skills / knowledge / memory / caps 落回「设定」的对应标签）
            */}
            {SETTINGS_SHORTCUTS.map((item) => (
              <MenuItem
                key={item.id}
                testId={`rail-menu-${item.id}`}
                icon={item.icon}
                label={t(
                  item.id === 'role'
                    ? ctx.tier === 'role'
                      ? 'rail.menu.role.duty'
                      : 'rail.menu.role.position'
                    : `rail.menu.${item.id}`,
                )}
                onClick={() => {
                  pick(item.id)
                }}
              />
            ))}
            {overflow.length === 0 ? null : <div className="my-1 border-t border-ws-line" />}
            {overflow.map((p) => (
              <MenuItem
                key={p.id}
                testId={`rail-menu-${p.id}`}
                icon={p.icon}
                label={t(p.label)}
                onClick={() => {
                  pick(p.id)
                }}
              />
            ))}
          </div>
        ) : null}
      </div>
    </nav>
  )
}

function MenuItem({
  label,
  icon: Icon,
  onClick,
  testId,
}: {
  label: string
  icon: LucideIcon
  onClick: () => void
  testId: string
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      className="flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-left hover:bg-sidebar-accent/60"
      onClick={onClick}
    >
      <Icon aria-hidden className="size-4 text-ws-muted-fg" />
      {label}
    </button>
  )
}

const ICON = TOPBAR_ICON
const ICON_ACTIVE = TOPBAR_ICON_ACTIVE
const ICON_IDLE = TOPBAR_ICON_IDLE

function noBadge(_props: RailPanelBodyProps): undefined {
  return undefined
}

/** 露在右上角的一个面板（默认没有：浏览器 / 教程都在「⋮」里；`pinned` 一改就上来）。数字徽标照旧。 */
function PanelIcon({
  definition,
  body,
  active,
  onClick,
}: {
  definition: PanelTypeDefinition
  body: RailPanelBodyProps
  active: boolean
  onClick: () => void
}): ReactNode {
  const { t } = useApp()
  const useBadge = definition.useBadge ?? noBadge
  const badge = useBadge(body)
  const count = badge === undefined || badge.count <= 0 ? undefined : badge.count
  const label = t(definition.label)
  const tip =
    count !== undefined && badge !== undefined
      ? `${label} · ${badge.label}`
      : definition.hint === undefined
        ? label
        : `${label} · ${t(definition.hint)}`
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={tip}
      title={tip}
      data-testid={`rail-icon-${definition.id}`}
      className={cn(ICON, active ? ICON_ACTIVE : ICON_IDLE)}
      onClick={onClick}
    >
      <definition.icon aria-hidden className="size-4" />
      {count === undefined ? null : (
        <CountBadge
          aria-hidden
          n={count}
          tone="brand"
          corner
          data-testid={`rail-badge-${definition.id}`}
        />
      )}
    </button>
  )
}

/* ── 右侧面板 ──────────────────────────────────────────────────────── */

export function RailHost({ instances }: { instances?: PositionInstanceData[] }): ReactNode {
  // 幂等：内置面板与第三方面板走同一条注册路，这里只保证那条路跑过一次
  ensureBuiltinPanels()
  const { t } = useApp()
  const rail = useRailState()
  const cols = useColumns()
  // WP481：第三栏要多宽告诉桌面壳（窗口向右加宽 / 缩回；不在壳里什么都不做，一律浮层）
  useSidePaneSync(cols.want)
  // WP353：联网搜索被人机验证拦下、要人点时，自动打开「浏览器」（平时静默，不弹）
  useOpenBrowserOnHandover()
  useOpenPanelFromSearch()
  const ctx = useRailContext(instances)
  /**
   * WP431：卡片列只在岗位 / 职责 / 事项页上有；第三栏（浏览器、变更审阅、「显示更多」那一格……）哪儿都能开。
   * WP433：卡片列属于中栏、常驻；`rail.open` 只管第三栏开着哪一格（`null` / 卡片 = 第三栏收着）。
   * 存坏了 / 上一版留下的名字 / 应用包被卸了的那一格当成收着。
   */
  const workPage = cols.workPage
  // WP208：旧 id（`memory` …）先落到它现在的去处与标签（「设定」的「记忆」）
  const resolved =
    rail.open === null || rail.open === RAIL_CARDS ? undefined : resolvePanelId(rail.open)
  const definition = resolved === undefined ? undefined : panelType(resolved.id)
  const sub = definition === undefined ? undefined : resolved?.sub
  const dragging = useRef(false)
  const scope = ctx.scope

  /** `]` 收起第三栏；再按一次开回刚才那一格。 */
  const last = useRef<string | null>(null)
  if (definition !== undefined && rail.open !== null) last.current = rail.open
  const thirdOpen = definition !== undefined

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== ']' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || el?.isContentEditable === true) return
      e.preventDefault()
      if (thirdOpen) rail.show(null)
      else if (last.current !== null) rail.show(last.current)
    }
    globalThis.addEventListener?.('keydown', onKey)
    return () => {
      globalThis.removeEventListener?.('keydown', onKey)
    }
  }, [rail, thirdOpen])

  /**
   * 拖左边缘改宽度（夹在 320–720）；**松手**才写进本机。
   * WP431：面板头的「放大」钮去掉了（照 Claude：开关只在顶栏、宽度靠拖），所以拖的上限放宽；以前加宽过的那一份不再用。
   */
  const { setWidth } = rail
  const plain = rail.width
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return
      const next = (globalThis.innerWidth ?? 0) - e.clientX
      setWidth(clampRailWidth(next), false)
    }
    const onUp = (): void => {
      if (!dragging.current) return
      dragging.current = false
      setWidth(plain, true)
    }
    globalThis.addEventListener?.('mousemove', onMove)
    globalThis.addEventListener?.('mouseup', onUp)
    return () => {
      globalThis.removeEventListener?.('mousemove', onMove)
      globalThis.removeEventListener?.('mouseup', onUp)
    }
  }, [setWidth, plain])

  // WP437：报表那两格至少 560 宽（人拖得更宽照旧）
  const width = paneWidth(definition?.id, plain, definition?.minWidth)
  const scoped = definition?.scoped === true
  const body: RailPanelBodyProps = {
    ...(scope === undefined ? {} : { scope }),
    tier: ctx.tier,
    pathname: ctx.pathname,
    ...(rail.address === null ? {} : { address: rail.address }),
    ...(sub === undefined ? {} : { sub }),
  }
  const cardsBody: RailPanelBodyProps = {
    ...(scope === undefined ? {} : { scope }),
    tier: ctx.tier,
    pathname: ctx.pathname,
    ...(rail.address === null ? {} : { address: rail.address }),
  }
  const Body = definition === undefined ? undefined : panelBody(definition.id)
  const content = ((): ReactNode => {
    if (definition === undefined) return null
    // 注册了类型、还没注册身体 = 占位面板：照实说"还没做"
    if (Body === undefined)
      return (
        <p className="text-muted-foreground" data-testid="rail-placeholder">
          {t('rail.not_yet')}
        </p>
      )
    // 这一页还定位不到岗位：照实说，不去打注定 400 的接口
    if (scoped && scope === undefined)
      return (
        <p className="text-muted-foreground" data-testid="rail-no-scope">
          {t('rail.no_scope')}
        </p>
      )
    return (
      // WP298：分块下载失败 / 面板渲染抛错只换掉这一块（换个面板就复原）
      <ErrorBoundary
        scope="panel"
        label={`panel:${definition.id}`}
        resetKey={`${definition.id}|${sub ?? ''}`}
      >
        <Suspense
          fallback={
            <p className="text-muted-foreground" data-testid="rail-panel-loading">
              {t('rail.loading')}
            </p>
          }
        >
          <Body {...body} />
        </Suspense>
      </ErrorBoundary>
    )
  })()

  /*
   * WP433（Luoye 10-21 澄清）：岗位 / 职责 / 事项页右边那一列卡（对话 / 报表 / 产出 / 计划 / 连接 / 设定）
   * **属于中栏**——和中间内容一起、只是摆在右边，常驻、不能收，也不像侧栏（没有拖宽把手、没有分隔竖线、宽度随窗口）。
   *
   * WP437（Luoye 10-21 补充「中栏宽度优先」）：中栏可用宽度（窗口 − 左栏 − 并排开着的第三栏）放不下
   * 「核心内容区最小宽度 600 + 看板」时看板**自动隐藏**，放得下了自己回来（`board-fit.ts`）；打开第三栏挤窄时同样算。
   * 隐藏时顶栏多一颗小图标，点了看板浮在内容上看一眼（{@link BoardPeek}），点外面收回。
   */
  const cards = (
    <section className="flex flex-col text-sm" data-testid="rail-panel-cards" data-tier={ctx.tier}>
      {scope === undefined ? (
        <p className="text-muted-foreground" data-testid="rail-no-scope">
          {t('rail.no_scope')}
        </p>
      ) : (
        <RailCards {...cardsBody} />
      )}
    </section>
  )
  const board = !workPage ? null : cols.board ? (
    <div
      className="sticky top-11 h-[calc(100vh-2.75rem)] shrink-0 overflow-y-auto bg-ws-paper pt-4 pr-4 pb-6 md:pt-7 md:pr-7"
      style={{ width: cols.boardWidth }}
      data-testid="rail-board"
    >
      {cards}
    </div>
  ) : rail.peek ? (
    <BoardPeek
      width={cols.boardWidth}
      right={cols.third}
      onClose={() => {
        rail.setPeek(false)
      }}
    >
      {cards}
    </BoardPeek>
  ) : null

  /*
   * 真正的**右栏 / 第三栏**：点了才弹出、能开能关的那一格——浏览器、变更审阅（顶栏图标开关）、卡里「显示更多」的完整列表、
   * 看一份报表……出现在看板的再右边，可以拖宽（记住）。
   * WP437：并排之后核心内容区连最小宽度都保不住（或窗口窄于 900）时，改成盖在中栏上，点遮罩 / × 收起。
   * WP481（决策 1632）：**不挤中栏**——只有窗口为它向右加宽了才并排；不然（浏览器里、最大化 / 全屏、右边没地方）
   * 从右侧滑出、盖在中栏右侧（带阴影，点外面 / Esc 收起），中栏不重排。等壳回话那一下先不画。
   * WP485：「点外面」只算点中栏空白处；点中栏的行 / 按钮照常生效，不先收浮层。
   */
  const overlay = cols.overlay
  const pending = cols.mode === 'pending'
  useEffect(() => {
    if (!overlay || definition === undefined || pending) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // 浮层里自己开着的菜单 / 弹窗先收它们（Esc 归它们）
      const doc = globalThis.document
      if (doc?.querySelector('[role="dialog"], [role="menu"], [role="listbox"]') != null) return
      rail.show(null)
    }
    globalThis.addEventListener?.('keydown', onKey)
    return () => {
      globalThis.removeEventListener?.('keydown', onKey)
    }
  }, [overlay, definition, pending, rail])
  /*
   * WP485（决策 1672）：浮层不再拿一层透明底整块挡住中栏——点中栏的行 / 按钮照常生效（开第三栏的直接换成那一件，
   * 普通按钮浮层不收）；只有点中栏空白处才收起（`overlay-dismiss.ts`）。
   */
  const frameRef = useRef<HTMLDivElement | null>(null)
  useOverlayOutsideClick({
    enabled: overlay && definition !== undefined && !pending,
    frame: frameRef,
    openKey: `${rail.open ?? ''}|${rail.address ?? ''}`,
    onDismiss: () => {
      rail.show(null)
    },
  })
  const resize = (
    <button
      type="button"
      aria-label={t('rail.resize')}
      data-testid="rail-resize"
      className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-border"
      onMouseDown={() => {
        dragging.current = true
      }}
      onKeyDown={(e) => {
        // 键盘也调得动：左右箭头一次 20px
        const step = e.key === 'ArrowLeft' ? 20 : e.key === 'ArrowRight' ? -20 : 0
        if (step === 0) return
        e.preventDefault()
        setWidth(clampRailWidth(plain + step), true)
      }}
    />
  )
  const panel =
    definition === undefined || pending ? null : (
      <div
        ref={frameRef}
        className={cn(
          'flex shrink-0 border-l border-ws-line bg-ws-paper',
          overlay
            ? 'fixed top-11 right-0 bottom-0 z-40 shadow-2xl duration-200 animate-in slide-in-from-right motion-reduce:animate-none'
            : 'sticky top-11 z-40 h-[calc(100vh-2.75rem)]',
        )}
        // 并排时最多占窗口的一半；浮层最多盖到离左边 3rem（中栏露一截，知道下面还有东西）
        style={
          overlay
            ? { width, maxWidth: 'calc(100vw - 3rem)' }
            : { width, maxWidth: '50vw', minWidth: 300 }
        }
        data-testid="rail-panel-frame"
        data-panel={definition.id}
        data-layout={overlay ? 'overlay' : 'docked'}
        data-board={workPage ? (cols.board ? 'shown' : 'hidden') : undefined}
      >
        {resize}
        <div className="min-w-0 flex-1">
          <RailPanel
            title={t(definition.label)}
            {...(scoped && scope !== undefined ? { scope } : {})}
            tier={ctx.tier}
            onClose={() => {
              rail.show(null)
            }}
            testId={`rail-panel-${definition.id}`}
          >
            {content}
          </RailPanel>
        </div>
      </div>
    )

  // WP437：看板回来了（宽度够了）或这一页没有看板，临时一眼自己收
  const peekStale = rail.peek && (cols.board || !workPage)
  useEffect(() => {
    if (peekStale) rail.setPeek(false)
  }, [peekStale, rail])

  return (
    <>
      {/* WP144（docs/80 §5）：AI 正在操作这台电脑时的那一行（没在操作时不占地方） */}
      <ComputerUseStrip />
      {board}
      {panel}
    </>
  )
}

/**
 * WP504：地址栏带 `?panel=<面板 id>`（旧整页路由跳过来的：`/influencer/creators` → 岗位页 `?panel=kol-library&creator=…`）
 * → 在第三栏开那一格，`tab` / `item` / 其余参数交给那个面板（`library-intent.ts`），然后从地址栏收掉这一组。
 * 在外壳里做，所以哪一页都认（没有红人营销岗位时跳首页也开得出那一格）。
 */
function useOpenPanelFromSearch(): void {
  const rail = useRailState()
  const location = useLocation()
  const navigate = useNavigate()
  /** 同一个地址只认一次（地址栏收回去之前这一格可能再渲染几次）。 */
  const handled = useRef('')
  useEffect(() => {
    const search = new URLSearchParams(location.search)
    const hit = intentFromSearch(search)
    const key = `${location.pathname}?${location.search}`
    if (hit === undefined || handled.current === key) return
    handled.current = key
    setLibraryIntent(hit.panel, hit.intent)
    rail.show(hit.panel)
    for (const key of ['panel', 'tab', 'item', ...Object.keys(hit.intent.params ?? {})])
      search.delete(key)
    const rest = search.toString()
    void navigate(
      { pathname: location.pathname, search: rest === '' ? '' : `?${rest}` },
      { replace: true },
    )
  }, [location.search, location.pathname, navigate, rail])
}

/**
 * WP437：看板自动隐藏时的「临时一眼」——看板浮在内容上（贴着右边；第三栏并排开着时贴在它左边），
 * 点外面 / Esc 收回。顶栏那颗图标自己管开关（点它不算「点外面」）。
 */
function BoardPeek({
  width,
  right,
  onClose,
  children,
}: {
  width: number
  /** 右边让出多少（并排开着的第三栏的宽度）。 */
  right: number
  onClose: () => void
  children: ReactNode
}): ReactNode {
  const box = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Element | null
      if (box.current?.contains(target as Node) === true) return
      if (target?.closest?.('[data-board-peek]') != null) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    globalThis.addEventListener?.('mousedown', onDown)
    globalThis.addEventListener?.('keydown', onKey)
    return () => {
      globalThis.removeEventListener?.('mousedown', onDown)
      globalThis.removeEventListener?.('keydown', onKey)
    }
  }, [onClose])
  return (
    <div
      ref={box}
      className="fixed top-11 bottom-0 z-40 max-w-[calc(100vw-1rem)] overflow-y-auto border-l border-ws-line bg-ws-paper p-4 shadow-xl md:p-5"
      style={{ width, right }}
      data-testid="rail-board-peek"
    >
      {children}
    </div>
  )
}
