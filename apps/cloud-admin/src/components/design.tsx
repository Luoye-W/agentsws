/**
 * 后台的几个最小件。
 *
 * `WsCard` / `StatusPill` / `WsTag` / `Tone` 与工作台 `components/design` 那份
 * **同名同形**（WP96 的设计画布）；这里是复制的一份精简版，理由与 `index.css`
 * 抬头那段一样：共用的是颜色语义，不是组件实现。
 */

import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export type Tone = 'brand' | 'good' | 'warn' | 'bad' | 'info' | 'neutral'

export const TONE_PILL: Record<Tone, string> = {
  brand: 'bg-ws-tint text-ws-brand-ink',
  good: 'bg-ws-good-bg text-ws-good',
  warn: 'bg-ws-warn-bg text-ws-warn',
  bad: 'bg-ws-bad-bg text-ws-bad',
  info: 'bg-ws-info-bg text-ws-info',
  neutral: 'bg-ws-surface text-ws-muted-fg',
}

export const TONE_BADGE: Record<Tone, string> = {
  brand: 'bg-ws-tint text-ws-brand',
  good: 'bg-ws-good-bg text-ws-good',
  warn: 'bg-ws-warn-bg text-ws-warn',
  bad: 'bg-ws-bad-bg text-ws-bad',
  info: 'bg-ws-info-bg text-ws-info',
  neutral: 'bg-ws-surface text-ws-muted-fg',
}

export function WsCard({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>): React.ReactNode {
  return (
    <div className={cn('ws-card', className)} {...rest}>
      {children}
    </div>
  )
}

export function StatusPill({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone
  children: React.ReactNode
  className?: string
}): React.ReactNode {
  return (
    <span
      data-testid="pill"
      data-tone={tone}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium',
        TONE_PILL[tone],
        className,
      )}
    >
      <i aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  )
}

export function WsTag({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}): React.ReactNode {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center rounded-md bg-ws-surface px-2 text-xs text-ws-body',
        className,
      )}
    >
      {children}
    </span>
  )
}

/**
 * 一格 KPI。**只排版，不算数**（与工作台的 `StatTile` 同一条：14 §2 数字不经模型手）。
 *
 * `delta` 是那两个"+N/7d · +N/30d"——KOLAgents 的看板上每个业务数字都挂着它，
 * 因为"3000 个账号"本身说明不了任何事，"3000，这周 +12"才是一句话。
 */
export function Kpi({
  label,
  value,
  delta,
  tone = 'brand',
  icon,
}: {
  label: string
  value: string
  delta?: string
  tone?: Tone
  icon?: React.ReactNode
}): React.ReactNode {
  return (
    <WsCard className="flex min-w-0 flex-col gap-1.5 p-4">
      <div className="flex items-center gap-2">
        {icon !== undefined && (
          <span
            className={cn(
              'inline-flex size-7 items-center justify-center rounded-full',
              TONE_BADGE[tone],
            )}
            aria-hidden
          >
            {icon}
          </span>
        )}
        <span className="truncate text-xs text-ws-muted-fg">{label}</span>
      </div>
      <span className="ws-display truncate text-[26px] leading-tight text-ws-ink" title={value}>
        {value}
      </span>
      {delta !== undefined && <span className="ws-num text-xs text-ws-muted-fg">{delta}</span>}
    </WsCard>
  )
}

export function SectionTitle({
  children,
  right,
}: {
  children: React.ReactNode
  right?: React.ReactNode
}): React.ReactNode {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <h2 className="ws-display text-[15px] text-ws-ink">{children}</h2>
      {right}
    </div>
  )
}

export function Spinner({ label }: { label: string }): React.ReactNode {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-ws-muted-fg">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  )
}

export function Empty({ label }: { label: string }): React.ReactNode {
  return <div className="p-8 text-center text-sm text-ws-muted-fg">{label}</div>
}

/** 一句解释。放在会误读的数字旁边——每一句都要说清"这个数不是什么"。 */
export function Note({
  tone = 'neutral',
  children,
}: {
  tone?: Tone
  children: React.ReactNode
}): React.ReactNode {
  return (
    <p className={cn('rounded-lg px-3 py-2 text-xs leading-relaxed', TONE_PILL[tone])}>
      {children}
    </p>
  )
}

export function Button({
  variant = 'ghost',
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger'
}): React.ReactNode {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        variant === 'primary' && 'bg-ws-brand text-ws-brand-fg hover:opacity-90',
        variant === 'ghost' && 'bg-ws-surface text-ws-ink hover:bg-ws-tint',
        variant === 'danger' && 'bg-ws-bad-bg text-ws-bad hover:opacity-90',
        className,
      )}
      {...rest}
    />
  )
}

/**
 * 一个表单格。**不是 `<label>` 包着控件**：里面的控件是调用方给的，包起来会让
 * 点标签这件事落到第一个 focusable 上（可能是提示文字里的链接）。所以用
 * `<div>` + 视觉上的标题，控件自己带 `aria-label` / `placeholder`。
 */
export function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: React.ReactNode
  hint?: string
}): React.ReactNode {
  return (
    <div className="flex flex-col gap-1 text-xs text-ws-muted-fg">
      <span>{label}</span>
      {children}
      {hint !== undefined && <span className="text-[11px] text-ws-muted-fg">{hint}</span>}
    </div>
  )
}

export const inputClass =
  'h-8 w-full rounded-lg border border-ws-line bg-transparent px-2.5 text-[13px] text-ws-ink outline-none focus-visible:border-ws-brand'
