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
 *
 * WP257（决策 152 / 156）：自动进来的帖子入库就判了类（标签，不出卡）——列表上方一排标签按类筛、带条数；
 * 旁边一个「模型复核」小开关（默认关）。Telegram 群照 Discord：没登记时粘贴群链接登记；隐私模式开着照实说、
 * 怎么关进问号。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Mail, MessageSquare, MessagesSquare, Plug } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { connectPathForChannel } from '@/components/connections/links'
import { WsTag } from '@/components/design'
import { ReplyButton } from '@/components/social/reply-button'
import { Button } from '@/components/ui/button'
import { EmptyLine } from '@/components/ui/empty-line'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type { SocialChannelId } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import {
  getSocialIngest,
  parseDiscordChannel,
  parseTelegramGroup,
  registerDiscordChannel,
  registerTelegramGroup,
  type SocialIngestData,
  setSocialIngestInterval,
  setSocialTagReview,
} from '@/lib/social-ingest-api'
import { getSocialThreads, type SocialThreadRowData } from '@/lib/social-reply-api'

/** Discord 可选的读取频率（分钟）。 */
const EVERY_OPTIONS = [5, 15, 30, 60, 180, 1440] as const
/** 这几种状态要在列表上方单独说一行。 */
const ISSUE_STATES = new Set(['missing_permissions', 'limited', 'failed', 'needs_channel'])
/** WP257：标签的顺序（客户问题在最前：最要紧的先看）。 */
const TAG_ORDER = [
  'customer_question',
  'complaint',
  'praise',
  'partnership',
  'spam',
  'other',
] as const
/** 能在这里登记要读的群 / 频道的渠道。 */
const REGISTRABLE = new Set<SocialChannelId>(['discord', 'telegram_group'])

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

/**
 * 粘贴链接登记一个要读的群：Discord 频道（WP256）/ Telegram 群（WP257）。
 * 登记那一下服务端读一次名字（「#general」/ 群名），读不到先用默认名。
 */
function RegisterChannel({
  assignment,
  channel,
  onDone,
}: {
  assignment: string
  channel: SocialChannelId
  onDone: () => void
}): ReactNode {
  const { t } = useApp()
  const [link, setLink] = useState('')
  const [invalid, setInvalid] = useState(false)
  const telegram = channel === 'telegram_group'
  /** 这条渠道的词条：Telegram 有自己的一份，没有就用 Discord 那份。 */
  const k = (key: string): string => (telegram ? `${key}.telegram_group` : key)
  const add = useMutation({
    mutationFn: async (raw: string) => {
      if (telegram) {
        const chat = parseTelegramGroup(raw)
        if (chat === undefined) throw new Error('invalid')
        return registerTelegramGroup(chat, assignment)
      }
      const target = parseDiscordChannel(raw)
      if (target === undefined) throw new Error('invalid')
      return registerDiscordChannel(target, assignment)
    },
    onSuccess: () => {
      setLink('')
      onDone()
    },
  })
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      data-testid="threads-register"
      data-channel={channel}
      onSubmit={(e) => {
        e.preventDefault()
        const ok = telegram
          ? parseTelegramGroup(link) !== undefined
          : parseDiscordChannel(link) !== undefined
        setInvalid(!ok)
        if (ok) add.mutate(link)
      }}
    >
      <EmptyLine
        icon={<MessagesSquare className="size-4" aria-hidden />}
        text={t(k('threads.empty.no_channel'))}
      />
      <Input
        className="h-7 w-56"
        value={link}
        placeholder={t(k('threads.register.placeholder'))}
        aria-label={t(k('threads.register.placeholder'))}
        data-testid="threads-register-link"
        onChange={(e) => {
          setLink(e.target.value)
          setInvalid(false)
        }}
      />
      <Button size="xs" type="submit" disabled={link.trim() === '' || add.isPending}>
        {t('threads.register')}
      </Button>
      <Hint text={t(k('threads.register.hint'))} />
      {invalid ? (
        <p className="w-full text-xs text-ws-bad" data-testid="threads-register-invalid">
          {t(k('threads.register.invalid'))}
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
            <Hint
              text={t(
                ingest.channel === 'telegram_group'
                  ? 'threads.issue.missing_hint.telegram_group'
                  : 'threads.issue.missing_hint',
              )}
            />
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
    return REGISTRABLE.has(channel) ? (
      <RegisterChannel assignment={assignment} channel={channel} onDone={onRegistered} />
    ) : (
      <EmptyLine icon={icon} text={t('threads.empty.no_own_sub')} testId="threads-empty" />
    )
  return <EmptyLine icon={icon} text={t('threads.empty.no_posts')} testId="threads-empty" />
}

/** WP257：一排标签按类筛（带条数；只列有帖子的类）。 */
function TagFilter({
  rows,
  value,
  onChange,
}: {
  rows: readonly SocialThreadRowData[]
  value: string | undefined
  onChange: (next: string | undefined) => void
}): ReactNode {
  const { t } = useApp()
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) if (r.triage !== undefined) m.set(r.triage, (m.get(r.triage) ?? 0) + 1)
    return m
  }, [rows])
  if (counts.size === 0) return null
  const chip = (key: string | undefined, label: string, n: number) => (
    <Button
      key={key ?? 'all'}
      size="xs"
      variant={value === key ? 'secondary' : 'ghost'}
      aria-pressed={value === key}
      data-testid="threads-tag"
      data-tag={key ?? 'all'}
      onClick={() => {
        onChange(key)
      }}
    >
      {label}
      <span className="ws-num text-[11px] text-ws-muted-fg">{n}</span>
    </Button>
  )
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      role="group"
      aria-label={t('threads.tags.label')}
      data-testid="threads-tags"
    >
      {chip(undefined, t('threads.tags.all'), rows.length)}
      {TAG_ORDER.filter((k) => counts.has(k)).map((k) =>
        chip(k, t(`threads.triage.${k}`), counts.get(k) ?? 0),
      )}
    </div>
  )
}

