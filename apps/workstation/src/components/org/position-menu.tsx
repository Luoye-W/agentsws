/**
 * WP456-T6（WP456 §3.8 P1、§2.6 第 10 条）：岗位行上的「⋯」——改名、加减职责、合并到… / 拆出… / 移动职责、删掉。
 *
 * 原来每张岗位卡上 7 个按钮摊开（一屏 3 个主按钮）；现在行上只留「请同事一起做」一颗次按钮，
 * 其余进这里。危险的（删掉）红字、放最后、点了要确认（确认在调用方）。
 *
 * 不用 Radix 下拉：几项的小菜单自己画一小块（同左栏那个 `MatterMenu`），Esc / 点外面就关，
 * 打开时焦点给第一项、↑↓ 在项之间走。
 */
import { MoreHorizontal } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export interface MenuItem {
  key: string
  label: string
  testId: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** 这一项前面画一条分隔线。 */
  separated?: boolean
}

export function OverflowMenu({
  label,
  items,
  testId,
}: {
  /** 「⋯」的读屏名（也是 tooltip）。 */
  label: string
  items: MenuItem[]
  testId: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false)
    }
    // Esc 只收这个小菜单：挂在 window 的捕获阶段、先于设置弹窗（Radix 挂在 document 上）拦下，
    // 不然一按 Esc 整个设置弹窗跟着关了
    const esc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    globalThis.document?.addEventListener('mousedown', close)
    globalThis.addEventListener?.('keydown', esc, true)
    box.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus()
    return () => {
      globalThis.document?.removeEventListener('mousedown', close)
      globalThis.removeEventListener?.('keydown', esc, true)
    }
  }, [open])
  if (items.length === 0) return null
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        className="ws-btn ws-btn-ghost ws-btn-sm w-7 px-0"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={label}
          className="absolute top-8 right-0 z-30 flex min-w-36 flex-col rounded-lg bg-ws-pop p-1 shadow-ws-pop"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
            e.preventDefault()
            const all = [
              ...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ??
                []),
            ]
            const at = all.indexOf(document.activeElement as HTMLElement)
            const next = all[(at + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]
            next?.focus()
          }}
        >
          {items.map((item) => (
            <div key={item.key} className="contents">
              {item.separated === true ? (
                <div aria-hidden className="my-1 h-px bg-ws-line" />
              ) : null}
              <button
                type="button"
                role="menuitem"
                data-testid={item.testId}
                disabled={item.disabled}
                className={cn(
                  'flex h-8 items-center rounded-md px-2 text-left text-ws-ui whitespace-nowrap hover:bg-ws-hover focus-visible:bg-ws-hover focus-visible:outline-none disabled:opacity-40 disabled:hover:bg-transparent',
                  item.danger === true ? 'text-ws-bad' : 'text-ws-ink',
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(false)
                  item.onSelect()
                }}
              >
                {item.label}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
