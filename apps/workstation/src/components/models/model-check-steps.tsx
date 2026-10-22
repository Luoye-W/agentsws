/**
 * 模型验证三步的小清单（WP127）：连得上 → 文字能回 → 看得懂图。
 *
 * 向导第 ① 步与设置页「模型」那一行**共用这一个**——同一件事两处画法不一样，
 * 用户会以为是两种检查。三个小勾叉比一句"没通"更说得清卡在哪儿（图形化、减字）。
 */
import {
  Check,
  Eye,
  Loader2,
  type LucideIcon,
  MessageSquareText,
  Minus,
  Plug,
  X,
} from 'lucide-react'
import type { StatusItem, StatusState } from '@/components/design'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs', className)}
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
              ? 'text-ws-good'
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

/**
 * WP426（Luoye 10-19）：已配那一行的状态改成**一枚看得懂的标签**——原来是插头 / 对话 / 眼睛三个
 * 小图标，没测过时各带一道减号，没人猜得出意思。现在一句人话（「能用 · 能看图」「还没测」「连不上」），
 * 颜色跟着好坏走；三步各自的结果、上次测 · 耗时 · token 进 tooltip（hover / 键盘聚焦都出）。
 *
 * 名字沿用 `ModelStatusIcons`（向导第 ① 步、DeepSeek 账号那一块都用它），三处一起变。
 */
export type ModelStatusKind =
  | 'testing'
  | 'untested'
  | 'ok_vision'
  | 'ok_no_vision'
  | 'ok'
  | 'no_connect'
  | 'no_text'
  | 'failed'

export function modelStatusKind(
  result: ModelTestResult | undefined,
  pending = false,
): ModelStatusKind {
  if (pending) return 'testing'
  if (result === undefined) return 'untested'
  const connect = stepState(result, 'connect')
  const text = stepState(result, 'text')
  const vision = stepState(result, 'vision')
  if (connect === 'fail') return 'no_connect'
  if (text === 'fail') return 'no_text'
  if (vision === 'ok') return 'ok_vision'
  if (vision === 'fail') return 'ok_no_vision'
  return result.ok || text === 'ok' ? 'ok' : 'failed'
}

const KIND_TONE: Record<ModelStatusKind, string> = {
  testing: 'bg-ws-info-bg text-ws-info',
  untested: 'border border-dashed border-ws-muted-fg/50 text-ws-muted-fg',
  ok_vision: 'bg-ws-good-bg text-ws-good',
  ok: 'bg-ws-good-bg text-ws-good',
  ok_no_vision: 'bg-ws-warn-bg text-ws-warn',
  no_connect: 'bg-ws-bad-bg text-ws-bad',
  no_text: 'bg-ws-bad-bg text-ws-bad',
  failed: 'bg-ws-bad-bg text-ws-bad',
}

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
  const kind = modelStatusKind(result, pending)
  const steps = STEPS.map((step) => {
    const state = pending ? 'pending' : stepState(result, step)
    return `${t(`models.cap.${step}`)}：${t(`status.${state}`)}`
  }).join(' · ')
  const meta = pending ? undefined : modelTestMeta(result, t, lang)
  const tip = meta === undefined ? steps : `${steps}\n${meta}`
  const label = t(`models.status.${kind}`)
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            // biome-ignore lint/a11y/noNoninteractiveTabindex: 只读状态也要能用键盘看 tooltip
            tabIndex={0}
            role="status"
            aria-label={`${label}。${tip}`}
            data-hint={tip}
            data-slot="status"
            data-testid="model-status"
            data-kind={kind}
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring',
              KIND_TONE[kind],
              className,
            )}
          >
            {kind === 'testing' ? (
              <Loader2 aria-hidden className="size-3 animate-spin" />
            ) : kind === 'untested' ? null : (
              <span aria-hidden className="size-1.5 rounded-full bg-current" />
            )}
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent className="whitespace-pre-line">{tip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
