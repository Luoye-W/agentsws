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
 * {@link RightRail} 两样一起画（老测试与只渲染右栏的地方用）；外壳把两样分开摆。
 */
import {
  BookOpen,
  Brain,
  Gauge,
  IdCard,
  type LucideIcon,
  MoreVertical,
  PanelRight,
  Wrench,
} from 'lucide-react'
import { type ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ErrorBoundary } from '@/components/error-boundary'
import { ensureBuiltinPanels } from '@/components/rail/builtin-panels'
import { ComputerUseStrip } from '@/components/rail/computer-use-strip'
import { useOpenBrowserOnHandover } from '@/components/rail/panels/search-handover'
import { RailCards } from '@/components/rail/rail-cards'
import { RailPanel } from '@/components/rail/rail-panel'
import { type RailScope, type RailTier, railContextOf } from '@/components/rail/rail-scope'
import { RAIL_CARDS, useRailState } from '@/components/rail/rail-state'
import {
  listRailCards,
  menuPanels,
  type PanelTypeDefinition,
  panelBody,
  panelType,
  pinnedItems,
  type RailCardDefinition,
  type RailPanelBodyProps,
  resolvePanelId,
} from '@/components/rail/registry'
import type { PositionInstanceData } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { clampRailWidth, clampWideWidth, RIGHT_RAIL_WIDE_DEFAULT } from '@/lib/ui-state'
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
 * 只有窗口窄于 900（接近手机宽）面板才盖在主区上；900 以上一律并排占一栏，和 Claude 的右侧面板一样
 * （Luoye 10-19：状态卡默认一直显示、占右栏，不浮在对话上）。窄一些的窗口靠下面的 `maxWidth` 让面板让位。
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

/** 这一页的两层范围与默认层（顶栏图标与面板都要）。 */
function useRailContext(
  instances: PositionInstanceData[] | undefined,
  tier: RailTier | null,
): {
  scope?: RailScope
  tier: RailTier
  pathname: string
  hasPosition: boolean
  hasRole: boolean
} {
  const { lang, position } = useApp()
  const { pathname } = useLocation()
  const context = railContextOf(pathname, instances, position, lang)
  // 地址栏换了一层（进 / 出职责页）就跟着换；人手切过之后以人的选择为准
  const effective: RailTier =
    tier ?? (context.preferred === 'role' && context.role !== undefined ? 'role' : 'position')
  const scope = effective === 'role' ? context.role : context.position
  return {
    ...(scope === undefined ? {} : { scope }),
    tier: effective,
    pathname,
    hasPosition: context.position !== undefined,
    hasRole: context.role !== undefined,
  }
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
export function RailTopBar({ instances }: { instances?: PositionInstanceData[] }): ReactNode {
  ensureBuiltinPanels()
  const { t } = useApp()
  const rail = useRailState()
  const ctx = useRailContext(instances, null)
  const compact = useMedia(COMPACT)
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
  const panelOpen = rail.open !== null
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
            className="absolute top-9 right-0 z-50 flex w-48 flex-col gap-px rounded-[10px] border border-ws-line bg-popover p-1 text-[13px] shadow-lg"
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
      <button
        type="button"
        aria-label={t(panelOpen ? 'rail.toggle.close' : 'rail.toggle.open')}
        title={t(panelOpen ? 'rail.toggle.close' : 'rail.toggle.open')}
        aria-pressed={panelOpen}
        data-testid="rail-toggle"
        className={cn(ICON, panelOpen ? ICON_ACTIVE : ICON_IDLE)}
        onClick={() => {
          rail.show(panelOpen ? null : RAIL_CARDS)
        }}
      >
        <PanelRight aria-hidden className="size-4" />
        {/* 汇总点：每张卡各画一个在同一个位置，红的压在黄的上面——看上去只有一个点 */}
        <span className="absolute top-1 right-1 flex size-1.5">
          {listRailCards(rail.order).map((card) => (
            <CardDotProbe key={card.id} card={card} body={body} />
          ))}
        </span>
      </button>
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

/** 一张卡的状态点，画在面板开关右上角（只要点，不取摘要）。 */
function CardDotProbe({
  card,
  body,
}: {
  card: RailCardDefinition
  body: RailPanelBodyProps
}): ReactNode {
  const useStatus = card.useStatus ?? noStatus
  const status = useStatus(body, false)
  if (status?.dot === undefined) return null
  return (
    <i
      role="img"
      aria-label={status.dotLabel ?? ''}
      title={status.dotLabel}
      data-testid="rail-toggle-dot"
      data-card={card.id}
      data-dot={status.dot}
      className={cn(
        'absolute inset-0 rounded-full',
        status.dot === 'alert' ? 'z-10 bg-ws-bad' : 'bg-ws-warn',
      )}
    />
  )
}

const ICON = 'relative flex size-8 items-center justify-center rounded-md transition-colors'
const ICON_ACTIVE = 'bg-sidebar-accent text-sidebar-accent-foreground'
const ICON_IDLE = 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground'

function noStatus(_p: RailPanelBodyProps, _d: boolean): undefined {
  return undefined
}

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
        <span
          aria-hidden
          data-testid={`rail-badge-${definition.id}`}
          className="ws-num absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-ws-brand px-1 text-[9px] leading-none font-medium text-white"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  )
}

/* ── 右侧面板 ──────────────────────────────────────────────────────── */

