/**
 * WP207：左栏的「+」（照 Claude 的做法）。
 *
 * - 标题行（「岗位」）上的那个**常显**；岗位行 / 职责行上的那个**悬停才出现**——
 *   但 `opacity` 只管看不看得见，Tab 照样能落到它上面（键盘可达），落上去就显出来。
 * - 每个都有 tooltip（一句话，36 §7 少字规矩）；jsdom 里 Radix tooltip 打不开，
 *   所以同一句也写进 `aria-label`，读屏与测试都拿得到。
 */
import { cn } from 'cn'
import { Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export function RailPlus({
  label,
  onClick,
  hover = false,
  expanded,
  testId,
}: {
  /** tooltip 与读屏用的那一句。 */
  label: string
  onClick: () => void
  /** `true` = 悬停（或键盘聚焦）才出现；放在带 `group/row` 的那一行里。 */
  hover?: boolean
  /** 点开的是一块就地展开的表单时，告诉读屏开没开。 */
  expanded?: boolean
  testId: string
}): ReactNode {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            data-testid={testId}
            {...(expanded === undefined ? {} : { 'aria-expanded': expanded })}
            onClick={(e) => {
              // 行本身是链接：点「+」不该顺带跳走
              e.preventDefault()
              e.stopPropagation()
              onClick()
            }}
            className={cn(
              'flex size-5 shrink-0 items-center justify-center rounded text-ws-muted-fg transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring',
              hover && expanded !== true && 'opacity-0 group-hover/row:opacity-100',
            )}
          >
            <Plus aria-hidden className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
