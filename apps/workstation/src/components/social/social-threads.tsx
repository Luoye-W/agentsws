/**
 * WP255（决策 144）：社群线程列表——社群组职责视图栏后面那个「群里的帖子」快捷视图。
 *
 * 这条渠道里还没处理完的帖子 / 评论 / 私信，一行一条：谁、在哪个号 / 群、判成哪类、原话一截，
 * 外加一个「回复」（出一张回帖卡，批了才发）。转给客服的那些不在这里（球在客服那边，56 的边界）。
 *
 * 正文是外部文本：原样显示（截两行），不渲染成 markdown、不当链接。
 *
 * WP256（决策 147）：Discord 登记过的频道按频率自动拉新消息、Reddit 自家版新帖读队列时顺手拉进来。
 * 空态按渠道照实说：没连上（去连接页）/ 还没登记 / 这个群还没有新帖 / 这条渠道还不会自动拉；
 * 缺权限、被限速、上次没读成的那几个群，在列表上方各一行说清楚（缺哪个权限、怎么开进问号）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Mail, MessageSquare, MessagesSquare, Plug } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { connectPathForChannel } from '@/components/connections/links'
import { WsTag } from '@/components/design'
import { ReplyButton } from '@/components/social/reply-button'
import { Button } from '@/components/ui/button'
import { EmptyLine } from '@/components/ui/empty-line'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import type { SocialChannelId } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import {
  getSocialIngest,
  parseDiscordChannel,
  registerDiscordChannel,
  type SocialIngestData,
  setSocialIngestInterval,
} from '@/lib/social-ingest-api'
import { getSocialThreads, type SocialThreadRowData } from '@/lib/social-reply-api'

/** Discord 可选的读取频率（分钟）。 */
const EVERY_OPTIONS = [5, 15, 30, 60, 180, 1440] as const
/** 这几种状态要在列表上方单独说一行。 */
const ISSUE_STATES = new Set(['missing_permissions', 'limited', 'failed', 'needs_channel'])

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

/** Discord：粘贴频道链接登记一个要读的频道。 */
function RegisterChannel({
  assignment,
  onDone,
}: {
  assignment: string
  onDone: () => void
}): ReactNode {
  const { t } = useApp()
  const [link, setLink] = useState('')
  const [invalid, setInvalid] = useState(false)
  const add = useMutation({
    mutationFn: (target: { guild: string; channel: string }) =>
      registerDiscordChannel(target, assignment),
    onSuccess: () => {
      setLink('')
      onDone()
    },
  })
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      data-testid="threads-register"
      onSubmit={(e) => {
        e.preventDefault()
        const target = parseDiscordChannel(link)
        setInvalid(target === undefined)
        if (target !== undefined) add.mutate(target)
      }}
    >
      <EmptyLine
        icon={<MessagesSquare className="size-4" aria-hidden />}
        text={t('threads.empty.no_channel')}
      />
      <Input
        className="h-7 w-56"
        value={link}
        placeholder={t('threads.register.placeholder')}
        aria-label={t('threads.register.placeholder')}
        data-testid="threads-register-link"
        onChange={(e) => {
          setLink(e.target.value)
          setInvalid(false)
        }}
      />
      <Button size="xs" type="submit" disabled={link.trim() === '' || add.isPending}>
        {t('threads.register')}
      </Button>
      <Hint text={t('threads.register.hint')} />
      {invalid ? (
        <p className="w-full text-xs text-ws-bad" data-testid="threads-register-invalid">
          {t('threads.register.invalid')}
        </p>
      ) : null}
    </form>
  )
}

