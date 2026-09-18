/**
 * WP71（36 §9）：**第三栏 = 跟着"当前岗位 + 当前这件事"走的工具抽屉**。
 * WP95（36 §11 C 档）：轨还是我们自己的，**面板改成注册表出的**。
 *
 * 左栏是"去哪儿"，中栏是"决定什么"，右栏是"看着什么决定"。
 *
 * 规矩照 36 §9 逐条落：
 *
 * - 默认收起成 **44px 图标轨**；**一次只开一个面板**，宽 380（可拖 320–520）；
 *   `]` 切换（输入框里按不算——那是在打字）；
 * - 面板内容**永远按当前岗位 / 当前职责取**（`rail-scope.ts`），面板头写着看的是哪一个；
 * - **< 1200 变成从右侧滑出的抽屉**，逻辑不变。
 *
 * WP95 改的三件事（`docs/upstream/sidebar-compare.md` #2 / #4 / #5 / #6）：
 *
 * 1. **图标轨读注册表**（`registry.ts` 的 `panelGroups()`），不再有写死的数组。
 *    内置面板与第三方面板走同一条公开路，这个文件里认不出谁是内置的；
 * 2. **布局按作用域分桶、只存结构**（`rail-state.tsx` + `lib/ui-state.ts`）：
 *    本机那一份里只有 `{ open_panel_id, width }`，没有一个字的面板内容；
 * 3. **启动不激活**：身体是 `lazy()`，没打开的面板不下载、不挂载、不发请求。
 *    刷新之后这里只按结构把"开哪个"恢复出来，内容由面板自己按作用域重新取。
 */
import { PanelRightClose } from 'lucide-react'
import { type ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ensureBuiltinPanels } from '@/components/rail/builtin-panels'
import { RailPanel } from '@/components/rail/rail-panel'
import { type RailTier, railContextOf } from '@/components/rail/rail-scope'
import { useRailState } from '@/components/rail/rail-state'
import { panelBody, panelGroups, panelType } from '@/components/rail/registry'
import type { PositionInstanceData } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { clampRailWidth } from '@/lib/ui-state'
import { cn } from '@/lib/utils'

/** 窄屏（< 1200）：面板变成盖在主区上的抽屉，逻辑一个字不变。 */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const mql = globalThis.matchMedia?.('(max-width: 1199px)')
    if (mql === undefined) return
    setNarrow(mql.matches)
    const on = (e: MediaQueryListEvent): void => {
      setNarrow(e.matches)
    }
    mql.addEventListener('change', on)
    return () => {
      mql.removeEventListener('change', on)
    }
  }, [])
  return narrow
}

