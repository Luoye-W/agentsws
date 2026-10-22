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
          // WP456-T6：说明一行 13 灰字（界面字那一档；原来 12.5 是半档）
          <p className="mt-0.5 text-ws-ui text-ws-muted-fg">{desc}</p>
        )}
      </div>
      <div className={cn('min-w-0', stacked ? 'w-full' : 'shrink-0')}>{control}</div>
    </div>
  )
}

/**
 * 几选一的小胶囊（主题、语言、动效、内容更新那类两三档）。
 * WP456-T2：换成全站唯一那种分段切换（灰底 + 白块），不再是品牌绿实底；老的引用路径照旧能用。
 */
export { Segmented } from '@/components/design/segmented'
