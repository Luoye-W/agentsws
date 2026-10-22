/**
 * WP428（决策 1246 改）：对话记录里 AI **按把握直接答**的那一句下面那一行——「AI 直接答 · 出处：…」，
 * 旁边一颗「这句不该直接答」：点了进学习回路，同类问题以后先转人（`POST …/not-direct`）。
 *
 * 沙盒页（`transcript.tsx`）与「消息」里的网站聊天（`messages/site-chat.tsx`）用同一个。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { type ChatMessageView, flagChatAutoAnswer } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'

export function AutoAnswerMark({
  sessionId,
  message,
  assignment,
}: {
  sessionId: string
  message: ChatMessageView
  assignment?: string | undefined
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const flag = useMutation({
    mutationFn: () => flagChatAutoAnswer(sessionId, message.id, assignment),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['chat'] })
      await client.invalidateQueries({ queryKey: ['chat-widget'] })
    },
  })
  const auto = message.auto_answer
  if (auto === undefined) return null
  const flagged = auto.flagged || flag.isSuccess
  const list = auto.sources.map((s) => s.label).join('、')
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground"
      data-testid="chat-auto-answer-mark"
    >
      <span>
        {t('chat.action.auto_answer')}
        {list === '' ? null : ` · ${t('chat.auto.sources', { list })}`}
      </span>
      {flagged ? (
        <span data-testid="chat-auto-answer-flagged">{t('chat.auto.flagged')}</span>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          className="h-5 px-1.5 text-xs"
          data-testid="chat-auto-answer-flag"
          disabled={flag.isPending}
          onClick={() => {
            flag.mutate()
          }}
        >
          {t('chat.auto.flag')}
        </Button>
      )}
      {flag.error === null ? null : (
        <span role="alert" className="text-destructive">
          {apiErrorText(flag.error, t)}
        </span>
      )}
    </div>
  )
}
