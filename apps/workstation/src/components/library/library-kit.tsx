/**
 * WP504（决策 1765「资料在右、决策在中」、1777 A、1778 A、1761 A）：**第三栏库面板的通用件**——
 * 红人库、知识库、素材都用这一套，不许每个岗位写特例。
 *
 * - {@link LibraryHead}：面板头「名字 · 岗位」+ 右边几颗图标（↑ 上传、⋯ 更多），送进第三栏的头（`PanelHeaderSlot`）；
 * - {@link LibraryStack}：详情**叠在库上**，头换成「← 红人库 / 名字」；回去时筛选、选中、滚动位置都不变（1761 A：
 *   库一直挂着、只是藏起来）；
 * - {@link useSelection} + {@link BatchBar}：「多选」是开关，打开才出勾选框；选了就出**吸顶批量条**。
 *   批量动作两类（1777 A）：`confirm` = 对外发出 / 花钱 / 收不回——在中栏「要你处理」出一张确认卡，这里只给一条「去看」轻提示；
 *   `instant` = 当场生效 + 一条带「撤销」的轻提示。详情里的按钮走同一条（{@link runLibraryAction}）；
 * - {@link LibraryItemFrame}：库里一张卡 / 一行的外框——多选时的勾、悬停的 ✦ 问 AI、被问时亮一圈、能拖进输入框；
 * - {@link LibraryToasts}：面板底部的轻提示（一次最多两条，几秒自己收）。
 */
