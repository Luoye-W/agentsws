/**
 * WP214（36 §7 第四档，Luoye 09-30）：**状态用图标，说明只在第一次**。
 *
 * 原来每张配好的卡下面一整行「通了：连得上、文字能回、图也看得懂（用了 434 个 token）· 模型 id · 2099ms」，
 * 再加一行「✓连得上 ✓文字能回 ✓看得懂图」——同一件事说两遍，全是字。现在收成**一排小图标**：
 *
 * - 每个图标是一项能力（连通 / 文字 / 看图 / 工具 / 余额…），图标本身说"这是哪一项"；
 * - 四态：**通 / 不通 / 没测 / 测试中**。颜色 + 形状双编码（色弱也分得清）：
 *   通 = 绿底 + 右下角一个勾；不通 = 红底 + 一个叉；没测 = 虚线框、没有底色 + 一道横；
 *   测试中 = 蓝底 + 转圈；
 * - 细节（上次测 · 耗时 · token、地址）进 tooltip，hover / 键盘聚焦都出；文案同时写进
 *   `aria-label` 与 `data-hint`（读屏拿得到，jsdom 里也断言得了——与 `<Hint>` 同一条做法）；
 * - 明暗两套：颜色全走 `--ws-*` 令牌（`index.css` 里深浅各一套），角标的字用 `text-background`。
 *
 * 整行结果文字不再常显：只在**刚点完测试的那一下**（{@link FRESH_MS} 内）以小字出现（{@link useFresh}）；
 * 失败原因常显一句人话——那是「错误与状态」，36 §7 规定必须一眼可见。
 */
import { cn } from 'cn'
import { Check, Loader2, type LucideIcon, Minus, X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useApp } from '@/lib/app-context'

/** 四态：通 / 不通 / 没测 / 测试中。 */
export type StatusState = 'ok' | 'fail' | 'unknown' | 'pending'

export const STATUS_STATES: readonly StatusState[] = ['ok', 'fail', 'unknown', 'pending']

export interface StatusItem {
  /** 稳定标识（测试按它找：`data-key`）。 */
  key: string
  /** 这一项是什么（"连通" / "文字" / "看图" / "余额"）——tooltip 与读屏的第一截。 */
  label: string
  state: StatusState
  /** 这一项的图标（认得出是哪一项）。 */
  icon: LucideIcon
  /** 状态那半句；不给就用四态的通用词（通 / 不通 / 没测 / 测试中）。 */
  stateText?: string
  /** tooltip 里的细节：上次测 · 耗时 · token、地址这类。 */
  detail?: string
  /** 图标旁边常显的一个短数字（例如余额 ¥28.11）——数字不算说明字。 */
  value?: string
}

/** 每一态的底色与前景（令牌，深浅各一套）。 */
const BOX: Record<StatusState, string> = {
  ok: 'bg-ws-good-bg text-ws-good',
  fail: 'bg-ws-bad-bg text-ws-bad',
  unknown: 'border border-dashed border-ws-muted-fg/60 text-ws-muted-fg',
  pending: 'bg-ws-info-bg text-ws-info',
}

/** 角标：形状是第二道编码（勾 / 叉 / 横 / 转圈）。 */
const MARK: Record<StatusState, { icon: LucideIcon; className: string }> = {
  ok: { icon: Check, className: 'bg-ws-good' },
  fail: { icon: X, className: 'bg-ws-bad' },
  unknown: { icon: Minus, className: 'bg-ws-muted-fg' },
  pending: { icon: Loader2, className: 'bg-ws-info [&>svg]:animate-spin' },
}

/** 一个图标的 tooltip / 读屏全文。 */
export function statusText(item: StatusItem, stateWord: string): string {
  const head = `${item.label}：${item.stateText ?? stateWord}`
  const withValue = item.value === undefined ? head : `${head} ${item.value}`
  return item.detail === undefined || item.detail === ''
    ? withValue
    : `${withValue}\n${item.detail}`
}

