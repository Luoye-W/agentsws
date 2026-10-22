/**
 * WP440（docs/108 M9）：AI **按把握直接回**的那封邮件下面那一行——「AI 直接回 · 出处：…」，
 * 旁边一颗「这封不该直接回」：点了进学习回路（与在线客服「这句不该直接答」同一份），同类以后先给你批。
 *
 * 两处用同一个：消息页「全部」里那条会话（`pages/messages.tsx`）与客服岗位对话里那张已发的回信卡
 * （`matter-timeline.tsx`）。样子照聊天那一个（`chat/auto-answer-mark.tsx`）。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { flagMessageAutoReply } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'

export function EmailAutoReplyMark({
  approvalItemId,
  sources,
  flagged = false,
  excerpt,
  assignment,
}: {
  approvalItemId: string
  sources: readonly { label: string }[]
  flagged?: boolean
  /** 发出去那封的开头一段（消息页里那封还没同步回来时，靠它对得上）。 */
  excerpt?: string | undefined
  assignment?: string | undefined
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const flag = useMutation({
    mutationFn: () => flagMessageAutoReply(approvalItemId, assignment),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['messages'] })
    },
  })
  const done = flagged || flag.isSuccess
  const list = sources.map((s) => s.label).join('、')
  return (
    <div
      className="flex flex-col gap-0.5 text-xs text-muted-foreground"
      data-testid="email-auto-reply-mark"
      data-card={approvalItemId}
    >
      {excerpt === undefined || excerpt === '' ? null : (
        <p className="line-clamp-2 text-[12px] text-ws-body">{excerpt}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span>
          {t('messages.auto_reply.mark')}
          {list === '' ? null : ` · ${t('messages.auto_reply.sources', { list })}`}
        </span>
        {done ? (
          <span data-testid="email-auto-reply-flagged">{t('messages.auto_reply.flagged')}</span>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            className="h-5 px-1.5 text-xs"
            data-testid="email-auto-reply-flag"
            disabled={flag.isPending}
            onClick={() => {
              flag.mutate()
            }}
          >
            {t('messages.auto_reply.flag')}
          </Button>
        )}
        {flag.error === null ? null : (
          <span role="alert" className="text-destructive">
            {apiErrorText(flag.error, t)}
          </span>
        )}
      </div>
    </div>
  )
}
