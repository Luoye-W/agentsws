/**
 * WP431（Luoye 10-19，照 Claude 桌面版）：**页面往顶栏里放东西的两个插槽**。
 *
 * Claude 的顶栏左边是这一页的标题 + 下拉箭头，右边一排图标；标题与「这一页的设置」是页面自己的东西，
 * 顶栏是外壳的东西。这里用 portal 把两者接起来：
 *
 * - {@link TopBarTitle}：岗位 / 职责 / 事项页把自己的标题（{@link TitleMenu}）放进顶栏左边；
 *   没有页面放的时候，外壳按地址写一个页名（首页、消息……）。
 * - {@link TopBarAction}：页面放进右边那排图标里的一颗（岗位设置 / 职责设置的滑杆）。
 *
 * **没有外壳时就地画**（单测里常只渲染一页）：标题与按钮照样在，只是不挪到顶栏——测试与老入口都不受影响。
 */
import { ChevronDown, type LucideIcon } from 'lucide-react'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

export interface TopBarSlots {
  title: HTMLElement | null
  action: HTMLElement | null
  /** 有页面在往标题插槽里放东西（外壳那时不写默认页名）。回一个撤销函数。 */
  claimTitle: () => () => void
}

const Ctx = createContext<TopBarSlots | null>(null)

export const TopBarSlotsProvider = Ctx.Provider

/** 外壳用：插槽两个元素 + 现在有没有页面占着标题。 */
export function useTopBarSlotState(): {
  slots: TopBarSlots
  setTitle: (el: HTMLElement | null) => void
  setAction: (el: HTMLElement | null) => void
  claimed: boolean
} {
  const [title, setTitle] = useState<HTMLElement | null>(null)
  const [action, setAction] = useState<HTMLElement | null>(null)
  const [claims, setClaims] = useState(0)
  const claimTitle = useRef(() => {
    setClaims((n) => n + 1)
    return () => {
      setClaims((n) => n - 1)
    }
  }).current
  return { slots: { title, action, claimTitle }, setTitle, setAction, claimed: claims > 0 }
}

// jsdom / 服务端没有布局，`useLayoutEffect` 会报警；那里退回 `useEffect`
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** 把这一页的标题放进顶栏左边（没有外壳 = 就地画）。 */
export function TopBarTitle({ children }: { children: ReactNode }): ReactNode {
  const ctx = useContext(Ctx)
  const claim = ctx?.claimTitle
  useIsoLayoutEffect(() => claim?.(), [claim])
  if (ctx === null) return children
  if (ctx.title === null) return null
  return createPortal(children, ctx.title)
}

/** 把一颗按钮放进顶栏右边那排图标里（没有外壳 = 就地画）。 */
export function TopBarAction({ children }: { children: ReactNode }): ReactNode {
  const ctx = useContext(Ctx)
  if (ctx === null) return children
  if (ctx.action === null) return null
  return createPortal(children, ctx.action)
}

/** 有没有外壳（页面据此决定还要不要在主区里留一份）。 */
export function useInTopBar(): boolean {
  return useContext(Ctx) !== null
}

/* ── 顶栏标题 + 下拉 ────────────────────────────────────────────────── */

/** 点外面 / Esc 就收起的小浮层。 */
export function usePopover(): {
  open: boolean
  setOpen: (v: boolean | ((x: boolean) => boolean)) => void
  box: React.RefObject<HTMLDivElement | null>
} {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    globalThis.document?.addEventListener('mousedown', close)
    globalThis.document?.addEventListener('keydown', esc)
    return () => {
      globalThis.document?.removeEventListener('mousedown', close)
      globalThis.document?.removeEventListener('keydown', esc)
    }
  }, [open])
  return { open, setOpen, box }
}

/**
 * 顶栏左边那个「标题 ˅」（照 Claude：13.5px 中等字重，箭头紧贴，悬停一块浅底）。
 * 点了是这一页的快捷操作（`menu(close)` 画菜单项）。`before` 画在标题前面（职责页的「岗位 /」）。
 */
