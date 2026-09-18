/**
 * ProgressCircle —— 抄自 Tremor Raw（Apache-2.0，© Tremor Labs, Inc.）。
 * 出处与改动见同目录 README.md。
 */
import { cn } from '@/lib/utils'

const SIZES = {
  sm: { radius: 15, strokeWidth: 3 },
  md: { radius: 19, strokeWidth: 4 },
  lg: { radius: 26, strokeWidth: 6 },
  xl: { radius: 34, strokeWidth: 7 },
} as const

export type ProgressCircleSize = keyof typeof SIZES

export function ProgressCircle({
  value = 0,
  max = 100,
  size = 'lg',
  className,
  children,
  label,
}: {
  value?: number
  max?: number
  size?: ProgressCircleSize
  className?: string
  children?: React.ReactNode
  label?: string
}): React.ReactNode {
  const safe = Math.min(Math.max(value, 0), max)
  const { radius, strokeWidth } = SIZES[size]
  const normalized = radius - strokeWidth / 2
  const circumference = 2 * Math.PI * normalized
  const offset = circumference - (safe / max) * circumference

  return (
    <div
      className={cn('flex flex-col items-center justify-center', className)}
      data-testid="progress-circle"
      data-value={safe}
    >
      <svg
        width={radius * 2}
        height={radius * 2}
        viewBox={`0 0 ${radius * 2} ${radius * 2}`}
        className="-rotate-90 transform"
        role="progressbar"
        aria-label={label ?? 'progress'}
        aria-valuenow={safe}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        <circle
          r={normalized}
          cx={radius}
          cy={radius}
          strokeWidth={strokeWidth}
          fill="transparent"
          stroke="currentColor"
          strokeLinecap="round"
          className="stroke-ws-line transition-colors"
        />
        {safe >= 0 ? (
          <circle
            r={normalized}
            cx={radius}
            cy={radius}
            strokeWidth={strokeWidth}
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={offset}
            fill="transparent"
            stroke="currentColor"
            strokeLinecap="round"
            className="stroke-ws-brand transition-all duration-300 ease-in-out"
          />
        ) : null}
      </svg>
      {children === undefined ? null : (
        <div className="absolute flex items-center justify-center">{children}</div>
      )}
    </div>
  )
}
