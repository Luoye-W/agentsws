/**
 * WP437（Luoye 10-21）：对话框挪到**中栏底部居中**、悬浮在内容之上。
 *
 * - 贴在窗口底边（`sticky bottom-0`）：内容在它后面往上滚，滚到底时内容正好停在它上面——不会被挡住；
 * - 居中、最宽 760（与事项页那一栏同宽），中栏窄了跟着缩；
 * - 底下一截渐变到页面底色，滚过去的字不会和框搅在一起；渐变那一截不接点击（下面的东西照样点得到）；
 * - 页面内容少的时候也在窗口底部（页面根加 {@link DOCK_PAGE}：至少一屏高，框靠 `mt-auto` 沉到底）。
 *
 * 两种对话框都用它：首页的**简易对话框**（`variant="simple"`：半透明、毛玻璃）、岗位 / 职责 / 事项页的**完整对话框**。
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 用底部对话框的页面根要加的几样：竖排；吃掉主区底边距（框自己留底）；
 * 至少一屏高（窗口 − 顶栏 44 − 主区上边距；底边距已经吃掉了）。
 */
export const DOCK_PAGE =
  'flex min-h-[calc(100vh-2.75rem-1rem)] flex-col -mb-4 md:min-h-[calc(100vh-2.75rem-1.75rem)] md:-mb-7'

export function ComposerDock({
  children,
  above,
  variant = 'full',
  testId = 'composer-dock',
  className,
  data,
}: {
  children: ReactNode
  /** 框上面贴着的那几样（快捷按钮、当场回答、没发出去那句话）。 */
  above?: ReactNode
  /** `simple` = 首页的简易对话框（半透明、更窄）；`full` = 岗位 / 职责 / 事项页。 */
  variant?: 'simple' | 'full'
  testId?: string
  className?: string
  /** 额外挂在最外层的 `data-*`（测试 / 截图脚本认）。 */
  data?: Record<`data-${string}`, string | undefined>
}): ReactNode {
  return (
    <div
      className={cn(
        'pointer-events-none sticky bottom-0 z-30 mt-auto flex justify-center pt-6 pb-4 md:pb-6',
        variant === 'full' &&
          'bg-gradient-to-b from-transparent via-ws-paper/80 via-45% to-ws-paper',
        className,
      )}
      data-testid={testId}
      data-variant={variant}
      {...data}
    >
      <div
        className={cn(
          'pointer-events-auto flex w-full flex-col gap-2',
          variant === 'simple' ? 'max-w-[640px]' : 'max-w-[760px]',
        )}
      >
        {above}
        {children}
      </div>
    </div>
  )
}
