/**
 * WP71（36 §9）：**第三栏 = 跟着"当前岗位 + 当前这件事"走的工具抽屉**。
 *
 * 左栏是"去哪儿"，中栏是"决定什么"，右栏是"看着什么决定"。
 *
 * 规矩照 36 §9 逐条落：
 *
 * - 默认收起成 **44px 图标轨**；**一次只开一个面板**，宽 380（可拖 320–520）；
 *   `]` 切换（输入框里按不算——那是在打字）；开着哪个面板与宽度记在本机（`lib/ui-state.ts`）；
 * - 面板内容**永远按当前岗位 / 当前职责取**（`rail-scope.ts`），面板头写着看的是哪一个；
 * - **< 1200 变成从右侧滑出的抽屉**，逻辑不变。
 *
 * 图标轨分三组（36 §9 的七个面板 + WP71 的四个设置面板）：
 *
 * | 组 | 面板 | 这一版 |
 * |---|---|---|
 * | 上 | 数据面板 / 运行中 / 定时任务 / 证据 | 占位（点了照实说"还没做"） |
 * | 中 | **记忆 / 技能 / 知识 / 额度** | **本 WP 做的四个** |
 * | 下 | 浏览器 / 文件 / 问 AI | 前两个占位；问 AI 是搬进来的已有件 |
 *
 * 占位为什么也画出来：图标轨的位置一旦定了就不该再挪（肌肉记忆），
 * 而"这里以后会有什么"本身就是有用的信息——比空着一条轨强。
 */
