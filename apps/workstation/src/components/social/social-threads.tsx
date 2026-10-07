/**
 * WP255（决策 144）：社群线程列表——社群组职责视图栏后面那个「群里的帖子」快捷视图。
 *
 * 这条渠道里还没处理完的帖子 / 评论 / 私信，一行一条：谁、在哪个号 / 群、判成哪类、原话一截，
 * 外加一个「回复」（出一张回帖卡，批了才发）。转给客服的那些不在这里（球在客服那边，56 的边界）。
 *
 * 正文是外部文本：原样显示（截两行），不渲染成 markdown、不当链接。
 */
import { useQuery } from '@tanstack/react-query'
import { Mail, MessageSquare, MessagesSquare } from 'lucide-react'
import type { ReactNode } from 'react'
import { WsTag } from '@/components/design'
import { ReplyButton } from '@/components/social/reply-button'
import { EmptyLine } from '@/components/ui/empty-line'
import { Hint } from '@/components/ui/hint'
import type { SocialChannelId } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { getSocialThreads, type SocialThreadRowData } from '@/lib/social-reply-api'

const SURFACE_ICON = {
  thread: MessagesSquare,
  comment: MessageSquare,
  dm: Mail,
} as const

function Row({ row, assignment }: { row: SocialThreadRowData; assignment: string }): ReactNode {
  const { t } = useApp()
  const Icon = SURFACE_ICON[row.surface]
  return (
    <li
      className="flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2"
      data-testid="social-thread"
      data-id={row.id}
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <Icon
          className="size-3.5 shrink-0 text-ws-muted-fg"
          aria-label={t(`threads.surface.${row.surface}`)}
        />
        <span className="shrink-0 font-medium">{row.author_handle}</span>
        <span className="min-w-0 truncate text-xs text-ws-muted-fg">{row.account_name}</span>
        {row.triage === undefined ? null : (
          <WsTag className="ml-auto shrink-0">{t(`threads.triage.${row.triage}`)}</WsTag>
        )}
      </div>
      <p className="line-clamp-2 pl-5 text-sm text-ws-body" title={row.text}>
        {row.text}
      </p>
      <div className="flex flex-wrap items-center gap-1.5 pl-5">
        <ReplyButton threadId={row.id} assignment={assignment} />
      </div>
    </li>
  )
}

export function SocialThreads({
  assignment,
  channel,
}: {
  assignment: string
  channel: SocialChannelId
}): ReactNode {
  const { t } = useApp()
  const q = useQuery({
    queryKey: ['social-threads', assignment, channel],
    queryFn: () => getSocialThreads(channel, assignment),
  })
  const rows = q.data?.rows ?? []
  return (
    <div className="flex flex-col gap-2" data-testid="social-threads">
      <div className="flex items-center gap-1.5 px-1 text-xs text-ws-muted-fg">
        <span className="rounded-full bg-ws-surface px-1.5 text-[11px]">{rows.length}</span>
        <Hint text={t('threads.hint')} />
      </div>
      {q.isSuccess && rows.length === 0 ? (
        <EmptyLine
          icon={<MessagesSquare className="size-4" aria-hidden />}
          text={t('threads.empty')}
        />
      ) : null}
      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <Row key={row.id} row={row} assignment={assignment} />
        ))}
      </ul>
    </div>
  )
}