import { ArrowLeft, Check, MoreHorizontal, Sparkles, SquareCheck, X } from 'lucide-react'
import {
  createContext,
  type DragEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { AskAiButton, askAi } from '@/components/ask-ai/ask-ai'
import { type ContextRef, REF_MIME, refKey, useAskAi } from '@/components/ask-ai/ask-ai-store'
import { PanelHeaderSlot, useHasPanelHeader } from '@/components/rail/panel-header'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/* ── 头 ───────────────────────────────────────────────────────────── */

export interface LibraryMenuItem {
  id: string
  label: string
  icon?: ReactNode
  onSelect: () => void
}

/** 头上那一截：图标 + 「名字 · 岗位」+ 右边的图标钮与 ⋯ 菜单。 */
export function LibraryHead({
  icon,
  title,
  where,
  actions,
  menu,
}: {
  icon?: ReactNode
  title: string
  /** 岗位名（「红人营销」）；没有就不写。 */
  where?: string | undefined
  /** 右边几颗图标钮（↑ 上传……）。 */
  actions?: ReactNode
  /** ⋯ 里的几项（导入 / 导出 / 找新红人……）；空的不出 ⋯。 */
  menu?: readonly LibraryMenuItem[]
}): ReactNode {
  const { t } = useApp()
  const inner = (
    <>
      {icon === undefined ? null : <span className="shrink-0 text-ws-muted-fg">{icon}</span>}
      <h2
        className="min-w-0 flex-1 truncate text-[13px] font-medium text-ws-ink"
        data-testid="library-title"
      >
        {title}
        {where === undefined ? null : <span className="text-ws-muted-fg"> · {where}</span>}
      </h2>
      {actions}
      {menu === undefined || menu.length === 0 ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('library.more')}
              title={t('library.more')}
              data-testid="library-menu"
              className={HEAD_ICON}
            >
              <MoreHorizontal aria-hidden className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52" data-testid="library-menu-list">
            {menu.map((m) => (
              <DropdownMenuItem
                key={m.id}
                data-testid={`library-menu-${m.id}`}
                onSelect={() => {
                  m.onSelect()
                }}
              >
                {m.icon}
                {m.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  )
  return <HeadSlot>{inner}</HeadSlot>
}

/** 头上的一颗图标钮（↑ ⋯ 同一种）。 */
export const HEAD_ICON =
  'grid size-7 shrink-0 place-items-center rounded-md text-ws-muted-fg hover:bg-ws-hover hover:text-ws-ink focus-visible:outline-2 focus-visible:outline-ring'

/** 在第三栏里就送进头；不在（单独渲染、测试）就画在身体最上面。 */
function HeadSlot({ children }: { children: ReactNode }): ReactNode {
  const hasHead = useHasPanelHeader()
  if (hasHead) return <PanelHeaderSlot>{children}</PanelHeaderSlot>
  return (
    <div className="flex h-9 items-center gap-1.5" data-testid="library-head-inline">
      {children}
    </div>
  )
}

/* ── 叠一层 ─────────────────────────────────────────────────────────── */

export interface LibraryLayer {
  /** 这一层的身份（换人 = 换 key）。 */
  key: string
  /** 头上「← 库名 / 这一条」的这一条。 */
  title: string
  node: ReactNode
  /** 头上右边那几颗（「✦ 问 AI」）。 */
  actions?: ReactNode
}

/** 往上找第一个会滚的祖先（第三栏那一格的身体）。 */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let at = el?.parentElement ?? null
  while (at !== null) {
    const style = globalThis.getComputedStyle?.(at)
    if (style !== undefined && /(auto|scroll)/u.test(style.overflowY)) return at
    at = at.parentElement
  }
  return null
}

/**
 * 库 + 叠在上面的一层。库**一直挂着**（只是 `hidden`）：筛选、勾选、搜到一半的字都在；
 * 回去时把滚动位置也还回去（1761 A）。
 */
export function LibraryStack({
  rootTitle,
  head,
  layer,
  onBack,
  children,
}: {
  /** 库名（「红人库」）——叠上来时头上「← 红人库」。 */
  rootTitle: string
  /** 没叠的时候头上画什么（{@link LibraryHead}）。 */
  head: ReactNode
  layer: LibraryLayer | null
  onBack: () => void
  children: ReactNode
}): ReactNode {
  const { t } = useApp()
  const box = useRef<HTMLDivElement | null>(null)
  const saved = useRef(0)
  const open = layer !== null
  const was = useRef(open)
  useLayoutEffect(() => {
    const scroller = scrollParent(box.current)
    if (open && !was.current) {
      // 叠上去：记下库滚到哪，这一层从顶上看
      saved.current = scroller?.scrollTop ?? 0
      if (scroller !== null) scroller.scrollTop = 0
    } else if (!open && was.current && scroller !== null) {
      scroller.scrollTop = saved.current
    }
    was.current = open
  }, [open])
  return (
    <div ref={box} className="flex flex-col gap-3" data-testid="library-stack">
      {layer === null ? (
        head
      ) : (
        <HeadSlot>
          <button
            type="button"
            className="inline-flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-[13px] text-ws-muted-fg hover:bg-ws-hover hover:text-ws-ink"
            aria-label={t('library.back', { name: rootTitle })}
            data-testid="library-back"
            onClick={onBack}
          >
            <ArrowLeft aria-hidden className="size-4 shrink-0" />
            <span className="shrink-0">{rootTitle}</span>
          </button>
          <span aria-hidden className="text-ws-faint">
            /
          </span>
          <h2
            className="min-w-0 flex-1 truncate text-[13px] font-medium text-ws-ink"
            data-testid="library-layer-title"
          >
            {layer.title}
          </h2>
          {layer.actions}
        </HeadSlot>
      )}
      {/* 库一直挂着（筛选、勾选、搜的字都留着），叠上一层时只是藏起来 */}
      <div hidden={open} className="flex flex-col gap-3" data-testid="library-base">
        {children}
      </div>
      {layer === null ? null : (
        <div key={layer.key} data-testid="library-layer">
          {layer.node}
        </div>
      )}
    </div>
  )
}

/* ── 多选 ───────────────────────────────────────────────────────────── */

export interface Selection {
  /** 「多选」开着吗（开着才出勾选框）。 */
  on: boolean
  setOn: (on: boolean) => void
  ids: ReadonlySet<string>
  has: (id: string) => boolean
  toggle: (id: string) => void
  setAll: (ids: readonly string[]) => void
  clear: () => void
}

export function useSelection(): Selection {
  const [on, setOnRaw] = useState(false)
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set())
  const setOn = useCallback((next: boolean) => {
    setOnRaw(next)
    if (!next) setIds(new Set())
  }, [])
  return useMemo(
    () => ({
      on,
      setOn,
      ids,
      has: (id: string) => ids.has(id),
      toggle: (id: string) => {
        setIds((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      },
      setAll: (all: readonly string[]) => {
        setIds(new Set(all))
      },
      clear: () => {
        setIds(new Set())
      },
    }),
    [on, setOn, ids],
  )
}

/** 「多选」那颗开关（库头下面那一排的最右边）。 */
export function MultiToggle({ selection }: { selection: Selection }): ReactNode {
  const { t } = useApp()
  return (
    <button
      type="button"
      aria-pressed={selection.on}
      data-testid="library-multi"
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium',
        selection.on
          ? 'bg-ws-tint text-ws-brand'
          : 'text-ws-body hover:bg-ws-hover hover:text-ws-ink',
      )}
      onClick={() => {
        selection.setOn(!selection.on)
      }}
    >
      <SquareCheck aria-hidden className="size-3.5" />
      {selection.on ? t('library.multi.off') : t('library.multi')}
    </button>
  )
}

/* ── 批量动作 ───────────────────────────────────────────────────────── */

/**
 * 一个批量动作（也是详情里那一排按钮）。
 *
 * - `confirm`：对外发出 / 花钱 / 收不回（1777 A）——`run` 在中栏「要你处理」出一张确认卡，回来的提示带「去看」；
 * - `instant`：当场生效，回来的提示带「撤销」（`undo`）。
 */
export interface LibraryAction {
  id: string
  label: string
  icon?: ReactNode
  kind: 'confirm' | 'instant'
  /** 红色字（淘汰）。 */
  danger?: boolean
  /** 现在点不了（原因写在 `title` 里）。 */
  disabled?: boolean
  title?: string
  /** 点了先要一句话（加标签：标签名）——批量条下面就地出一个小输入框，回车才跑。 */
  ask?: { placeholder: string; go: string }
  run: (ids: readonly string[], input?: string) => Promise<LibraryActionResult | undefined>
}

export interface LibraryActionResult {
  /** 轻提示那一句（已经翻译好）。 */
  text: string
  /** `instant` 的撤销。 */
  undo?: () => Promise<void>
  /** `confirm` 的「去看」（滚到中栏那张卡）。 */
  goto?: () => void
  /** 出错了（红字，不带撤销）。 */
  error?: boolean
}

interface Toast extends LibraryActionResult {
  id: number
  icon?: ReactNode
}

const ToastContext = createContext<((t: Omit<Toast, 'id'>) => void) | undefined>(undefined)

/** 一次最多露几条轻提示。 */
const MAX_TOASTS = 2
/** 停多久（毫秒）。 */
export const LIBRARY_TOAST_MS = 6000

/** 面板底部那一摞轻提示（包住整个库面板）。 */
export function LibraryToasts({ children }: { children: ReactNode }): ReactNode {
  const { t } = useApp()
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)
  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    seq.current += 1
    const id = seq.current
    setToasts((prev) => [...prev, { ...toast, id }].slice(-MAX_TOASTS))
  }, [])
  const drop = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id))
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      {toasts.length === 0 ? null : (
        <div
          className="pointer-events-none sticky bottom-0 z-20 mt-3 flex flex-col gap-2 pb-1"
          data-testid="library-toasts"
          aria-live="polite"
        >
          {toasts.map((toast) => (
            <ToastRow
              key={toast.id}
              toast={toast}
              onDone={() => {
                drop(toast.id)
              }}
              undoLabel={t('library.undo')}
              gotoLabel={t('library.goto')}
              closeLabel={t('library.toast.close')}
              undoneText={t('library.undone')}
            />
          ))}
        </div>
      )}
    </ToastContext.Provider>
  )
}