export function RailHost({ instances }: { instances?: PositionInstanceData[] }): ReactNode {
  // 幂等：内置面板与第三方面板走同一条注册路，这里只保证那条路跑过一次
  ensureBuiltinPanels()
  const { t } = useApp()
  const narrow = useMedia(NARROW)
  const rail = useRailState()
  // WP353：联网搜索被人机验证拦下、要人点时，自动打开「浏览器」（平时静默，不弹）
  useOpenBrowserOnHandover()
  const [tier, setTier] = useState<RailTier | null>(null)
  const ctx = useRailContext(instances, tier)
  const cards = rail.open === RAIL_CARDS
  // WP208：旧 id（`memory` …）先落到它现在的去处与标签（「设定」的「记忆」）
  const resolved = rail.open === null || cards ? undefined : resolvePanelId(rail.open)
  // 存坏了 / 是上一版留下的名字 / 那个应用包被卸了：当成收起
  const definition = resolved === undefined ? undefined : panelType(resolved.id)
  const sub = resolved?.sub
  const open = cards ? RAIL_CARDS : (definition?.id ?? null)
  const dragging = useRef(false)
  const scope = ctx.scope

  /** `]` 收起之后再按一次，开回刚才那个（没有就开卡片）。 */
  const last = useRef<string>(RAIL_CARDS)
  if (open !== null && rail.open !== null) last.current = rail.open

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== ']' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || el?.isContentEditable === true) return
      e.preventDefault()
      rail.show(rail.open === null ? last.current : null)
    }
    globalThis.addEventListener?.('keydown', onKey)
    return () => {
      globalThis.removeEventListener?.('keydown', onKey)
    }
  }, [rail])

  /** 拖左边缘改宽度：平常夹在 320–520，加宽着夹在 560–960；**松手**才写进本机。 */
  const { setWidth, setWide, wide } = rail
  const plain = rail.width
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return
      const next = (globalThis.innerWidth ?? 0) - e.clientX
      if (wide !== null) setWide(clampWideWidth(next))
      else setWidth(clampRailWidth(next), false)
    }
    const onUp = (): void => {
      if (!dragging.current) return
      dragging.current = false
      if (wide === null) setWidth(plain, true)
    }
    globalThis.addEventListener?.('mousemove', onMove)
    globalThis.addEventListener?.('mouseup', onUp)
    return () => {
      globalThis.removeEventListener?.('mousemove', onMove)
      globalThis.removeEventListener?.('mouseup', onUp)
    }
  }, [setWidth, setWide, wide, plain])

  if (open === null) return <ComputerUseStrip />

  const width = wide ?? plain
  const scoped = cards || definition?.scoped === true
  const body: RailPanelBodyProps = {
    ...(scope === undefined ? {} : { scope }),
    tier: ctx.tier,
    pathname: ctx.pathname,
    ...(rail.address === null ? {} : { address: rail.address }),
    ...(sub === undefined ? {} : { sub }),
  }
  const Body = definition === undefined ? undefined : panelBody(definition.id)
  const content = ((): ReactNode => {
    if (cards)
      return scope === undefined ? (
        <p className="text-muted-foreground" data-testid="rail-no-scope">
          {t('rail.no_scope')}
        </p>
      ) : (
        <RailCards {...body} />
      )
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
  const title = cards ? t('rail.cards') : definition === undefined ? '' : t(definition.label)

  return (
    <>
      {/* WP144（docs/80 §5）：AI 正在操作这台电脑时的那一行（没在操作时不占地方） */}
      <ComputerUseStrip />
      {/* 窄屏：面板盖在主区上，背景遮罩点一下收起（与 `]` 同一件事） */}
      {narrow ? (
        <button
          type="button"
          aria-label={t('rail.close')}
          data-testid="rail-scrim"
          className="fixed inset-x-0 top-11 bottom-0 z-40 bg-black/20"
          onClick={() => {
            rail.show(null)
          }}
        />
      ) : null}
      <div
        className={cn(
          'z-40 flex shrink-0 border-l border-ws-line bg-background',
          narrow
            ? 'fixed top-11 right-0 bottom-0 max-w-[calc(100vw-1rem)] shadow-lg'
            : 'sticky top-11 h-[calc(100vh-2.75rem)]',
        )}
        // 并排时面板最多占窗口的 38%（加宽时 60%），窗口窄了自己收，给对话留地方
        style={narrow ? { width } : { width, maxWidth: wide === null ? '38vw' : '60vw', minWidth: 300 }}
        data-testid="rail-panel-frame"
        data-panel={open}
        data-wide={wide === null ? undefined : 'true'}
      >
        {narrow ? null : (
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
              if (wide !== null) setWide(clampWideWidth(wide + step))
              else setWidth(clampRailWidth(plain + step), true)
            }}
          />
        )}
        <div className="min-w-0 flex-1">
          <RailPanel
            title={title}
            {...(scoped && scope !== undefined ? { scope } : {})}
            tier={ctx.tier}
            onTier={setTier}
            hasPosition={scoped && ctx.hasPosition}
            hasRole={scoped && ctx.hasRole}
            onClose={() => {
              rail.show(null)
            }}
            {...(cards
              ? {}
              : {
                  onBack: () => {
                    rail.show(RAIL_CARDS)
                  },
                })}
            wide={wide !== null}
            onWide={() => {
              setWide(wide === null ? RIGHT_RAIL_WIDE_DEFAULT : null)
            }}
            testId={`rail-panel-${open}`}
          >
            {content}
          </RailPanel>
        </div>
      </div>
    </>
  )
}
