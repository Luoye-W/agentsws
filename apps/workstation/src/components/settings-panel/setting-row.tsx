/**
 * WP356：设置里的一行——学 Claude 的设置面板：左边「标题 + 一句白话」，右边控件（开关 / 下拉 / 几选一）。
 *
 * 长说明照旧进问号（36 §7 少字）。一节里的几行由外面的容器画分隔线，这一行自己不画框。
 * 控件太宽（一串标签、一个输入框）时用 `stacked`：控件换到说明下面。
 */
import type { ReactNode } from 'react'
import { Hint } from '@/components/ui/hint'
import { cn } from '@/lib/utils'

export function SettingRow({
  title,
  desc,
  hint,
  control,
  stacked = false,
  testId,
  className,
}: {
  title: ReactNode
  desc?: string
  hint?: string
  control: ReactNode
  stacked?: boolean
  testId?: string
  className?: string
}): ReactNode {
  return (
    <div
      className={cn(
        'flex gap-x-6 gap-y-2 py-3',
        stacked ? 'flex-col' : 'flex-wrap items-center justify-between',
        className,
      )}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-sm font-medium text-ws-ink">
          {title}
          {hint === undefined ? null : <Hint text={hint} />}
        </div>
        {desc === undefined ? null : (
          <p className="mt-0.5 text-[12.5px] leading-snug text-ws-muted-fg">{desc}</p>
        )}
      </div>
      <div className={cn('min-w-0', stacked ? 'w-full' : 'shrink-0')}>{control}</div>
    </div>
  )
}

/** 几选一的小胶囊（主题、语言、动效、内容更新那类两三档）。 */
export function Segmented<V extends string>({
  value,
  options,
  onChange,
  label,
  testId,
  disabled = false,
}: {
  value: V
  options: readonly { value: V; label: string }[]
  onChange: (v: V) => void
  label: string
  testId?: string
  disabled?: boolean
}): ReactNode {
  return (
    <fieldset
      className="inline-flex rounded-full border p-0.5 text-xs"
      aria-label={label}
      disabled={disabled}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          data-value={o.value}
          className={
            o.value === value
              ? 'rounded-full bg-primary px-2.5 py-0.5 text-primary-foreground'
              : 'rounded-full px-2.5 py-0.5 text-muted-foreground hover:text-foreground'
          }
          onClick={() => {
            if (o.value !== value) onChange(o.value)
          }}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  )
}