/** 一排状态小图标。空数组不画。 */
export function StatusIcons({
  items,
  label,
  className,
  testId = 'status-icons',
}: {
  items: readonly StatusItem[]
  /** 整排的读屏名（"验证结果"）。 */
  label?: string
  className?: string
  testId?: string
}): ReactNode {
  const { t } = useApp()
  if (items.length === 0) return null
  return (
    <TooltipProvider>
      <ul
        className={cn('flex flex-wrap items-center gap-1.5', className)}
        // 36 §7：这是状态，不是说明——减字守卫按状态算
        data-slot="status"
        data-testid={testId}
        {...(label === undefined ? {} : { 'aria-label': label })}
      >
        {items.map((item) => (
          <StatusIconItem key={item.key} item={item} stateWord={t(`status.${item.state}`)} />
        ))}
      </ul>
    </TooltipProvider>
  )
}

function StatusIconItem({ item, stateWord }: { item: StatusItem; stateWord: string }): ReactNode {
  const text = statusText(item, stateWord)
  const Icon = item.icon
  const mark = MARK[item.state]
  const Mark = mark.icon
  return (
    <li className="flex items-center gap-1" data-key={item.key} data-state={item.state}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            // 可键盘聚焦：Tab 到它就出 tooltip（36 §7：hover / focus 才出）
            // biome-ignore lint/a11y/noNoninteractiveTabindex: 只读状态也要能用键盘看 tooltip
            tabIndex={0}
            role="img"
            aria-label={text}
            data-hint={text}
            data-testid="status-icon"
            data-key={item.key}
            data-state={item.state}
            className={cn(
              'relative inline-flex size-6 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring',
              BOX[item.state],
            )}
          >
            <Icon aria-hidden className="size-3.5" />
            <span
              aria-hidden
              className={cn(
                'absolute -right-1 -bottom-1 inline-flex size-3 items-center justify-center rounded-full text-background ring-2 ring-background',
                mark.className,
              )}
            >
              <Mark className="size-2" strokeWidth={3.5} />
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="whitespace-pre-line">{text}</TooltipContent>
      </Tooltip>
      {item.value === undefined ? null : (
        <span className="ws-num text-xs tabular-nums" data-slot="data" data-testid="status-value">
          {item.value}
        </span>
      )}
    </li>
  )
}

/**
 * 技术信息（地址 / 模型 id / 路径）放 tooltip：卡上只留一个人认得的短标签，hover / 聚焦看全的。
 * 文案同样进 `aria-label` 与 `data-hint`。
 */
export function InfoTip({
  text,
  children,
  className,
  testId,
}: {
  text: string
  children: ReactNode
  className?: string
  testId?: string
}): ReactNode {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            // biome-ignore lint/a11y/noNoninteractiveTabindex: 只读信息也要能用键盘看 tooltip
            tabIndex={0}
            data-slot="badge"
            data-hint={text}
            {...(testId === undefined ? {} : { 'data-testid': testId })}
            className={cn(
              'rounded outline-none focus-visible:ring-2 focus-visible:ring-ring',
              className,
            )}
          >
            {children}
            <span className="sr-only">{` (${text})`}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="whitespace-pre-line">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** 刚点完测试之后，结果小字显示多久（36 §7 第四档：两分钟）。 */
export const FRESH_MS = 120_000

/**
 * 「刚发生」：`at`（毫秒时间戳）之后 {@link FRESH_MS} 以内为 true，到点自己翻成 false（重画一次）。
 * `at` 为 undefined（这一次打开页面没点过测试）一律 false——上次测的结果只在图标的 tooltip 里。
 */
export function useFresh(at: number | undefined, ms: number = FRESH_MS): boolean {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (at === undefined) return
    setNow(Date.now())
    const left = at + ms - Date.now()
    if (left <= 0) return
    const timer = setTimeout(() => {
      setNow(Date.now())
    }, left + 50)
    return () => {
      clearTimeout(timer)
    }
  }, [at, ms])
  return at !== undefined && now - at < ms
}
