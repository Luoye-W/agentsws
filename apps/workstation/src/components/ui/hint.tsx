/**
 * WP43 ②：解释性文字的去处。
 *
 * 界面上原来铺了太多灰字——每个输入框底下一行、每张卡片里一段、每页顶上三句。
 * 规则收成三档（36 §7）：
 *
 * - **可见**：安全承诺、错误与状态、空态。这三类必须一眼看见，不许藏。
 * - **tooltip**：「为什么」「怎么来的」「填什么格式」——`<Hint>`，一个 14px 的问号，
 *   hover / focus 才出。
 * - **折叠区**：整段的准备步骤、清单（`<details>`），点开才看。
 *
 * jsdom 里 Radix 的 tooltip 打不开（没有真实指针与 portal 动画），所以文案同时
 * 写进 `aria-label` 与 `data-hint`——读屏和测试都拿得到，不靠 tooltip 打开。
 * 每个 Hint 自带 Provider：页面在测试里是单独渲染的，外面不一定有 shell。
 */
import { cn } from 'cn'
import { CircleHelp, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/** 一个问号图标；hover / focus 出 tooltip。放在标题、字段名、列表项后面。 */
export function Hint({
  text,
  className,
  testId,
}: {
  text: string
  className?: string
  /** 原来那段灰字上挂过 `data-testid` 的，把它挪到问号上，断言照旧找得到。 */
  testId?: string
}): ReactNode {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-slot="hint"
            data-hint={text}
            aria-label={text}
            {...(testId === undefined ? {} : { 'data-testid': testId })}
            // 在 <label> 里点问号不该顺带聚焦输入框
            onClick={(e) => {
              e.preventDefault()
            }}
            className={cn(
              'inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
              className,
            )}
          >
            <CircleHelp aria-hidden className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * 安全承诺：「不经 AI、不进日志」这类。**不藏**——压成一行，前面一个盾牌。
 *
 * 这是 §2 例外的第一类：用户凭它决定要不要把密钥贴进来，藏了就是失职。
 */
export function SafetyNote({ text, className }: { text: string; className?: string }): ReactNode {
  return (
    <p
      data-slot="safety-note"
      className={cn('flex items-start gap-1.5 text-[11px] text-muted-foreground', className)}
    >
      <ShieldCheck aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>{text}</span>
    </p>
  )
}
