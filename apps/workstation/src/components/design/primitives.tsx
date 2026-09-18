/**
 * WP96 的几个最小件：卡壳、状态胶囊、涨跌胶囊、头像、→ 圆钮、火花线。
 *
 * 火花线**自己画**（36 §1：图表只用 shadcn chart / recharts，一条 40px 的走势
 * 不值得上图表库）：竖条版与折线版各一个，都是内联 SVG / flex，没有依赖。
 */
import { ArrowDownRight, ArrowRight as ArrowRightIcon, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TONE_PILL, type Tone } from './tone'

/** 画布 `.c2`：圆角 16、无边框、两层浅阴影；`selected` 换成光晕 + 抬 3px。 */
export function WsCard({
  selected,
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { selected?: boolean }): React.ReactNode {
  return (
    <div
      data-selected={selected === true ? 'true' : undefined}
      className={cn('ws-card', selected === true && 'ws-card-selected', className)}
      {...rest}
    >
      {children}
    </div>
  )
}

/** 状态胶囊：一个小圆点 + 一句话（画布 `.st`）。 */
export function StatusPill({
  tone = 'neutral',
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }): React.ReactNode {
  return (
    <span
      data-testid="ws-status-pill"
      data-tone={tone}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium',
        TONE_PILL[tone],
        className,
      )}
      {...rest}
    >
      <i aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  )
}

/** 芯片：方角一点的灰底小标签（画布 `.tag`）。 */
export function WsTag({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement>): React.ReactNode {
  return (
    <span
      data-testid="ws-tag"
      className={cn(
        'inline-flex h-[22px] items-center rounded-md bg-ws-surface px-2 text-xs text-ws-body',
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  )
}

export type Direction = 'up' | 'down' | 'flat'

const ARROW = { up: ArrowUpRight, down: ArrowDownRight, flat: ArrowRightIcon }

/**
 * 涨跌胶囊（画布 `.dp`）。
 *
 * **箭头方向 ≠ 好坏**：转化率掉了是向下箭头配红底，库存告急的"低于 5 件"也是红底
 * 但那不是"跌"。所以 `tone` 与 `direction` 分开传，谁也不替谁做判断。
 */
export function DeltaPill({
  direction = 'flat',
  tone,
  children,
}: {
  direction?: Direction
  tone?: Tone
  children: React.ReactNode
}): React.ReactNode {
  const Arrow = ARROW[direction]
  const resolved: Tone = tone ?? (direction === 'down' ? 'bad' : 'good')
  return (
    <span
      data-testid="ws-delta"
      data-direction={direction}
      className={cn(
        'inline-flex h-[22px] w-fit items-center gap-1 rounded-full px-2 text-xs font-semibold',
        TONE_PILL[resolved],
      )}
    >
      <Arrow className="size-3" aria-hidden />
      <span className="ws-num">{children}</span>
    </span>
  )
}

/** 圆头像：没有图就用名字第一个字（AI 提案用 "AI"）。 */
export function WsAvatar({
  name,
  tone = 'brand',
  className,
}: {
  name: string
  tone?: Tone
  className?: string
}): React.ReactNode {
  const initial = name.length <= 2 ? name : name.slice(0, 1)
  return (
    <span
      data-testid="ws-avatar"
      title={name}
      className={cn(
        'inline-flex size-[26px] items-center justify-center rounded-full text-[11px] font-semibold',
        TONE_PILL[tone],
        className,
      )}
    >
      {initial}
    </span>
  )
}

/**
 * 右下角的 → 圆钮（09-18 定：**每张卡都有**，没有按钮的卡也有）。
 *
 * 它不是"第四个动作"，它是出口：点它离开队列、进这件事的详情 / 工作线程。
 */
export function GoButton({
  label,
  onClick,
  className,
}: {
  label: string
  onClick: () => void
  className?: string
}): React.ReactNode {
  return (
    <button
      type="button"
      data-testid="ws-go"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn('ws-go', className)}
    >
      <ArrowRightIcon className="size-4" aria-hidden />
    </button>
  )
}

/**
 * 火花线 · 竖条版（深色画板那种）：最后一根（或指定的几根）高亮。
 *
 * 自己画的理由见文件头。高度按最大值归一到 `height`，只有一个值时画一根满格。
 */
export function SparkBars({
  points,
  height = 36,
  highlight,
  className,
}: {
  points: number[]
  height?: number
  /** 要点亮的下标；不传就点亮最后一根 */
  highlight?: number[]
  className?: string
}): React.ReactNode {
  if (points.length === 0) return null
  const max = Math.max(...points, 1)
  const on = new Set(highlight ?? [points.length - 1])
  return (
    <span
      data-testid="ws-spark-bars"
      className={cn('inline-flex items-end gap-[3px]', className)}
      style={{ height }}
      aria-hidden
    >
      {points.map((v, i) => (
        <i
          // biome-ignore lint/suspicious/noArrayIndexKey: 走势线的下标就是 x 轴，没有别的 id
          key={i}
          className={cn(
            'inline-block w-1 rounded-sm',
            on.has(i) ? 'bg-ws-brand' : 'bg-ws-brand-soft',
          )}
          style={{ height: Math.max(2, (v / max) * height) }}
        />
      ))}
    </span>
  )
}

/** 火花线 · 折线版（浅色画板"今天的数"那一列右边那条）。 */
export function SparkLine({
  points,
  className,
}: {
  points: number[]
  className?: string
}): React.ReactNode {
  if (points.length < 2) return null
  const max = Math.max(...points)
  const min = Math.min(...points)
  const span = max - min === 0 ? 1 : max - min
  const step = 100 / (points.length - 1)
  const path = points
    .map((v, i) => `${(i * step).toFixed(2)},${(22 - ((v - min) / span) * 20).toFixed(2)}`)
    .join(' ')
  return (
    <svg
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      className={cn('h-6 w-20 text-ws-brand', className)}
      aria-hidden
      focusable="false"
      data-testid="ws-spark-line"
    >
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
