/**
 * ProgressBar —— 抄自 Tremor Raw（Apache-2.0，© Tremor Labs, Inc.）。
 * 出处与改动见同目录 README.md。
 */
import { cn } from '@/lib/utils'

export function ProgressBar({
  value = 0,
  max = 100,
  label,
  className,
}: {
  value?: number
  max?: number
  /** 右边那一格文字（画布上是个数字）；不传就只有条 */
  label?: string
  className?: string
}): React.ReactNode {
  const safe = Math.min(Math.max(value, 0), max)
  const percent = max === 0 ? 0 : (safe / max) * 100
  return (
    <div className={cn('flex w-full items-center gap-2', className)} data-testid="progress-bar">
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-ws-line">
        <div
          className="h-full rounded-full bg-ws-brand transition-all duration-300"
          style={{ width: `${percent}%` }}
          role="progressbar"
          aria-label={label ?? 'progress'}
          aria-valuenow={safe}
          aria-valuemin={0}
          aria-valuemax={max}
        />
      </div>
      {label === undefined ? null : (
        <span className="ws-num text-xs text-ws-muted-fg">{label}</span>
      )}
    </div>
  )
}
