/**
 * WP469：待办前面那个勾选框（清单、「还没排期的」共用；日历格子里的是同一个样子的 HTML，见 `calendar-view.ts`）。
 * 没勾是灰框、勾上是品牌色实心带勾——和日历「显示」那一列同一种勾。打勾 = 做完，不导航。
 */
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function TodoCheck({
  checked,
  label,
  disabled,
  onToggle,
  className,
  testId = 'todo-check',
}: {
  checked: boolean
  label: string
  disabled?: boolean
  onToggle(): void
  className?: string
  testId?: string
}): ReactNode {
  return (
    // biome-ignore lint/a11y/useSemanticElements: 要和日历格子里那一个同一种样子（自己画的框），读屏照样念成勾选框
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      className={cn(
        'inline-flex size-[18px] shrink-0 items-center justify-center rounded-sm border-[1.5px] transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40',
        checked
          ? 'border-ws-brand bg-ws-brand text-ws-brand-fg'
          : 'border-ws-line-strong bg-transparent hover:border-ws-brand',
        className,
      )}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
    >
      {checked ? <Check className="size-3" strokeWidth={2.75} aria-hidden /> : null}
    </button>
  )
}