export function RightRail({ instances }: { instances?: PositionInstanceData[] }): ReactNode {
  // 幂等：内置面板与第三方面板走同一条注册路，这里只保证那条路跑过一次
  ensureBuiltinPanels()
  const { t, lang, position } = useApp()
  const location = useLocation()
  const narrow = useNarrow()
  const rail = useRailState()
  const groups = panelGroups()
  // 存坏了 / 是上一版留下的名字 / 那个应用包被卸了：当成收起，
  // 不去渲染一个注册表里已经没有的面板
  const definition = rail.open === null ? undefined : panelType(rail.open)
  const open = definition?.id ?? null
  const [tier, setTier] = useState<RailTier | null>(null)
  const dragging = useRef(false)

  const context = railContextOf(location.pathname, instances, position, lang)
  // 地址栏换了一层（进 / 出职责页）就跟着换；人手切过之后以人的选择为准
  const effectiveTier: RailTier =
    tier ?? (context.preferred === 'role' && context.role !== undefined ? 'role' : 'position')
  const scope = effectiveTier === 'role' ? context.role : context.position

  const show = rail.show
  const setRailWidth = rail.setWidth
  const width = rail.width
  /** `]` 收起之后再按一次，开回刚才那个面板（不是永远回到"记忆"）。 */
  const last = useRef<string>('memory')
  if (open !== null) last.current = open

  /** `]` 切换第三栏。在输入框 / 可编辑区里按到它算打字，不当快捷键。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== ']' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || el?.isContentEditable === true) return
      e.preventDefault()
      // `]` 是"开 / 关第三栏"，不是"换面板"：收着的时候开回上一次那个（没有就开记忆）
      rail.show(rail.open === null ? last.current : null)
    }
    globalThis.addEventListener?.('keydown', onKey)
    return () => {
      globalThis.removeEventListener?.('keydown', onKey)
    }
  }, [rail])

  /** 拖左边缘改宽度：夹在 320–520，**松手**才写进本机那一份。 */
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return
      const right = globalThis.innerWidth ?? 0
      setRailWidth(clampRailWidth(right - e.clientX - 44), false)
    }
    const onUp = (): void => {
      if (!dragging.current) return
      dragging.current = false
      setRailWidth(width, true)
    }
    globalThis.addEventListener?.('mousemove', onMove)
    globalThis.addEventListener?.('mouseup', onUp)
    return () => {
      globalThis.removeEventListener?.('mousemove', onMove)
      globalThis.removeEventListener?.('mouseup', onUp)
    }
  }, [setRailWidth, width])

  /** 这个面板看的是"这一层的设置"吗（跟岗位 / 职责走、面板头带名字与层切换）。 */
  const scoped = definition?.scoped === true
  const Body = definition === undefined ? undefined : panelBody(definition.id)

  const body = ((): ReactNode => {
    if (definition === undefined) return null
    // 注册了类型、还没注册身体 = 占位面板：照实说"还没做"，不给空面板
    if (Body === undefined)
      return (
        <p className="text-muted-foreground" data-testid="rail-placeholder">
          {t('rail.not_yet')}
        </p>
      )
    // 这一页还定位不到岗位（没装岗位面 / 还没进过任何岗位）：照实说，不去打注定 400 的接口
    if (scoped && scope === undefined)
      return (
        <p className="text-muted-foreground" data-testid="rail-no-scope">
          {t('rail.no_scope')}
        </p>
      )
    return (
      // 身体是 `lazy()`：第一次打开要等它那个 chunk 下来，这一行就是那半秒的界面
      <Suspense
        fallback={
          <p className="text-muted-foreground" data-testid="rail-panel-loading">
            {t('rail.loading')}
          </p>
        }
      >
        <Body
          {...(scope === undefined ? {} : { scope })}
          tier={effectiveTier}
          pathname={location.pathname}
        />
      </Suspense>
    )
  })()

  return (
    <>
      {/* 窄屏抽屉的背景遮罩：点一下收起（与 `]` 同一件事） */}
      {narrow && open !== null ? (
        <button
          type="button"
          aria-label={t('rail.close')}
          data-testid="rail-scrim"
          className="fixed inset-0 z-40 bg-black/20"
          onClick={() => {
            show(null)
          }}
        />
      ) : null}
      {definition === undefined ? null : (
        <div
          className={cn(
            'z-40 flex shrink-0 border-l bg-background',
            narrow ? 'fixed inset-y-0 right-11 shadow-lg' : 'sticky top-0 h-screen',
          )}
          style={{ width }}
          data-testid="rail-panel-frame"
          data-panel={definition.id}
        >
          {/* 拖把手：只在宽屏有——抽屉档的宽度由屏幕说了算 */}
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
                // 键盘也调得动：左右箭头一次 20px（拖把手不该是只有鼠标能用的东西）
                const step = e.key === 'ArrowLeft' ? 20 : e.key === 'ArrowRight' ? -20 : 0
                if (step === 0) return
                e.preventDefault()
                setRailWidth(clampRailWidth(width + step), true)
              }}
            />
          )}
          <div className="min-w-0 flex-1">
            <RailPanel
              title={t(definition.label)}
              // 占位面板与工具面板不跟层走：它们看的不是"这一层的设置"，
              // 所以不显示上下文名字，也没有层切换（没得选的开关只是噪音）
              {...(scoped && scope !== undefined ? { scope } : {})}
              tier={effectiveTier}
              onTier={setTier}
              hasPosition={scoped && context.position !== undefined}
              hasRole={scoped && context.role !== undefined}
              onClose={() => {
                show(null)
              }}
              testId={`rail-panel-${definition.id}`}
            >
              {body}
            </RailPanel>
          </div>
        </div>
      )}
      <nav
        // 与左栏同一条理由：图标轨钉在视口上，滚主区的时候它不该跟着走
        className="sticky top-0 z-50 flex h-screen w-11 shrink-0 flex-col items-center gap-1 border-l bg-sidebar py-2"
        aria-label={t('rail.title')}
        data-testid="right-rail"
        data-open={open ?? ''}
      >
        {groups.map((group, i) => (
          <div
            key={group.group}
            className={cn('flex flex-col items-center gap-1', i > 0 && 'mt-2 border-t pt-2')}
          >
            {group.panels.map((b) => (
              <button
                key={b.id}
                type="button"
                aria-pressed={open === b.id}
                aria-label={t(b.label)}
                title={t(b.label)}
                data-testid={`rail-icon-${b.id}`}
                className={cn(
                  'flex size-8 items-center justify-center rounded-md',
                  open === b.id
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                )}
                onClick={() => {
                  show(open === b.id ? null : b.id)
                }}
              >
                <b.icon aria-hidden className="size-4" />
              </button>
            ))}
          </div>
        ))}
        {open === null ? null : (
          <button
            type="button"
            aria-label={t('rail.close')}
            title={t('rail.close')}
            data-testid="rail-collapse"
            className="mt-auto flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
            onClick={() => {
              show(null)
            }}
          >
            <PanelRightClose aria-hidden className="size-4" />
          </button>
        )}
      </nav>
    </>
  )
}