export function TitleMenu({
  title,
  before,
  after,
  menu,
  testId,
  menuTestId,
  menuLabel,
}: {
  title: ReactNode
  before?: ReactNode
  /** 标题后面、箭头外面（如事项页改名时的输入框不在这里——改名直接换掉整颗按钮）。 */
  after?: ReactNode
  menu: (close: () => void) => ReactNode
  testId: string
  menuTestId: string
  menuLabel: string
}): ReactNode {
  const pop = usePopover()
  return (
    <div ref={pop.box} className="relative flex min-w-0 items-center" data-testid="top-bar-title">
      {before}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-label={menuLabel}
        data-testid={menuTestId}
        className={cn(
          'flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-left transition-colors hover:bg-foreground/[0.06]',
          pop.open && 'bg-foreground/[0.06]',
        )}
        onClick={() => {
          pop.setOpen((v) => !v)
        }}
      >
        <span
          className="min-w-0 truncate text-[13px] font-medium text-foreground"
          data-testid={testId}
          {...(typeof title === 'string' ? { title } : {})}
        >
          {title}
        </span>
        <ChevronDown aria-hidden className="size-3.5 shrink-0 text-ws-muted-fg" />
      </button>
      {after}
      {pop.open ? (
        <div
          role="menu"
          data-testid={`${menuTestId}-items`}
          className="absolute top-8 left-0 z-50 flex w-60 flex-col gap-px rounded-xl border border-ws-line bg-popover p-1 text-[13px] shadow-lg"
        >
          {menu(() => {
            pop.setOpen(false)
          })}
        </div>
      ) : null}
    </div>
  )
}

/** 下拉里的一项。 */
export function TitleMenuItem({
  icon: Icon,
  label,
  onSelect,
  testId,
  danger = false,
  disabled = false,
  hint,
  checked,
}: {
  icon?: LucideIcon
  label: ReactNode
  onSelect: () => void
  testId?: string
  danger?: boolean
  disabled?: boolean
  /** 灰的那一截（不能点的原因、快捷键……），靠右。 */
  hint?: ReactNode
  /** 给了就是单选项（切职责那一组，当前那条打勾）。 */
  checked?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      {...(checked === undefined ? {} : { 'aria-checked': checked })}
      data-testid={testId}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex h-8 items-center gap-2 rounded-lg px-2 text-left hover:bg-muted disabled:cursor-not-allowed disabled:text-ws-muted-fg disabled:hover:bg-transparent',
        danger && 'text-ws-bad',
        checked === true && 'font-medium',
      )}
    >
      {Icon === undefined ? null : <Icon aria-hidden className="size-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint === undefined ? null : (
        <span className="ml-auto max-w-[45%] shrink-0 truncate text-xs text-ws-muted-fg">
          {hint}
        </span>
      )}
    </button>
  )
}

export function TitleMenuSeparator(): ReactNode {
  return <hr className="mx-0.5 my-1 border-ws-line" />
}

export function TitleMenuLabel({ children }: { children: ReactNode }): ReactNode {
  return <p className="px-2 pt-1.5 pb-0.5 text-xs text-ws-muted-fg">{children}</p>
}

/* ── 顶栏右边那排的一颗图标 ──────────────────────────────────────────── */

/** 顶栏右边图标的统一样子（28px 方块、16px 图标；开着时一块浅底）。 */
export const TOPBAR_ICON =
  'relative flex size-7 shrink-0 items-center justify-center rounded-md transition-colors'
// 照 Claude：开着时一块中性的浅底（不用品牌色，深色下也不发绿）
export const TOPBAR_ICON_ACTIVE = 'bg-foreground/[0.08] text-foreground'
export const TOPBAR_ICON_IDLE = 'text-ws-muted-fg hover:bg-foreground/[0.06] hover:text-foreground'
