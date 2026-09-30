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
 *
 * WP212（docs/88 §5.1b）：它是**兜底处理的助手**——
 * - 分拣那一行多一格「类型」胶囊，点开改判；
 * - **没人接的**信：下面是三个建议（交给 X ▾ / 只是通知 / 我自己回），摘要与回复建议照旧展开就请求；
 * - **岗位在办的**信：只挂「X 在办 · 有 N 张卡等你 →」，**不请求、不生成建议**（不花 token）；
 * - 只是通知 / 你处理过的：默认收起（不请求），想看再点开。
 */
import type { MessageRecord } from '@agentsws/contracts'
import { ChevronDown, Sparkles } from 'lucide-react'
import { Component, type ReactNode, useState } from 'react'
import { Link } from 'react-router-dom'
import { StatusPill } from '@/components/design'
import { MailAssistantPanel } from '@/components/rail/panels/mail-assistant-panel'
import { Hint } from '@/components/ui/hint'
import type { MessageThreadView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import { HandActions, type HandNotice, positionName, useMessageOverview } from './hand-actions'
import { KindChip } from './kind-chip'

/**
 * WP208（与 WP204 接缝）：助手出了错**只折它自己这一块**。
 *
 * 它挂在阅读区里、和回复 / 归档 / 删除那排按钮同一棵树上——没有这一层，助手那边一个异常
 * （接口回的形状不对、模型那头抽风）会把整个阅读区连同那排按钮一起卸掉。换一封信（`key`）就重试。
 */
class AssistantBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** 分拣那一行：归谁 · 急不急（· 拿不准）；为什么放进问号。没分拣过的信不画这一行。 */
function TriageLine({
  message,
  view,
  onNotice,
}: {
  message: MessageRecord
  view?: MessageThreadView | undefined
  onNotice?: ((n: HandNotice) => void) | undefined
}): ReactNode {
  const { t } = useApp()
  const triage = message.triage
  if (triage === undefined) return null
  const kind = triage.kind ?? view?.kind
  const why = [t(`messages.ai.triage.by.${triage.by}`), ...triage.reasons].join('；')
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 text-[12px]"
      data-testid="mail-ai-triage"
      data-route={triage.route}
    >
      <span className="text-ws-muted-fg">{t('messages.ai.triage')}</span>
      {kind === undefined ? null : (
        <KindChip
          messageId={message.id}
          kind={kind}
          confidence={triage.kind_confidence ?? triage.confidence}
          by={triage.kind_by}
          onDone={(text, tone) => {
            onNotice?.({ text, tone })
          }}
        />
      )}
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

export function MailAiAssistant({
  message,
  view,
  onReplySelf,
  onNotice,
}: {
  message: MessageRecord
  /** WP212：这条会话归谁（没给 = 老行为：照旧展开）。 */
  view?: MessageThreadView
  /** 「我自己回」：开写信框。 */
  onReplySelf?: () => void
  onNotice?: (n: HandNotice) => void
}): ReactNode {
  const { t, lang } = useApp()
  const overview = useMessageOverview()
  const claim = view?.claim
  const handedTo = view?.handed_to
  const atPosition =
    claim === 'handed' && handedTo !== undefined && handedTo !== 'me' && handedTo !== 'notice'
  // 没人接的（或还不知道归谁的）照旧按记住的开合；通知 / 你处理过的默认收起——收起就不请求
  const autoOpen = claim === undefined || claim === 'unclaimed'
  const [open, setOpenState] = useState(rememberedOpen && autoOpen)
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
      data-open={open && !atPosition ? 'true' : 'false'}
      data-claim={claim}
    >
      <header className="flex items-center gap-2">
        <Sparkles aria-hidden className="size-4 text-ws-brand" />
        <h2 className="text-[13px] font-medium">{t('messages.ai.title')}</h2>
        {atPosition ? null : (
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
        )}
      </header>
      <TriageLine message={message} view={view} onNotice={onNotice} />
      {atPosition ? (
        <div className="flex items-center gap-2 text-[12px]" data-testid="mail-ai-handed">
          <span className="text-ws-muted-fg">
            {t('messages.ai.handed', {
              name: positionName(overview.data?.positions, handedTo, lang),
            })}
          </span>
          {(view?.open_card_count ?? 0) > 0 ? (
            <Link
              to={view?.card_link ?? '/'}
              className="ml-auto font-medium text-ws-brand hover:underline"
              data-testid="mail-ai-cards"
            >
              {t('messages.claim.cards', { n: view?.open_card_count ?? 0 })} →
            </Link>
          ) : null}
        </div>
      ) : null}
      {claim === 'unclaimed' ? (
        <HandActions
          messageId={view?.claim_message_id ?? message.id}
          kind={view?.kind}
          suggest={view?.suggest}
          onDone={(n) => {
            onNotice?.(n)
          }}
          onSelf={() => {
            onReplySelf?.()
          }}
        />
      ) : null}
      {open && !atPosition ? (
        <AssistantBoundary
          key={message.id}
          fallback={
            <p className="text-[12px] text-ws-muted-fg" data-testid="mail-ai-failed">
              {t('messages.ai.failed')}
            </p>
          }
        >
          <MailAssistantPanel />
        </AssistantBoundary>
      ) : null}
    </section>
  )
}