function ToastRow({
  toast,
  onDone,
  undoLabel,
  gotoLabel,
  closeLabel,
  undoneText,
}: {
  toast: Toast
  onDone: () => void
  undoLabel: string
  gotoLabel: string
  closeLabel: string
  undoneText: string
}): ReactNode {
  const [hover, setHover] = useState(false)
  const [state, setState] = useState<'idle' | 'undoing' | 'undone'>('idle')
  useEffect(() => {
    if (hover) return
    const timer = setTimeout(onDone, state === 'undone' ? 1500 : LIBRARY_TOAST_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [hover, onDone, state])
  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex min-h-10 items-center gap-2 rounded-lg px-3 py-2 text-[13px] shadow-ws-hover',
        toast.error === true ? 'bg-ws-bad-bg text-ws-bad' : 'bg-ws-ink text-ws-paper',
      )}
      data-testid="library-toast"
      onMouseEnter={() => {
        setHover(true)
      }}
      onMouseLeave={() => {
        setHover(false)
      }}
    >
      {toast.icon === undefined ? null : <span className="shrink-0 opacity-80">{toast.icon}</span>}
      <span className="min-w-0 flex-1" data-testid="library-toast-text">
        {state === 'undone' ? undoneText : toast.text}
      </span>
      {toast.undo !== undefined && state !== 'undone' ? (
        <button
          type="button"
          disabled={state === 'undoing'}
          data-testid="library-toast-undo"
          className="shrink-0 rounded-md px-1.5 py-0.5 font-medium hover:bg-white/10"
          onClick={() => {
            setState('undoing')
            void toast.undo?.().then(
              () => {
                setState('undone')
              },
              () => {
                setState('idle')
              },
            )
          }}
        >
          {undoLabel}
        </button>
      ) : null}
      {toast.goto === undefined ? null : (
        <button
          type="button"
          data-testid="library-toast-goto"
          className="shrink-0 rounded-md px-1.5 py-0.5 font-medium hover:bg-white/10"
          onClick={() => {
            toast.goto?.()
            onDone()
          }}
        >
          {gotoLabel}
        </button>
      )}
      <button
        type="button"
        aria-label={closeLabel}
        className="grid size-5 shrink-0 place-items-center rounded-full opacity-70 hover:opacity-100"
        onClick={onDone}
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}

