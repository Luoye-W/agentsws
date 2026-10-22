/**
 * 分段进度条（WP302，决策 406 第一期）。
 *
 * 移植自 KOLAgents（Luoye 的产品，非模板代码）：`src/components/influencer/pipeline-progress.tsx`
 * @ 88d74b2c 的 `SegmentedProgress`——「一根条，四处用」：红人卡上的迷你条、合作线程里的步进条，
 * 同一个原件、同一套颜色，只差有多少地方。改的只有：`cn` / Tooltip 换成工坊的，颜色换成 `--ws-*`
 * 令牌，段的数据由服务端（`kol-core` 的 `stageSegments`）算好递过来，这里只画。
 */
import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { KolStageSegmentData } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 五种画法（KOLAgents 六种里的 `overdue` 是交付物排期用的，合作这里用不上）。 */
export type SegmentState = 'done' | 'current' | 'pending' | 'stalled' | 'muted'

export interface ProgressSegment {
  key: string
  label: string
  state: SegmentState
  /** 悬停那一句（停了几天）。 */
  hint?: string
  /** `stepper` 排法里标签下面的小字。 */
  caption?: string
}

const BAR_COLOR: Record<SegmentState, string> = {
  done: 'bg-primary',
  // 唯一会动的一段：正在这一段
  current: 'bg-primary animate-pulse',
  pending: 'bg-muted',
  stalled: 'bg-ws-warn',
  muted: 'bg-muted-foreground/30',
}

const TEXT_COLOR: Record<SegmentState, string> = {
  done: 'text-muted-foreground',
  current: 'font-medium text-foreground',
  pending: 'text-muted-foreground/70',
  stalled: 'font-medium text-ws-warn',
  muted: 'text-muted-foreground/60 line-through',
}

/**
 * 一根由几段组成的条。`mini` 只说「走到哪了」、细节进悬停（放得进红人卡）；
 * `stepper` 每段带名字与小字（放在合作线程里）。
 */
export function SegmentedProgress({
  segments,
  layout = 'mini',
  ariaLabel,
  className,
}: {
  segments: ProgressSegment[]
  layout?: 'mini' | 'stepper'
  ariaLabel?: string
  className?: string
}): ReactNode {
  if (segments.length === 0) return null
  return (
    <TooltipProvider>
      <div className={layout === 'stepper' ? '@container w-full' : 'contents'}>
        <ul
          className={cn(
            'flex w-full list-none items-end',
            layout === 'mini' ? 'gap-0.5' : 'gap-1',
            className,
          )}
          aria-label={ariaLabel}
          data-testid="kol-progress"
          data-layout={layout}
        >
          {segments.map((segment) => {
            const body = (
              <span
                className="flex w-full min-w-0 flex-col items-stretch gap-1"
                data-testid="kol-progress-segment"
                data-state={segment.state}
              >
                <span
                  className={cn(
                    'block w-full rounded-full transition-colors',
                    layout === 'mini' ? 'h-1.5' : 'h-2',
                    BAR_COLOR[segment.state],
                  )}
                />
                {layout === 'stepper' ? (
                  <span className="grid min-w-0 justify-items-center gap-0.5 text-center">
                    {/* WP416（自查 kol U14）：当前那一段加粗；窄的时候只留当前 / 卡住那一段的字 */}
                    <span
                      className={cn(
                        'w-full truncate text-xs leading-tight',
                        TEXT_COLOR[segment.state],
                        segment.state === 'current' || segment.state === 'stalled'
                          ? 'font-semibold'
                          : 'invisible @md:visible',
                      )}
                    >
                      {segment.label}
                    </span>
                    {segment.caption === undefined ? null : (
                      <span
                        className={cn(
                          'w-full truncate text-xs leading-tight',
                          segment.state === 'stalled'
                            ? TEXT_COLOR.stalled
                            : 'text-muted-foreground/70',
                        )}
                      >
                        {segment.caption}
                      </span>
                    )}
                  </span>
                ) : null}
              </span>
            )
            return (
              <li key={segment.key} className="flex min-w-0 flex-1 basis-0">
                {/* 步进条下面已经写着字：不再另起一个悬浮标签压在条上（只留原生 title） */}
                {segment.hint === undefined || layout === 'stepper' ? (
                  body
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex w-full min-w-0" title={segment.hint}>
                        {body}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">{segment.hint}</TooltipContent>
                  </Tooltip>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </TooltipProvider>
  )
}

/**
 * 一条合作的进度条：服务端算好的段 → 画法。停久了的那一段标黄，悬停说「已 N 天」。
 */
export function CollabProgress({
  segments,
  dwellDays,
  layout = 'mini',
  className,
}: {
  segments: readonly KolStageSegmentData[]
  dwellDays?: number | undefined
  layout?: 'mini' | 'stepper'
  className?: string
}): ReactNode {
  const { t } = useApp()
  const drawn: ProgressSegment[] = segments.map((s) => {
    const label = t(`kol.stage.${s.stage}`)
    const state: SegmentState =
      s.state === 'done'
        ? 'done'
        : s.state === 'pending'
          ? 'pending'
          : s.stage === 'declined'
            ? 'muted'
            : s.stalled
              ? 'stalled'
              : s.state === 'terminal'
                ? 'done'
                : 'current'
    const here = s.state === 'current' || s.state === 'terminal'
    const days =
      here && dwellDays !== undefined && s.stage !== 'closed' && s.stage !== 'declined'
        ? t('kol.progress.dwell', { n: dwellDays })
        : undefined
    return {
      key: s.stage,
      label,
      state,
      ...(here ? { hint: days === undefined ? label : `${label} · ${days}` } : {}),
      ...(here && days !== undefined ? { caption: days } : {}),
    }
  })
  const current = drawn.find((s) => s.hint !== undefined)
  return (
    <SegmentedProgress
      segments={drawn}
      layout={layout}
      ariaLabel={current?.hint ?? t('kol.progress.aria')}
      {...(className === undefined ? {} : { className })}
    />
  )
}
