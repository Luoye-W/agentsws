/**
 * WP437（Luoye 10-21）：对话框挪到**中栏底部居中**、悬浮在内容之上。
 *
 * - 贴在窗口底边（`sticky bottom-0`）：内容在它后面往上滚，滚到底时内容正好停在它上面——不会被挡住；
 * - 居中、最宽 760（与事项页那一栏同宽），中栏窄了跟着缩；
 * - 底下一截渐变到页面底色，滚过去的字不会和框搅在一起；渐变那一截不接点击（下面的东西照样点得到）；
 * - 页面内容少的时候也在窗口底部（页面根加 {@link DOCK_PAGE}：至少一屏高，框靠 `mt-auto` 沉到底）。
 *
 * 两种对话框都用它：首页的**简易对话框**（`variant="simple"`：半透明、毛玻璃）、岗位 / 职责 / 事项 / 助理页的**完整对话框**。
 *
 * **WP478（决策 1619 选 A，Luoye 10-23）**：完整对话框不挡内容。
 * - 页面底部永远留出「完整对话框 + 快捷提问」那么高的空白：这一截一直占着位子（只是看不看得见），
 *   所以最后一张卡总能完全滚到对话框上方；缩成小条时也不变高，页面不会跳。
 * - 对话框下面压着内容（前面那些东西的底边伸进了框里）时，缩成**底部居中小条**：圆角、写这一页的占位词、右边发送箭头，
 *   不出快捷提问；渐变底也收掉，后面的内容看得见、点得到。
 * - 滚到底（或内容本来就不够长）→ 小条淡出、完整对话框淡入。点小条 → 立刻展开、光标进输入框。
 * - 不缩回小条的几种：框里有字 / 有附件（`MatterComposer` 通过 {@link useDockReport} 报上来）；
 *   光标在框里；刚点开过（点过框里的东西）——要等人再滚一下、而且光标已经离开框，才按位置重新算。
 * - 只有 `variant="full"` 这样；首页的简易对话框不变。
 */
import { ArrowUp } from 'lucide-react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { useAskAi } from '@/components/ask-ai/ask-ai-store'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/**
 * 用底部对话框的页面根要加的几样：竖排；吃掉主区底边距（框自己留底）；
 * 至少一屏高（窗口 − 顶栏 44 − 主区上边距；底边距已经吃掉了）。
 */
export const DOCK_PAGE =
  'flex min-h-[calc(100vh-2.75rem-1rem)] flex-col -mb-4 md:min-h-[calc(100vh-2.75rem-1.75rem)] md:-mb-7'

/** 框里的输入框报上来的两样：有没有草稿（字 / 附件）、占位词（小条上写这一句）。 */
type DockReport = (draft: boolean, placeholder: string) => void
const DockContext = createContext<DockReport | undefined>(undefined)

/**
 * WP478：`MatterComposer` 用它把「框里有没有字 / 附件」和占位词报给外面那个 `ComposerDock`
 * （不在 dock 里时什么都不做）。
 */
export function useDockReport(draft: boolean, placeholder: string): void {
  const report = useContext(DockContext)
  useEffect(() => {
    report?.(draft, placeholder)
  }, [report, draft, placeholder])
}

/** 前面那些东西的底边伸进框里多少像素才算「压着」（亚像素误差不算）。 */
const OVERLAP_SLACK = 2