/** 跑一个库动作（批量条、详情里的按钮都走它）：结果变成一条轻提示。 */
export function useRunLibraryAction(): (
  action: LibraryAction,
  ids: readonly string[],
  input?: string,
) => Promise<boolean> {
  const push = useContext(ToastContext)
  return useCallback(
    async (action, ids, input) => {
      let out: LibraryActionResult | undefined
      try {
        out = await action.run(ids, input)
      } catch (e: unknown) {
        out = { text: e instanceof Error ? e.message : String(e), error: true }
      }
      if (out !== undefined)
        push?.({ ...out, ...(action.icon === undefined ? {} : { icon: action.icon }) })
      return out?.error !== true
    },
    [push],
  )
}

/** 同上，给不在 hook 里的地方用（测试）。 */
export async function runLibraryAction(
  action: LibraryAction,
  ids: readonly string[],
  input?: string,
): Promise<LibraryActionResult | undefined> {
  try {
    return await action.run(ids, input)
  } catch (e: unknown) {
    return { text: e instanceof Error ? e.message : String(e), error: true }
  }
}

/**
 * 吸顶批量条：「已选 N」+ 一排动作 + ✦ 问 AI（几张一起）+ ×（退出多选）。
 * 选了才出（0 个不出）；打开多选还没选的时候出一句「全选这一页」。
 */
