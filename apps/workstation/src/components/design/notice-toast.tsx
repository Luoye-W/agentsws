/**
 * WP320（docs/96 §4.2 信息类组件）：**小提醒**——一句话、几秒后自己收起、不打断手上的事。
 *
 * 它不是卡（不要人拍板，docs/96 P1），也不是提醒条（那是「出问题」才出的）；它只说一件刚发生、
 * 人可能想看一眼的事（第一个用处：「记住了：……」）。
 *
 * 出现规则（用它的地方照这几条办）：
 * - **一次只有一条**：同一批里有好几件，合成一句（「记住了 3 件事」），不叠一摞；
 * - **人在打字时不弹**：输入框有焦点、最近两秒内按过键，就先压着，停手了再出（{@link isTypingNow}）；
 * - **几秒后自己收起**（默认 6 秒），鼠标停在上面时不走；
 * - **点它 = 去看那件事**（`onOpen`），旁边一个小叉只是收起；
 * - 放在右上角、第三栏图标轨的左边（输入框都在下面，不会盖住正在写的字）。
 */
import { X } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/** 默认停留多久（毫秒）。 */
export const NOTICE_TOAST_MS = 6000
/** 最后一次按键之后多久算「停手了」（毫秒）。 */
export const TYPING_QUIET_MS = 2000

/** 现在算不算「人在打字」：焦点在可输入的地方，且最近 {@link TYPING_QUIET_MS} 内按过键。 */
export function isTypingNow(
  active: Element | null | undefined,
  lastKeyAt: number | undefined,
  now: number,
): boolean {
  if (active === null || active === undefined || lastKeyAt === undefined) return false
  const tag = active.tagName.toLowerCase()
  const editable =
    tag === 'textarea' ||
    (tag === 'input' &&
      !['checkbox', 'radio', 'button', 'submit'].includes(
        (active as HTMLInputElement).type?.toLowerCase() ?? '',
      )) ||
    (active as HTMLElement).isContentEditable === true
  return editable && now - lastKeyAt < TYPING_QUIET_MS
}

/** 记下最后一次在可输入的地方按键的时间（整页一份）。 */
export function useLastTypedAt(): () => number | undefined {
  const last = useRef<number | undefined>(undefined)
  useEffect(() => {
    const onKey = (): void => {
      last.current = Date.now()
    }
    globalThis.addEventListener?.('keydown', onKey, true)
    return () => {
      globalThis.removeEventListener?.('keydown', onKey, true)
    }
  }, [])
  return () => last.current
}

export function NoticeToast({
  text,
  icon,
  onOpen,
  onDismiss,
  durationMs = NOTICE_TOAST_MS,
  dismissLabel,
  testId = 'notice-toast',
}: {
  text: string
  icon?: ReactNode
  onOpen: () => void
  onDismiss: () => void
  durationMs?: number
  dismissLabel: string
  testId?: string
}): ReactNode {
  const [hover, setHover] = useState(false)
  useEffect(() => {
    if (hover) return
    const timer = setTimeout(onDismiss, durationMs)
    return () => {
      clearTimeout(timer)
    }
  }, [hover, durationMs, onDismiss])
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={testId}
      className={cn(
        'fixed top-16 right-14 z-50 flex max-w-sm items-center gap-1 rounded-lg border bg-popover',
        'py-1 pr-1 pl-3 text-sm text-popover-foreground shadow-md',
        'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2',
      )}
      onMouseEnter={() => {
        setHover(true)
      }}
      onMouseLeave={() => {
        setHover(false)
      }}
    >
      <button
        type="button"
        data-testid={`${testId}-open`}
        className="flex min-w-0 items-center gap-2 py-1 text-left hover:underline"
        onClick={onOpen}
      >
        {icon}
        <span className="truncate">{text}</span>
      </button>
      <button
        type="button"
        aria-label={dismissLabel}
        data-testid={`${testId}-dismiss`}
        className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={onDismiss}
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}
