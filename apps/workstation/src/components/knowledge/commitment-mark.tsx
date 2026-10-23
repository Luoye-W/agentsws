/**
 * WP495（1701）：知识条目里**真写了承诺**（退款 / 退货天数、保修期、赔付 / 补发、价格保证）才挂的小图标。
 * 悬停 / 聚焦出「含承诺，细看一眼」；别的条目一个字都不挂（少字）。
 *
 * 判定在契约里（`hasCommitment`，规则判，不问模型）；这里只管画。jsdom 里 tooltip 打不开，
 * 所以那句话同时写进 `aria-label` 与 `data-hint`（同 `<Hint>`）。
 */
import { Handshake } from 'lucide-react'
import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useApp } from '@/lib/app-context'

export function CommitmentMark({ testId = 'kl-commitment' }: { testId?: string }): ReactNode {
  const { t } = useApp()
  const text = t('kl.card.commitment')
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            // biome-ignore lint/a11y/noNoninteractiveTabindex: 只读标记也要能用键盘看 tooltip
            tabIndex={0}
            role="img"
            aria-label={text}
            data-hint={text}
            data-testid={testId}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-ws-warn outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Handshake aria-hidden className="size-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