export function BatchBar({
  selection,
  actions,
  visible,
  refsOf,
  fallback,
}: {
  selection: Selection
  actions: readonly LibraryAction[]
  /** 这一页看得见的那几条（「全选这一页」用）。 */
  visible: readonly string[]
  /** 选中的这几条 → 引用小卡（问 AI）。 */
  refsOf: (ids: readonly string[]) => readonly ContextRef[]
  /** 页面上没有输入框时去哪（那个岗位的页面）。 */
  fallback?: () => void
}): ReactNode {
  const { t } = useApp()
  const run = useRunLibraryAction()
  const [busy, setBusy] = useState<string | undefined>(undefined)
  /** 要先说一句话的那个动作（加标签）正开着输入框。 */
  const [asking, setAsking] = useState<LibraryAction | undefined>(undefined)
  const [input, setInput] = useState('')
  const bar = useRef<HTMLDivElement | null>(null)
  if (!selection.on) return null
  const ids = [...selection.ids]
  const n = ids.length
  const go = (a: LibraryAction, value?: string): void => {
    setBusy(a.id)
    void run(a, ids, value).then((ok) => {
      setBusy(undefined)
      // 当场生效的做完就清掉勾（要确认的留着，库里标「等你确认」）
      if (ok && a.kind === 'instant') selection.clear()
    })
  }
  return (
    <div
      ref={bar}
      className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center gap-1 rounded-lg bg-ws-card px-2 py-1.5 shadow-ws"
      data-testid="library-batch-bar"
      data-count={n}
    >
      <button
        type="button"
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-semibold text-ws-ink hover:bg-ws-hover"
        aria-label={n === visible.length ? t('library.select.clear') : t('library.select.all')}
        title={n === visible.length ? t('library.select.clear') : t('library.select.all')}
        data-testid="library-select-all"
        onClick={() => {
          if (n === visible.length && n > 0) selection.clear()
          else selection.setAll(visible)
        }}
      >
        <span
          aria-hidden
          className={cn(
            'grid size-4 place-items-center rounded-sm border',
            n > 0 ? 'border-ws-brand bg-ws-brand text-ws-brand-fg' : 'border-ws-line',
          )}
        >
          {n > 0 ? <Check className="size-3" /> : null}
        </span>
        {t('library.selected', { n })}
      </button>
      {actions.map((a) => (
        <button
          key={a.id}
          type="button"
          disabled={n === 0 || a.disabled === true || busy !== undefined}
          title={a.title}
          data-testid={`library-batch-${a.id}`}
          data-kind={a.kind}
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium disabled:opacity-50',
            a.danger === true
              ? 'text-ws-bad hover:bg-ws-bad-bg'
              : 'text-ws-body hover:bg-ws-hover hover:text-ws-ink',
          )}
          aria-expanded={a.ask === undefined ? undefined : asking?.id === a.id}
          onClick={() => {
            if (a.ask !== undefined) {
              setAsking(asking?.id === a.id ? undefined : a)
              setInput('')
              return
            }
            go(a)
          }}
        >
          {a.icon}
          {a.label}
        </button>
      ))}
      <span aria-hidden className="mx-0.5 h-4 w-px bg-ws-line" />
      <button
        type="button"
        disabled={n === 0}
        data-testid="library-batch-ask"
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-ws-brand hover:bg-ws-tint disabled:opacity-50"
        onClick={() => {
          askAi(refsOf(ids), { from: bar.current, ...(fallback === undefined ? {} : { fallback }) })
        }}
      >
        <Sparkles aria-hidden className="size-3.5" />
        {t('ask_ai.label')}
      </button>
      <button
        type="button"
        aria-label={t('library.multi.off')}
        title={t('library.multi.off')}
        data-testid="library-batch-close"
        className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-ws-muted-fg hover:bg-ws-hover hover:text-ws-ink"
        onClick={() => {
          selection.setOn(false)
        }}
      >
        <X aria-hidden className="size-4" />
      </button>
      {asking?.ask === undefined ? null : (
        <form
          className="flex w-full items-center gap-1.5 pt-1"
          data-testid="library-batch-ask-input"
          onSubmit={(e) => {
            e.preventDefault()
            const value = input.trim()
            if (value === '' || n === 0) return
            const a = asking
            setAsking(undefined)
            go(a, value)
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: 点了「加标签」就是要马上打字
            autoFocus
            value={input}
            maxLength={40}
            placeholder={asking.ask.placeholder}
            aria-label={asking.ask.placeholder}
            data-testid="library-batch-ask-field"
            className="h-7 min-w-0 flex-1 rounded-md border border-ws-line bg-ws-card px-2 text-xs text-ws-ink outline-none focus-visible:border-ws-brand"
            onChange={(e) => {
              setInput(e.target.value)
            }}
          />
          <button
            type="submit"
            disabled={input.trim() === '' || n === 0}
            data-testid="library-batch-ask-go"
            className="h-7 shrink-0 rounded-md bg-ws-brand px-2.5 text-xs font-medium text-ws-brand-fg disabled:opacity-50"
          >
            {asking.ask.go}
          </button>
        </form>
      )}
    </div>
  )
}