import {
  Activity,
  BarChart3,
  BookOpen,
  Brain,
  Clock,
  FileSearch,
  FolderOpen,
  Gauge,
  Globe,
  type LucideIcon,
  MessagesSquare,
  PanelRightClose,
  Sparkles,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { AskAiPanel } from '@/components/deck/ask-ai-panel'
import { CapsPanel } from '@/components/rail/panels/caps-panel'
import { KnowledgePanel } from '@/components/rail/panels/knowledge-panel'
import { MemoryPanel } from '@/components/rail/panels/memory-panel'
import { SkillsPanel } from '@/components/rail/panels/skills-panel'
import { RailPanel } from '@/components/rail/rail-panel'
import { type RailTier, railContextOf } from '@/components/rail/rail-scope'
import { useRailState } from '@/components/rail/rail-state'
import type { PositionInstanceData } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { clampRailWidth, readRailWidth, writeRailWidth } from '@/lib/ui-state'
import { cn } from '@/lib/utils'

/** 图标轨上的面板 id。顺序 = 轨上的顺序（36 §9）。 */
export type RailPanelId =
  | 'data'
  | 'runs'
  | 'schedules'
  | 'evidence'
  | 'memory'
  | 'skills'
  | 'knowledge'
  | 'caps'
  | 'browser'
  | 'files'
  | 'ask'

interface RailButton {
  id: RailPanelId
  icon: LucideIcon
  /** 这一版还没做的：点了开一个面板，里面只有一句"还没做"。 */
  placeholder?: boolean
}

const GROUPS: RailButton[][] = [
  [
    { id: 'data', icon: BarChart3, placeholder: true },
    { id: 'runs', icon: Activity, placeholder: true },
    { id: 'schedules', icon: Clock, placeholder: true },
    { id: 'evidence', icon: FileSearch, placeholder: true },
  ],
  [
    { id: 'memory', icon: Brain },
    { id: 'skills', icon: Sparkles },
    { id: 'knowledge', icon: BookOpen },
    { id: 'caps', icon: Gauge },
  ],
  [
    { id: 'browser', icon: Globe, placeholder: true },
    { id: 'files', icon: FolderOpen, placeholder: true },
    { id: 'ask', icon: MessagesSquare },
  ],
]

const ALL = GROUPS.flat()

function isPanelId(value: string | null): value is RailPanelId {
  return value !== null && ALL.some((b) => b.id === value)
}

/** `/matters/mat_1` → `mat_1`（问 AI 要有边界：没有事项就是禁用态）。 */
function matterOf(pathname: string): string | undefined {
  const m = /^\/matters\/([^/]+)\/?$/.exec(pathname)
  return m?.[1] === undefined ? undefined : decodeURIComponent(m[1])
}

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
  const { t, lang, position } = useApp()
  const location = useLocation()
  const narrow = useNarrow()
  const rail = useRailState()
  // 存坏了 / 是上一版留下的名字：当成收起，不去渲染一个不存在的面板
  const open: RailPanelId | null = isPanelId(rail.open) ? rail.open : null
  const [width, setWidth] = useState<number>(() => readRailWidth())
  const [tier, setTier] = useState<RailTier | null>(null)
  const dragging = useRef(false)

  const context = railContextOf(location.pathname, instances, position, lang)
  // 地址栏换了一层（进 / 出职责页）就跟着换；人手切过之后以人的选择为准
  const effectiveTier: RailTier =
    tier ?? (context.preferred === 'role' && context.role !== undefined ? 'role' : 'position')
  const scope = effectiveTier === 'role' ? context.role : context.position

  const show = rail.show
  /** `]` 收起之后再按一次，开回刚才那个面板（不是永远回到"记忆"）。 */
  const last = useRef<RailPanelId>('memory')
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

  /** 拖左边缘改宽度：夹在 320–520，松手写进本机那一份。 */
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return
      const right = globalThis.innerWidth ?? 0
      setWidth(clampRailWidth(right - e.clientX - 44))
    }
    const onUp = (): void => {
      if (!dragging.current) return
      dragging.current = false
      setWidth((w) => {
        writeRailWidth(w)
        return w
      })
    }
    globalThis.addEventListener?.('mousemove', onMove)
    globalThis.addEventListener?.('mouseup', onUp)
    return () => {
      globalThis.removeEventListener?.('mousemove', onMove)
      globalThis.removeEventListener?.('mouseup', onUp)
    }
  }, [])

  const button = ALL.find((b) => b.id === open)
  /** 这四个面板看的是"这一层的设置"，所以它们才跟岗位 / 职责走。 */
  const scoped =
    button !== undefined && ['memory', 'skills', 'knowledge', 'caps'].includes(button.id)

  const body = ((): ReactNode => {
    if (button === undefined) return null
    if (button.id === 'ask') {
      const matter_id = matterOf(location.pathname)
      return <AskAiPanel {...(matter_id === undefined ? {} : { scope: { matter_id } })} />
    }
    if (button.placeholder === true)
      return (
        <p className="text-muted-foreground" data-testid="rail-placeholder">
          {t('rail.not_yet')}
        </p>
      )
    // 这一页还定位不到岗位（没装岗位面 / 还没进过任何岗位）：照实说，不去打注定 400 的接口
    if (scope === undefined)
      return (
        <p className="text-muted-foreground" data-testid="rail-no-scope">
          {t('rail.no_scope')}
        </p>
      )
    switch (button.id) {
      case 'memory':
        return <MemoryPanel scope={scope} />
      case 'skills':
        return <SkillsPanel scope={scope} />
      case 'knowledge':
        return <KnowledgePanel scope={scope} />
      case 'caps':
        return <CapsPanel scope={scope} />
      default:
        return null
    }
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
      {button === undefined ? null : (
        <div
          className={cn(
            'z-40 flex shrink-0 border-l bg-background',
            narrow ? 'fixed inset-y-0 right-11 shadow-lg' : 'relative',
          )}
          style={{ width }}
          data-testid="rail-panel-frame"
          data-panel={button.id}
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
                setWidth((w) => {
                  const next = clampRailWidth(w + step)
                  writeRailWidth(next)
                  return next
                })
              }}
            />
          )}
          <div className="min-w-0 flex-1">
            <RailPanel
              title={t(`rail.panel.${button.id}`)}
              // 占位面板与问 AI 不跟层走：它们看的不是"这一层的设置"，
              // 所以不显示上下文名字，也没有层切换（没得选的开关只是噪音）
              {...(scoped && scope !== undefined ? { scope } : {})}
              tier={effectiveTier}
              onTier={setTier}
              hasPosition={scoped && context.position !== undefined}
              hasRole={scoped && context.role !== undefined}
              onClose={() => {
                show(null)
              }}
              testId={`rail-panel-${button.id}`}
            >
              {body}
            </RailPanel>
          </div>
        </div>
      )}
      <nav
        className="z-50 flex w-11 shrink-0 flex-col items-center gap-1 border-l bg-sidebar py-2"
        aria-label={t('rail.title')}
        data-testid="right-rail"
        data-open={open ?? ''}
      >
        {GROUPS.map((group, i) => (
          <div
            // 图标轨的三组是固定的，索引就是身份
            key={group[0]?.id ?? String(i)}
            className={cn('flex flex-col items-center gap-1', i > 0 && 'mt-2 border-t pt-2')}
          >
            {group.map((b) => (
              <button
                key={b.id}
                type="button"
                aria-pressed={open === b.id}
                aria-label={t(`rail.panel.${b.id}`)}
                title={t(`rail.panel.${b.id}`)}
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
