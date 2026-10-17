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
 * {@link RightRail} 两样一起画（老测试与只渲染右栏的地方用）；外壳把两样分开摆。
 */
import { MoreVertical } from 'lucide-react'
import { type ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ErrorBoundary } from '@/components/error-boundary'
import { ensureBuiltinPanels } from '@/components/rail/builtin-panels'
import { ComputerUseStrip } from '@/components/rail/computer-use-strip'
import { useOpenBrowserOnHandover } from '@/components/rail/panels/search-handover'
import { RailCards, StatusDot } from '@/components/rail/rail-cards'
import { RailPanel } from '@/components/rail/rail-panel'
import { type RailScope, type RailTier, railContextOf } from '@/components/rail/rail-scope'
import { cardOpen, RAIL_CARDS, useRailState } from '@/components/rail/rail-state'
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

/** 窄屏（< 1200）：面板盖在主区上，逻辑一个字不变。 */
const NARROW = '(max-width: 1199px)'
/** 再窄（< 900）：右上角那一排图标也收进「⋮」。 */
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

/* ── 右上角那一排 ──────────────────────────────────────────────────── */

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
  // 现在开着的那一格归哪张卡（「显示更多」进去的，图标照样亮着）
  const openDef =
    rail.open === null || rail.open === RAIL_CARDS
      ? undefined
      : panelType(resolvePanelId(rail.open).id)
  const activeCard = (id: string): boolean =>
    rail.open === RAIL_CARDS ? cardOpen(rail.cards, id) && rail.focus === id : openDef?.card === id

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

  const pinned = compact ? [] : pinnedItems()
  const tools = menuPanels()
  const pick = (fn: () => void): void => {
    setMenu(false)
    fn()
  }
  return (
    <nav
      className="flex items-center gap-0.5"
      aria-label={t('rail.title')}
      data-testid="right-rail"
      data-open={rail.open ?? ''}
    >
      {pinned.map((item) =>
        item.kind === 'card' ? (
          <CardIcon
            key={`card:${item.card.id}`}
            card={item.card}
            body={body}
            active={activeCard(item.card.id)}
            onClick={() => {
              rail.toggleCard(item.card.id)
            }}
          />
        ) : (
          <PanelIcon
            key={`panel:${item.panel.id}`}
            definition={item.panel}
            body={body}
            active={openDef?.id === item.panel.id}
            onClick={() => {
              rail.show(openDef?.id === item.panel.id ? null : item.panel.id)
            }}
          />
        ),
      )}
      <div ref={box} className="relative">
        <button
          type="button"
          aria-label={t('rail.overflow')}
          title={t('rail.overflow')}
          aria-haspopup="menu"
          aria-expanded={menu}
          data-testid="rail-overflow"
          className={cn(
            'flex size-8 items-center justify-center rounded-md',
            menu
              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
              : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
          )}
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
            className="absolute top-9 right-0 z-50 flex w-52 flex-col gap-px rounded-[10px] border border-ws-line bg-popover p-1 text-[13px] shadow-lg"
          >
            <MenuItem
              testId="rail-menu-cards"
              label={t('rail.cards')}
              onClick={() => {
                pick(() => {
                  rail.show(RAIL_CARDS)
                })
              }}
            />
            {compact
              ? listRailCards(rail.order).map((c) => (
                  <MenuItem
                    key={c.id}
                    testId={`rail-menu-card-${c.id}`}
                    icon={c.icon}
                    label={t(c.label)}
                    onClick={() => {
                      pick(() => {
                        rail.openCard(c.id)
                      })
                    }}
                  />
                ))
              : null}
            {tools.length === 0 ? null : <div className="my-1 border-t border-ws-line" />}
            {tools.map((p) => (
              <MenuItem
                key={p.id}
                testId={`rail-menu-${p.id}`}
                icon={p.icon}
                label={t(p.label)}
                onClick={() => {
                  pick(() => {
                    rail.show(p.id)
                  })
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
  icon?: RailCardDefinition['icon']
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
      {Icon === undefined ? (
        <span className="size-4" />
      ) : (
        <Icon aria-hidden className="size-4 text-ws-muted-fg" />
      )}
      {label}
    </button>
  )
}

const ICON = 'relative flex size-8 items-center justify-center rounded-md transition-colors'
const ICON_ACTIVE = 'bg-sidebar-accent text-sidebar-accent-foreground'
const ICON_IDLE = 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground'

function noStatus(_p: RailPanelBodyProps, _d: boolean): undefined {
  return undefined
}

/** 一张卡的图标：卡上亮什么点，这里就亮什么点（只要点，不取摘要）。 */
function CardIcon({
  card,
  body,
  active,
  onClick,
}: {
  card: RailCardDefinition
  body: RailPanelBodyProps
  active: boolean
  onClick: () => void
}): ReactNode {
  const { t } = useApp()
  const useStatus = card.useStatus ?? noStatus
  const status = useStatus(body, false)
  const label = t(card.label)
  const tip = status?.dotLabel === undefined ? label : `${label} · ${status.dotLabel}`
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={tip}
      title={tip}
      data-testid={`rail-icon-${card.id}`}
      className={cn(ICON, active ? ICON_ACTIVE : ICON_IDLE)}
      onClick={onClick}
    >
      <card.icon aria-hidden className="size-4" />
      {status?.dot === undefined ? null : (
        <span className="absolute top-1 right-1 flex">
          <StatusDot status={status} testId={`rail-icon-dot-${card.id}`} />
        </span>
      )}
    </button>
  )
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
        style={{ width }}
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
