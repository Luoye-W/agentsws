/**
 * WP70（54 §4）：**职责一律归在岗位下面，默认折叠收纳**——一份实现，处处用。
 *
 * 规矩（09-16 Luoye 定，54 §4 的收口）：
 * - 任何列出"人在做什么 / 这家公司有什么"的地方，一律**先岗位、后职责**；
 * - 职责默认折叠，标题旁一个数字（"3 条职责"），点开才展开；
 * - 一个岗位**只有一条**职责时不折叠：直接把那一条的名字当岗位的副标题，
 *   不再出第二层（多一层折叠去看一条，纯属白花认知成本）。
 *
 * 首次设置第 ③ 步（46）那个"岗位在外、职责折叠"的样子就是这件的原型
 * （`components/onboarding/role-picker.tsx`）。
 */
import { ChevronDown, ChevronRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

export interface FoldedDuty {
  id: string
  name: string
}

export function DutyFold({
  duties,
  renderDuty,
  label,
  testId = 'duty-fold',
  defaultOpen = false,
  className,
}: {
  /** 这个岗位下的职责，顺序就是显示顺序。空清单整件不出。 */
  duties: FoldedDuty[]
  /** 展开层里一条职责长什么样；不给就只显示名字（徽章式的地方用得上）。 */
  renderDuty?: (duty: FoldedDuty, index: number) => ReactNode
  /** 折叠条上的话；不给就是「N 条职责」。 */
  label?: string
  /** 折叠条 = `${testId}-toggle`，展开层 = `${testId}`，单条那行 = `${testId}-single`。 */
  testId?: string
  /** 只有"用户刚建完这个岗位"这类场合才默认展开——**默认是收着的**。 */
  defaultOpen?: boolean
  className?: string
}): ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(defaultOpen)

  if (duties.length === 0) return null

  // 只有一条：那一条的名字就是岗位的副标题，没有第二层
  const single = duties[0]
  if (duties.length === 1 && single !== undefined) {
    return (
      <div className={cn('text-sm', className)} data-testid={`${testId}-single`}>
        {renderDuty === undefined ? (
          <span className="text-xs text-muted-foreground">{single.name}</span>
        ) : (
          renderDuty(single, 0)
        )}
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <button
        type="button"
        className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
        onClick={() => {
          setOpen((v) => !v)
        }}
      >
        {open ? (
          <ChevronDown aria-hidden className="size-3.5" />
        ) : (
          <ChevronRight aria-hidden className="size-3.5" />
        )}
        {label ?? t('duty.fold.count', { count: duties.length })}
      </button>
      {open ? (
        <ul className="flex flex-col gap-1" data-testid={testId}>
          {duties.map((duty, index) => (
            <li key={duty.id} data-duty={duty.id}>
              {renderDuty === undefined ? (
                <span className="text-sm">{duty.name}</span>
              ) : (
                renderDuty(duty, index)
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