export function ComposerDock({
  children,
  above,
  variant = 'full',
  testId = 'composer-dock',
  className,
  data,
}: {
  children: ReactNode
  /** 框上面贴着的那几样（快捷按钮、当场回答、没发出去那句话）。 */
  above?: ReactNode
  /** `simple` = 首页的简易对话框（半透明、更窄）；`full` = 岗位 / 职责 / 事项 / 助理页。 */
  variant?: 'simple' | 'full'
  testId?: string
  className?: string
  /** 额外挂在最外层的 `data-*`（测试 / 截图脚本认）。 */
  data?: Record<`data-${string}`, string | undefined>
}): ReactNode {
  const { t } = useApp()
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const collapsible = variant === 'full'
  const [overlap, setOverlap] = useState(false)
  const [draft, setDraft] = useState(false)
  const [placeholder, setPlaceholder] = useState<string | undefined>(undefined)
  const [focused, setFocused] = useState(false)
  /** 点开过 / 点过框里的东西：等人再滚一下（光标也不在框里）才重新按位置算。 */
  const [engaged, setEngaged] = useState(false)
  const focusedRef = useRef(false)

  const report = useCallback<DockReport>((d, p) => {
    setDraft(d)
    setPlaceholder(p === '' ? undefined : p)
  }, [])

  /** 前面那些兄弟元素里最低的底边，伸进了框（快捷提问 + 输入框那一块）的顶边没有。 */
  const measure = useCallback((): void => {
    const el = outer.current
    const box = inner.current
    const parent = el?.parentElement
    if (el === null || box === null || parent === null || parent === undefined) return
    const top = box.getBoundingClientRect().top
    let bottom = Number.NEGATIVE_INFINITY
    for (const child of parent.children) {
      if (child === el) break
      const r = child.getBoundingClientRect()
      if (r.height > 0 && r.bottom > bottom) bottom = r.bottom
    }
    setOverlap(bottom > top + OVERLAP_SLACK)
  }, [])

  useLayoutEffect(() => {
    if (!collapsible) return
    const el = outer.current
    let frame = 0
    const schedule = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    const onScroll = (): void => {
      // 人滚了一下、光标也不在框里 → 「刚点开过」作废，按位置重新算
      if (!focusedRef.current) setEngaged(false)
      schedule()
    }
    measure()
    // 任何一层滚动都听（主区、助理那一栏、整页），不用先找是谁在滚
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', schedule)
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    const parent = el?.parentElement
    if (ro !== undefined && parent !== null && parent !== undefined) {
      ro.observe(parent)
      for (const child of parent.children) ro.observe(child)
    }
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      document.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', schedule)
      ro?.disconnect()
    }
  }, [collapsible, measure])

  const collapsed = collapsible && overlap && !draft && !focused && !engaged

  /*
   * WP504（决策 1775 A）：第三栏点 ✦ 把一张卡放进这个框——缩成小条时先展开，光标进框（小条是 inert 的，聚焦不进去）。
   */
  const { nonce: askNonce } = useAskAi()
  useEffect(() => {
    if (askNonce === 0 || inner.current?.querySelector('[data-ask-ai-target]') == null) return
    setEngaged(true)
    const frame = requestAnimationFrame(() => {
      inner.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [askNonce])

  /** 点小条：立刻展开、光标进输入框。 */
  const expand = (): void => {
    flushSync(() => {
      setEngaged(true)
    })
    inner.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  }

  return (
    <DockContext.Provider value={report}>
      <div
        ref={outer}
        className={cn(
          'pointer-events-none sticky bottom-0 z-30 mt-auto flex justify-center pt-6 pb-4 md:pb-6',
          className,
        )}
        data-testid={testId}
        data-variant={variant}
        data-state={collapsible ? (collapsed ? 'pill' : 'full') : undefined}
        {...data}
      >
        {collapsible ? (
          <div
            aria-hidden
            className={cn(
              'absolute inset-0 bg-gradient-to-b from-transparent via-ws-paper/80 via-45% to-ws-paper transition-opacity duration-200 motion-reduce:transition-none',
              collapsed && 'opacity-0',
            )}
          />
        ) : null}
        <div
          ref={inner}
          inert={collapsed}
          aria-hidden={collapsed ? true : undefined}
          onFocus={() => {
            focusedRef.current = true
            setFocused(true)
            setEngaged(true)
          }}
          onBlur={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
            focusedRef.current = false
            setFocused(false)
          }}
          onPointerDown={() => {
            setEngaged(true)
          }}
          className={cn(
            'relative flex w-full flex-col gap-2',
            variant === 'simple' ? 'max-w-[640px]' : 'max-w-[760px]',
            collapsible &&
              'origin-bottom transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none',
            collapsed
              ? 'pointer-events-none translate-y-2 scale-[.98] opacity-0'
              : 'pointer-events-auto',
          )}
          data-testid={collapsible ? 'composer-full' : undefined}
        >
          {above}
          {children}
        </div>
        {collapsible ? (
          <button
            type="button"
            tabIndex={collapsed ? 0 : -1}
            aria-hidden={collapsed ? undefined : true}
            aria-label={t('matter.cmp.pill.open')}
            title={placeholder ?? t('matter.cmp.pill')}
            data-testid="composer-pill"
            onClick={expand}
            className={cn(
              'ws-composer absolute bottom-4 bg-ws-card left-1/2 flex h-10 w-[min(360px,calc(100%-2rem))] -translate-x-1/2 items-center gap-2 rounded-full pr-1.5 pl-4 text-left md:bottom-6',
              'transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none',
              collapsed
                ? 'pointer-events-auto translate-y-0 opacity-100'
                : 'pointer-events-none translate-y-2 opacity-0',
            )}
          >
            <span className="min-w-0 flex-1 truncate text-[14px] text-ws-muted-fg">
              {placeholder ?? t('matter.cmp.pill')}
            </span>
            <span
              aria-hidden
              className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-ws-muted-fg dark:bg-input"
            >
              <ArrowUp className="size-[15px] stroke-[2.4]" />
            </span>
          </button>
        ) : null}
      </div>
    </DockContext.Provider>
  )
}