/** WP257：「模型复核」小开关（默认关；没接上模型时照实说只按规则判）。 */
function TagReviewSwitch({
  view,
  assignment,
  onChanged,
}: {
  view: SocialIngestData
  assignment: string
  onChanged: (next: NonNullable<SocialIngestData['tags']>) => void
}): ReactNode {
  const { t } = useApp()
  const set = useMutation({
    mutationFn: (on: boolean) => setSocialTagReview(on, assignment),
    onSuccess: onChanged,
  })
  const tags = view.tags
  if (tags === undefined || !view.auto) return null
  return (
    <span className="flex items-center gap-1" data-testid="threads-review">
      <Switch
        size="sm"
        checked={tags.model_review}
        disabled={set.isPending}
        aria-label={t('threads.tags.review')}
        data-testid="threads-review-switch"
        onCheckedChange={(on) => {
          set.mutate(on)
        }}
      />
      <span>{t('threads.tags.review')}</span>
      <Hint
        text={
          tags.model_review && !tags.model_ready
            ? `${t('threads.tags.review.hint')} ${t('threads.tags.review.not_ready')}`
            : t('threads.tags.review.hint')
        }
      />
    </span>
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
  const [tag, setTag] = useState<string | undefined>(undefined)
  const all = q.data?.rows ?? []
  // 选中的类这会儿没帖子了（都回完了）：回到「全部」，不显示一个空列表
  const active = tag !== undefined && all.some((r) => r.triage === tag) ? tag : undefined
  const rows = active === undefined ? all : all.filter((r) => r.triage === active)
  const view = ingest.data
  return (
    <div className="flex flex-col gap-2" data-testid="social-threads">
      <div className="flex items-center gap-1.5 px-1 text-xs text-ws-muted-fg">
        <span className="rounded-full bg-ws-surface px-1.5 text-[11px]">{all.length}</span>
        <Hint text={t('threads.hint')} />
        <span className="ml-auto" />
        {view === undefined ? null : (
          <TagReviewSwitch
            view={view}
            assignment={assignment}
            onChanged={(tags) => {
              qc.setQueryData(ingestKey, { ...view, tags })
            }}
          />
        )}
        {view?.every_minutes === undefined || !view.connected ? null : (
          <select
            className="h-6 rounded-md border bg-background px-1 text-xs"
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
      <TagFilter rows={all} value={active} onChange={setTag} />
      {q.isSuccess && all.length === 0 && !ingest.isPending ? (
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
