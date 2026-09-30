/**
 * WP212：消息页上两个小弹层（改判、交给哪个岗位）共用的壳：挂在触发键下面，点外面或按 Esc 收起。
 *
 * 不用 Radix 的下拉：改判层里有一个「以后都这样」的勾，点它不该把层关掉；交给岗位的层底下
 * 有一句说明。两样都不是"菜单"。
 */
import { type ReactNode, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  testId,
  align = 'start',
}: {
  open: boolean
  onOpenChange(open: boolean): void
  trigger: ReactNode
  children: ReactNode
  testId?: string
  align?: 'start' | 'end'
}): ReactNode {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) onOpenChange(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onOpenChange])
  return (
    <span ref={ref} className="relative inline-flex">
      {trigger}
      {open ? (
        <div
          role="dialog"
          data-testid={testId}
          className={cn(
            'absolute top-full z-30 mt-1.5 rounded-[12px] border border-ws-line bg-ws-card shadow-ws',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {children}
        </div>
      ) : null}
    </span>
  )
}