/* ── 一张卡的外框 ───────────────────────────────────────────────────── */

/** 多选时卡左上角那个勾（各库的卡自己摆在名字前面）。 */
export function ItemCheck({
  id,
  name,
  selection,
}: {
  id: string
  name: string
  selection: Selection
}): ReactNode {
  const { t } = useApp()
  if (!selection.on) return null
  return (
    <input
      type="checkbox"
      className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--ws-brand)]"
      checked={selection.has(id)}
      aria-label={t('library.select.item', { name })}
      data-testid="library-item-check"
      onClick={(e) => {
        e.stopPropagation()
      }}
      onChange={() => {
        selection.toggle(id)
      }}
    />
  )
}

/**
 * 库里一张卡 / 一行的外框：多选时左上角一个勾（{@link ItemCheck}，卡自己摆）；悬停右上角 ✦（问 AI）；被问了 / 被选了亮一圈；
 * 整张能拖进中栏输入框（和点 ✦ 一样）。里面长什么样是各库自己的事。
 */
export function LibraryItemFrame({
  id,
  name,
  selection,
  refOf,
  fallback,
  as: Tag = 'li',
  className,
  children,
}: {
  id: string
  name: string
  selection: Selection
  refOf: () => ContextRef
  fallback?: () => void
  as?: 'li' | 'div'
  className?: string
  children: ReactNode
}): ReactNode {
  const { asked } = useAskAi()
  const ref = refOf
  const key = useMemo(() => {
    const r = ref()
    return refKey(r)
  }, [ref])
  const lit = asked.has(key)
  const picked = selection.on && selection.has(id)
  const onDragStart = (e: DragEvent<HTMLElement>): void => {
    e.dataTransfer.setData(REF_MIME, JSON.stringify([ref()]))
    e.dataTransfer.setData('text/plain', name)
    e.dataTransfer.effectAllowed = 'copy'
  }
  return (
    <Tag
      className={cn(
        'group/ask relative min-w-0 rounded-[var(--ws-radius-card)] transition-shadow',
        (lit || picked) && 'ring-2 ring-ws-brand/60',
        className,
      )}
      data-ask-ai-source=""
      data-testid="library-item"
      data-item={id}
      data-asked={lit ? 'true' : undefined}
      data-selected={picked ? 'true' : undefined}
      draggable
      onDragStart={onDragStart}
    >
      {children}
      <AskAiButton
        refs={() => [ref()]}
        {...(fallback === undefined ? {} : { fallback })}
        testId="library-item-ask"
      />
    </Tag>
  )
}
