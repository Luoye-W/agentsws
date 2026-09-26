/**
 * 模型验证三步的小清单（WP127）：连得上 → 文字能回 → 看得懂图。
 *
 * 向导第 ① 步与设置页「模型」那一行**共用这一个**——同一件事两处画法不一样，
 * 用户会以为是两种检查。三个小勾叉比一句"没通"更说得清卡在哪儿（图形化、减字）。
 */
import { Check, Minus, X } from 'lucide-react'
import type { ModelCheckStepView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

export function ModelCheckSteps({
  steps,
  className,
}: {
  steps: readonly ModelCheckStepView[] | undefined
  className?: string
}): React.ReactNode {
  const { t } = useApp()
  if (steps === undefined || steps.length === 0) return null
  return (
    <ol
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]', className)}
      // WP156：这是结果（三个小勾叉），不是"怎么做"的步骤清单——减字守卫按状态算
      data-slot="status"
      data-testid="model-check-steps"
    >
      {steps.map((s) => (
        <li
          key={s.step}
          data-step={s.step}
          data-ok={s.ok ? 'true' : 'false'}
          title={s.skipped === true ? t('models.check.skipped') : undefined}
          className={cn(
            'flex items-center gap-1',
            s.ok
              ? 'text-emerald-600 dark:text-emerald-400'
              : s.skipped === true
                ? 'text-muted-foreground'
                : 'text-destructive',
          )}
        >
          {s.ok ? (
            <Check aria-hidden className="size-3" />
          ) : s.skipped === true ? (
            <Minus aria-hidden className="size-3" />
          ) : (
            <X aria-hidden className="size-3" />
          )}
          {t(`models.check.${s.step}`)}
        </li>
      ))}
    </ol>
  )
}
