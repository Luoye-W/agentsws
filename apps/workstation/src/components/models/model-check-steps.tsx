/**
 * 模型验证三步的小清单（WP127）：连得上 → 文字能回 → 看得懂图。
 *
 * 向导第 ① 步与设置页「模型」那一行**共用这一个**——同一件事两处画法不一样，
 * 用户会以为是两种检查。三个小勾叉比一句"没通"更说得清卡在哪儿（图形化、减字）。
 */
import { Check, Eye, type LucideIcon, MessageSquareText, Minus, Plug, X } from 'lucide-react'
import { StatusIcons, type StatusItem, type StatusState } from '@/components/design'
import type { ModelCheckStepView, ModelTestResult } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDateTime } from '@/lib/format'
import type { Lang } from '@/lib/i18n'
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

/**
 * WP214（36 §7 第四档）：配好之后，三步不再是一行字，而是一排**状态小图标**
 * （连通 / 文字 / 看图，每个四态：通 / 不通 / 没测 / 测试中）。
 *
 * 向导第 ① 步（第一次连接，说明在那里给）仍用上面的 {@link ModelCheckSteps}；
 * 设置页已配的卡、「加一个」里已登录的 DeepSeek 卡用这一排。
 *
 * - `result` 为 undefined（从没测过）→ 三个都是「没测」；
 * - `pending`（正在测）→ 三个都是「测试中」；
 * - 老结果没有 `steps`：通了 = 三个都通；没通 = 连通那一格不通、后两格没测。
 * - tooltip 一句：上次测 · 耗时 · token（服务端那句原话里带着 token 数）。
 */
const CAP_ICON: Record<ModelCheckStepView['step'], LucideIcon> = {
  connect: Plug,
  text: MessageSquareText,
  vision: Eye,
}

const STEPS: ModelCheckStepView['step'][] = ['connect', 'text', 'vision']

function stepState(
  result: ModelTestResult | undefined,
  step: ModelCheckStepView['step'],
): StatusState {
  if (result === undefined) return 'unknown'
  const found = result.steps?.find((s) => s.step === step)
  if (found !== undefined) return found.ok ? 'ok' : found.skipped === true ? 'unknown' : 'fail'
  if (result.ok) return 'ok'
  return step === 'connect' ? 'fail' : 'unknown'
}

/** 这次验证的细节一句：上次测 · 耗时（· 服务端原话，里面有 token 数）。 */
export function modelTestMeta(
  result: ModelTestResult | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
  lang: Lang,
): string | undefined {
  if (result === undefined) return undefined
  const head = [
    t('models.status.last', { at: formatDateTime(result.checked_at, lang) }),
    ...(result.duration_ms === undefined ? [] : [`${result.duration_ms}ms`]),
    ...(result.model === undefined ? [] : [result.model]),
  ].join(' · ')
  return result.detail === undefined ? head : `${head}\n${result.detail}`
}

export function modelStatusItems(
  result: ModelTestResult | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
  lang: Lang,
  pending = false,
): StatusItem[] {
  const meta = pending ? undefined : modelTestMeta(result, t, lang)
  return STEPS.map((step) => {
    const state: StatusState = pending ? 'pending' : stepState(result, step)
    const skipped = result?.steps?.find((s) => s.step === step)?.skipped === true
    return {
      key: step,
      label: t(`models.cap.${step}`),
      state,
      icon: CAP_ICON[step],
      ...(state === 'unknown' && skipped ? { stateText: t('models.check.skipped') } : {}),
      ...(meta === undefined ? {} : { detail: meta }),
    }
  })
}

/** 已配的卡上那一排：连通 / 文字 / 看图。 */
export function ModelStatusIcons({
  result,
  pending = false,
  className,
}: {
  result: ModelTestResult | undefined
  pending?: boolean
  className?: string
}): React.ReactNode {
  const { t, lang } = useApp()
  return (
    <StatusIcons
      items={modelStatusItems(result, t, lang, pending)}
      label={t('models.status.label')}
      testId="model-status"
      {...(className === undefined ? {} : { className })}
    />
  )
}
