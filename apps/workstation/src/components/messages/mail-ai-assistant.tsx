/**
 * WP208（Luoye 09-30）：**邮件助手搬进「消息」页的阅读区**。
 *
 * Luoye：「为什么邮件助手会放到这个第三栏？应该很自然地集成在消息里，岗位 / 职责又不需要这个。」
 *
 * 这一版是**最小搬家**（WP205 在出消息中心的新设计，那时再重排）：
 *
 * - 正文就是原来第三栏那个面板（`rail/panels/mail-assistant-panel.tsx` 的 `MailAssistantPanel`）：
 *   这封信说什么 · 回复建议（点了进写信框，人自己点发送）· 发件人是谁 · 相关待办；
 * - 头上多一行**分拣结果**（这封信归谁、急不急；为什么这么分放进问号）——它本来就在信上
 *   （`MessageRecord.triage`），以前只有「待确认」那一栏看得到；
 * - **只在看信时出现**（阅读区里，信的下面、回复按钮上面），一块可收起。收起记在内存里、跨信保持
 *   （换一封信不会又弹开），刷新回到展开：它是"这会儿不想看"，不是一条设置。
 * - **分拣那一行收起时也在**（它就在信上，不花钱）；摘要与建议那一段**展开才请求**——
 *   服务端是被问到那一刻才生成建议的（63 §8「按需生成」），收起的人一个 token 都不花。
 * - 它不是卡（36 §2.2b）：不要人拍板，只是看着信时顺手的参考。
 */
import type { MessageRecord } from '@agentsws/contracts'
import { ChevronDown, Sparkles } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { StatusPill } from '@/components/design'
import { MailAssistantPanel } from '@/components/rail/panels/mail-assistant-panel'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 分拣那一行：归谁 · 急不急（· 拿不准）；为什么放进问号。没分拣过的信不画这一行。 */
function TriageLine({ message }: { message: MessageRecord }): ReactNode {
  const { t } = useApp()
  const triage = message.triage
  if (triage === undefined) return null
  const why = [t(`messages.ai.triage.by.${triage.by}`), ...triage.reasons].join('；')
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 text-[12px]"
      data-testid="mail-ai-triage"
      data-route={triage.route}
    >
      <span className="text-ws-muted-fg">{t('messages.ai.triage')}</span>
      <StatusPill tone={triage.route === 'inbox' ? 'neutral' : 'info'}>
        {t(`messages.ai.triage.route.${triage.route}`)}
      </StatusPill>
      <StatusPill tone={triage.priority === 'high' ? 'warn' : 'neutral'}>
        {t(`messages.ai.triage.priority.${triage.priority}`)}
      </StatusPill>
      {triage.suggested_route === undefined ? null : (
        <StatusPill tone="warn">{t('messages.ai.triage.unsure')}</StatusPill>
      )}
      <Hint text={why} testId="mail-ai-triage-why" />
    </div>
  )
}

/** 收起 / 展开跨信保持（只在内存里；刷新回到展开）。 */
let rememberedOpen = true

export function MailAiAssistant({ message }: { message: MessageRecord }): ReactNode {
  const { t } = useApp()
  const [open, setOpenState] = useState(rememberedOpen)
  const setOpen = (update: (v: boolean) => boolean): void => {
    setOpenState((v) => {
      const next = update(v)
      rememberedOpen = next
      return next
    })
  }
  return (
    <section
      className="flex flex-col gap-3 rounded-[14px] border border-ws-line bg-ws-surface p-3"
      data-testid="mail-ai"
      data-open={open ? 'true' : 'false'}
    >
      <header className="flex items-center gap-2">
        <Sparkles aria-hidden className="size-4 text-ws-brand" />
        <h2 className="text-[13px] font-medium">{t('messages.ai.title')}</h2>
        <button
          type="button"
          aria-expanded={open}
          aria-label={t('messages.ai.toggle')}
          title={t('messages.ai.toggle')}
          data-testid="mail-ai-toggle"
          className="ml-auto rounded p-1 text-ws-muted-fg hover:bg-ws-card"
          onClick={() => {
            setOpen((v) => !v)
          }}
        >
          <ChevronDown
            aria-hidden
            className={cn('size-4 transition-transform', !open && '-rotate-90')}
          />
        </button>
      </header>
      <TriageLine message={message} />
      {open ? <MailAssistantPanel /> : null}
    </section>
  )
}
