/**
 * WP440（docs/108 M9）：一只邮箱上的「有把握就直接回」——开关（缺省开）+「严格 / 适中 / 宽松」。
 * 同在线客服那一处（WP428）：不让填数字，说明进问号。
 *
 * 两处用同一个件：连接页那只邮箱卡（`MailboxSwitches` 里）与「消息渠道」页的邮箱那一块。
 * 和邮箱卡共用一份查询缓存（同一个 queryKey），哪边改了另一边立刻跟上。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Hint } from '@/components/ui/hint'
import { Switch } from '@/components/ui/switch'
import {
  type ChatAutoAnswerStrictnessView,
  getMailboxSwitches,
  type MailboxSwitchesView,
  setMailboxSwitches,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function MailboxAutoReply({
  connectionId,
  assignment,
}: {
  connectionId: string
  assignment?: string | undefined
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const key = ['mailbox-switches', connectionId, assignment ?? '']
  const view = useQuery({
    queryKey: key,
    queryFn: () => getMailboxSwitches(connectionId, assignment),
    retry: false,
  })
  const save = useMutation({
    mutationFn: (input: {
      auto_reply?: boolean
      auto_reply_strictness?: ChatAutoAnswerStrictnessView
    }) => setMailboxSwitches(connectionId, input, assignment),
    onSuccess: (next: MailboxSwitchesView) => {
      client.setQueryData(key, next)
    },
  })
  const data = view.data
  if (data === undefined) return null
  const on = data.auto_reply !== false
  const id = `mailbox-${connectionId}-auto-reply`
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 text-xs"
      data-testid="mailbox-auto-reply"
      data-on={on ? 'true' : 'false'}
    >
      <Switch
        size="sm"
        id={id}
        checked={on}
        disabled={save.isPending}
        aria-label={t('connections.mailbox.auto_reply')}
        data-testid="mailbox-switch-auto_reply"
        onCheckedChange={(next) => {
          save.mutate({ auto_reply: next })
        }}
      />
      <label htmlFor={id}>{t('connections.mailbox.auto_reply')}</label>
      <Hint text={t('connections.mailbox.auto_reply.hint')} />
      {on ? (
        <select
          aria-label={t('chat.window.auto_answer.strictness')}
          className="ml-1 h-7 rounded-md border bg-transparent px-1.5 text-xs"
          value={data.auto_reply_strictness ?? 'balanced'}
          disabled={save.isPending}
          data-testid="mailbox-auto-reply-strictness"
          onChange={(e) => {
            save.mutate({
              auto_reply_strictness: e.target.value as ChatAutoAnswerStrictnessView,
            })
          }}
        >
          {(['strict', 'balanced', 'loose'] as const).map((k) => (
            <option key={k} value={k}>
              {t(`chat.window.auto_answer.${k}`)}
            </option>
          ))}
        </select>
      ) : null}
      {save.error === null ? null : (
        <span role="alert" className="text-xs text-destructive">
          {t('connections.mailbox.failed')}
        </span>
      )}
    </div>
  )
}
