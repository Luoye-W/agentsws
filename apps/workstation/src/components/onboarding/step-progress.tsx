/**
 * 首次设置的进度条（WP79 ①，46 §1 四步）。
 *
 * 09-17 Luoye 看真机截图后的意见：原来那四个方框标签像四个**按钮**，而它们其实
 * 点不动——一排点不动的按钮比没有它更糟。改成一条真正的进度条：
 *
 * - **圆点 + 连线**：一眼看得出总共几步、现在在哪一步、还剩几步；
 * - **当前步高亮**；
 * - **已完成打勾**：走过的那几步给一个勾，不是一个灰掉的序号——
 *   "做完了"与"还没轮到"是两件事，颜色深浅分不清它们。
 *
 * 只读：它报进度，不当导航。要回上一步走底下那个「上一步」——
 * 一个能点的进度条会让人以为可以跳着填，而第 ④ 步那张清单是按前三步算出来的。
 */
import { Check } from 'lucide-react'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 这一步相对于当前进度的位置——测试与样式都认这三个词。 */
export type StepState = 'done' | 'current' | 'todo'

export function StepProgress({
  steps,
  step,
}: {
  /** 四步的 i18n key，按顺序。 */
  steps: readonly string[]
  /** 现在在第几步（0 开始）。 */
  step: number
}): React.ReactNode {
  const { t } = useApp()

  return (
    <ol className="flex items-start" data-testid="onboarding-steps">
      {steps.map((key, i) => {
        const state: StepState = i < step ? 'done' : i === step ? 'current' : 'todo'
        const first = i === 0
        const last = i === steps.length - 1
        return (
          <li
            key={key}
            data-testid="onboarding-step"
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
            className="flex flex-1 flex-col items-center gap-1.5"
          >
            <div className="flex w-full items-center">
              {/* 连线：左半段走过了就是实色（第一个没有左半段） */}
              <span
                aria-hidden
                className={cn(
                  'h-px flex-1',
                  first ? 'bg-transparent' : state === 'todo' ? 'bg-border' : 'bg-primary',
                )}
              />
              <span
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] leading-none',
                  state === 'done' && 'border-primary bg-primary text-primary-foreground',
                  state === 'current' && 'border-primary text-primary',
                  state === 'todo' && 'border-border text-muted-foreground',
                )}
              >
                {state === 'done' ? <Check aria-hidden className="size-3" /> : i + 1}
                {/* 打勾是画出来的，读屏的人得听见它 */}
                {state === 'done' ? (
                  <span className="sr-only">{t('onboarding.step.done')}</span>
                ) : null}
              </span>
              <span
                aria-hidden
                className={cn(
                  'h-px flex-1',
                  last ? 'bg-transparent' : state === 'done' ? 'bg-primary' : 'bg-border',
                )}
              />
            </div>
            <span
              className={cn(
                'px-1 text-center text-xs',
                state === 'current' ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {t(key)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