/** 缺权限 / 被限速 / 上次没读成 / 没说读哪个频道：每个群一行。 */
function Issues({ ingest }: { ingest: SocialIngestData }): ReactNode {
  const { t } = useApp()
  const issues = ingest.accounts.filter((a) => ISSUE_STATES.has(a.state))
  if (issues.length === 0) return null
  return (
    <ul className="flex flex-col gap-1" data-testid="threads-issues">
      {issues.map((a) => (
        <li
          key={a.account_id}
          className="flex items-start gap-1.5 text-xs text-ws-warn"
          data-testid="threads-issue"
          data-state={a.state}
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">
            <span className="font-medium">{a.name}</span>：{a.message ?? ''}
          </span>
          {a.state === 'missing_permissions' ? (
            <Hint text={t('threads.issue.missing_hint')} />
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/** 列表空着时那一行：按渠道照实说。 */
function Empty({
  ingest,
  channel,
  assignment,
  onRegistered,
}: {
  ingest: SocialIngestData | undefined
  channel: SocialChannelId
  assignment: string
  onRegistered: () => void
}): ReactNode {
  const { t } = useApp()
  const icon = <MessagesSquare className="size-4" aria-hidden />
  // 状态没读到（老服务进程 / 出错）：只说没有新帖，不猜原因
  if (ingest === undefined)
    return <EmptyLine icon={icon} text={t('threads.empty.no_posts')} testId="threads-empty" />
  if (!ingest.auto)
    return <EmptyLine icon={icon} text={t('threads.empty.manual')} testId="threads-empty" />
  const blocked = ingest.accounts.some((a) => a.state === 'limited')
  if (!ingest.connected && !blocked)
    return (
      <EmptyLine
        icon={<Plug className="size-4" aria-hidden />}
        text={t('threads.empty.not_connected')}
        action={{
          label: t('threads.empty.connect'),
          to: connectPathForChannel(channel),
          testId: 'threads-connect',
        }}
        testId="threads-empty"
      />
    )
  if (ingest.accounts.length === 0)
    return channel === 'discord' ? (
      <RegisterChannel assignment={assignment} onDone={onRegistered} />
    ) : (
      <EmptyLine icon={icon} text={t('threads.empty.no_own_sub')} testId="threads-empty" />
    )
  return <EmptyLine icon={icon} text={t('threads.empty.no_posts')} testId="threads-empty" />
}

export function SocialThreads({
  assignment,
  channel,
}: {
  assignment: string
  channel: SocialChannelId
}): ReactNode {
  const { t } = useApp()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['social-threads', assignment, channel],
    queryFn: () => getSocialThreads(channel, assignment),
  })
  const ingestKey = ['social-ingest', assignment, channel]
  const ingest = useQuery({
    queryKey: ingestKey,
    queryFn: () => getSocialIngest(channel, assignment),
    retry: false,
  })
  const every = useMutation({
    mutationFn: (minutes: number) => setSocialIngestInterval(channel, minutes, assignment),
    onSuccess: (view) => {
      qc.setQueryData(ingestKey, view)
    },
  })
  const rows = q.data?.rows ?? []
  const view = ingest.data
  return (
    <div className="flex flex-col gap-2" data-testid="social-threads">
      <div className="flex items-center gap-1.5 px-1 text-xs text-ws-muted-fg">
        <span className="rounded-full bg-ws-surface px-1.5 text-[11px]">{rows.length}</span>
        <Hint text={t('threads.hint')} />
        {view?.every_minutes === undefined || !view.connected ? null : (
          <select
            className="ml-auto h-6 rounded-md border bg-background px-1 text-xs"
            aria-label={t('threads.every.label')}
            value={view.every_minutes}
            disabled={every.isPending}
            data-testid="threads-every"
            onChange={(e) => {
              every.mutate(Number(e.target.value))
            }}
          >
            {(EVERY_OPTIONS as readonly number[]).includes(view.every_minutes) ? null : (
              <option value={view.every_minutes}>{view.every_minutes}</option>
            )}
            {EVERY_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {t('threads.every', { n: t(`threads.every.${n}`) })}
              </option>
            ))}
          </select>
        )}
      </div>
      {view === undefined ? null : <Issues ingest={view} />}
      {q.isSuccess && rows.length === 0 && !ingest.isPending ? (
        <Empty
          ingest={view}
          channel={channel}
          assignment={assignment}
          onRegistered={() => {
            void qc.invalidateQueries({ queryKey: ingestKey })
          }}
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
