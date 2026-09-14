/**
 * 沙盒页左边那一栏：对话记录（WP57）。
 *
 * 三种角色三种样子，而且**商家那一句中文永远靠边站**：它是内部指导，
 * 不是对客的话——两条红线里的第一条（`support-core/chat/teach.ts`）就是
 * "商家的中文不能出现在访客屏幕上"，界面上也照这条摆，别让人误以为它发出去了。
 */
import { cn } from 'cn'
import type { ChatMessageView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDate } from '@/lib/format'

export function ChatTranscript({ messages }: { messages: ChatMessageView[] }): React.ReactNode {
  const { t, lang } = useApp()
  if (messages.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="chat-transcript-empty">
        {t('chat.transcript.empty')}
      </p>
    )
  }
  return (
    <ol className="flex flex-col gap-3" data-testid="chat-transcript">
      {messages.map((m) => (
        <li
          key={m.id}
          data-testid="chat-message"
          data-role={m.role}
          className={cn(
            'flex flex-col gap-0.5 rounded-md px-3 py-2 text-sm',
            m.role === 'visitor' && 'bg-muted',
            m.role === 'agent' && 'bg-primary/10',
            m.role === 'operator' && 'border border-dashed bg-transparent',
          )}
        >
          <div className="flex flex-wrap items-baseline gap-2 text-[11px] text-muted-foreground">
            <span>{t(`chat.role.${m.role}`)}</span>
            <time dateTime={m.at}>{formatDate(m.at, lang)}</time>
            {m.plan_action === undefined ? null : <span>{t(`chat.action.${m.plan_action}`)}</span>}
          </div>
          <p className="whitespace-pre-wrap">{m.text}</p>
          {m.role === 'operator' ? (
            <p className="text-[11px] text-muted-foreground">{t('chat.role.operator.note')}</p>
          ) : null}
        </li>
      ))}
    </ol>
  )
}
