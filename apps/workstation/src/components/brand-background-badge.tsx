/**
 * WP215：一个品牌的**后台状态小件**（品牌切换器的每一行、公司页「品牌一览」的每一行用的同一个）。
 *
 * 后台 = 这台电脑替每个品牌按时做的事（巡检、收信、每日计划 / 复盘、自动化任务……），按品牌常驻，
 * 与眼前切在哪个品牌无关。照 36 §7 第四档：**图标 + 数字**，细节进 tooltip——
 *
 * - 数字是在跑的定时任务条数；
 * - 图标三种样子：在跑 = 绿底计时器；急停 = 黄底暂停；品牌停用 = 虚线框、灰掉；
 * - 出错（`errors > 0`）在图标右上角一个红点，tooltip 里带最近那条的标题与原因；
 * - tooltip 一句「最近一次巡检 <本地时间>」（没有就「还没跑过」）+ 下一次时间；文案同时进
 *   `aria-label` 与 `data-hint`（与 `<StatusIcons>` 同一条做法）。
 *
 * 没有 `background`（老服务进程）就整个不画。
 */
import { cn } from 'cn'
import { type LucideIcon, Pause, Timer } from 'lucide-react'
import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { BrandBackgroundView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDateTime } from '@/lib/format'
import type { Lang } from '@/lib/i18n'

type Translate = (key: string, vars?: Record<string, string | number>) => string

const LOOK: Record<BrandBackgroundView['state'], { icon: LucideIcon; className: string }> = {
  running: { icon: Timer, className: 'bg-ws-good-bg text-ws-good' },
  halted: { icon: Pause, className: 'bg-ws-warn-bg text-ws-warn' },
  stopped: {
    icon: Timer,
    className: 'border border-dashed border-ws-muted-fg/60 text-ws-muted-fg opacity-60',
  },
}

/** tooltip / 读屏全文（一行一件事）。 */
export function brandBackgroundText(bg: BrandBackgroundView, t: Translate, lang: Lang): string {
  const lines: string[] = []
  if (bg.state === 'running') lines.push(t('brand.bg.running', { n: bg.scheduled }))
  else if (bg.state === 'stopped') lines.push(t('brand.bg.stopped'))
  else lines.push(bg.halted ? t('brand.bg.halted') : t('brand.bg.global_halted'))
  lines.push(
    bg.last_run_at === undefined
      ? t('brand.bg.never')
      : t('brand.bg.last', { at: formatDateTime(bg.last_run_at, lang) }),
  )
  if (bg.next_run_at !== undefined && bg.state === 'running')
    lines.push(t('brand.bg.next', { at: formatDateTime(bg.next_run_at, lang) }))
  if (bg.errors > 0)
    lines.push(
      bg.last_error === undefined
        ? t('brand.bg.errors_bare', { n: bg.errors })
        : t('brand.bg.errors', {
            n: bg.errors,
            title: bg.last_error.title,
            message: bg.last_error.message,
          }),
    )
  return lines.join('\n')
}

export function BrandBackgroundBadge({
  background,
  focusable = true,
  className,
  testId = 'brand-bg',
}: {
  background: BrandBackgroundView | undefined
  /**
   * 能不能用 Tab 聚焦看 tooltip。放在一个按钮里（品牌切换器那一行）时关掉：按钮里不该再套一个
   * 可聚焦的东西；那时文案仍在 `aria-label` 里，按钮的读屏名带得上。
   */
  focusable?: boolean
  className?: string
  testId?: string
}): ReactNode {
  const { t, lang } = useApp()
  if (background === undefined) return null
  const text = brandBackgroundText(background, t, lang)
  const look = LOOK[background.state]
  const Icon = look.icon
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            {...(focusable ? { tabIndex: 0 } : {})}
            role="img"
            aria-label={text}
            data-hint={text}
            // 36 §7：这是状态，不是说明——减字守卫按状态算
            data-slot="status"
            data-testid={testId}
            data-bg-state={background.state}
            data-errors={background.errors}
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring',
              className,
            )}
          >
            <span
              className={cn(
                'relative inline-flex size-5 items-center justify-center rounded-md',
                look.className,
              )}
            >
              <Icon aria-hidden className="size-3" />
              {background.errors > 0 ? (
                <span
                  aria-hidden
                  data-testid={`${testId}-error-dot`}
                  className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-ws-bad ring-2 ring-background"
                />
              ) : null}
            </span>
            <span
              aria-hidden
              className={cn(
                'text-xs tabular-nums',
                background.state === 'running' ? 'text-foreground' : 'text-ws-muted-fg',
              )}
              data-testid={`${testId}-count`}
            >
              {background.scheduled}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="whitespace-pre-line">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
