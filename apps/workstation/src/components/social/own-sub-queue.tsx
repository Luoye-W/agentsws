/**
 * WP249（决策 81 / 89）：「自家版待处理」——自家版运营职责视图栏后面那个快捷视图。
 *
 * 一屏：页头（这次走哪条路 + 登录官方号）→ 按类型分组的列表（被举报 / 被扣下待审 / 新帖 / 入群申请），
 * 每条一句摘要 + 举报原因 + AI 建议（批准 / 移除 / 先不管 + 一句理由，引用版规）+ 三个动作按钮
 * + 「回复」（WP255：出一张回帖卡，同样不直接发）。
 *
 * 三条界面纪律：
 *
 * 1. **按钮只出卡**。批准 / 移除 / 封禁点下去是「出一张卡」，卡在上面「要你处理」里批；
 *    批了过取消窗口才执行。按钮旁边一行字说清这件事，不是点完才告诉人。
 * 2. **读不到就照实说**（入群申请、没登录、被 Reddit 拦了），不画一个空列表假装没有。
 * 3. **正文是外部文本**：原样显示（截一行），不渲染成 markdown、不当链接自动点开。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Ban,
  Check,
  EyeOff,
  Flag,
  LogIn,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  StickyNote,
  Trash2,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { StatusPill, type Tone, WsTag } from '@/components/design'
import { ReplyButton } from '@/components/social/reply-button'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyLine } from '@/components/ui/empty-line'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { useApp } from '@/lib/app-context'
import {
  checkRedditBrowserLogin,
  getOwnSubQueue,
  type OwnSubQueueItem,
  type OwnSubQueueView,
  openRedditBrowserLogin,
  registerOwnSub,
  stageOwnSub,
} from '@/lib/own-sub-api'
import { ownSubThread } from '@/lib/social-reply-api'

const GROUPS = ['reported', 'held', 'new_post'] as const
const VERDICT_TONE: Record<OwnSubQueueItem['suggestion']['verdict'], Tone> = {
  approve: 'good',
  remove: 'bad',
  ignore: 'neutral',
}

type T = (k: string, v?: Record<string, string | number>) => string

function Header({
  view,
  assignment,
  onChanged,
  refreshing,
  onRefresh,
}: {
  view: OwnSubQueueView | undefined
  assignment: string
  onChanged: () => void
  refreshing: boolean
  onRefresh: () => void
}): ReactNode {
  const { t } = useApp()
  const login = useMutation({
    mutationFn: () => openRedditBrowserLogin(assignment),
    onSuccess: onChanged,
  })
  const check = useMutation({
    mutationFn: () => checkRedditBrowserLogin(assignment),
    onSuccess: onChanged,
  })
  const b = view?.browser
  const via =
    view?.channel === 'api'
      ? t('ownsub.via.api')
      : view?.channel === 'browser'
        ? b?.username === undefined
          ? t('ownsub.via.browser.anon')
          : t('ownsub.via.browser', { name: b.username })
        : t('ownsub.via.none')
  const showLogin = view !== undefined && view.channel !== 'api' && b?.state !== 'logged_in'
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill
          tone={view?.channel === 'none' ? 'warn' : 'good'}
          data-testid="own-sub-via"
          data-via={view?.channel ?? ''}
        >
          {via}
        </StatusPill>
        <Hint text={t('ownsub.via.hint')} />
        {showLogin && b?.state !== 'no_browser' ? (
          <>
            <Button
              size="xs"
              variant={b?.state === 'login_window_open' ? 'outline' : 'default'}
              data-testid="own-sub-login"
              disabled={login.isPending}
              onClick={() => {
                login.mutate()
              }}
            >
              <LogIn className="size-3.5" aria-hidden />
              {t('ownsub.login')}
            </Button>
            <Button
              size="xs"
              variant={b?.state === 'login_window_open' ? 'default' : 'ghost'}
              data-testid="own-sub-login-done"
              disabled={check.isPending}
              onClick={() => {
                check.mutate()
              }}
            >
              {t('ownsub.login.done')}
            </Button>
            <Hint text={t('ownsub.login.hint')} />
          </>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          data-testid="own-sub-refresh"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
          {t('ownsub.refresh')}
        </Button>
      </div>
      {b?.state === 'login_window_open' ? (
        <p className="text-xs text-ws-muted-fg" data-testid="own-sub-login-open">
          {t('ownsub.login.open')}
        </p>
      ) : null}
      {b?.state === 'blocked' ? (
        <p className="flex items-start gap-1 text-xs text-ws-warn" data-testid="own-sub-blocked">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t('ownsub.blocked', { message: b.message ?? '' })}
        </p>
      ) : null}
      {b?.state === 'no_browser' && view?.channel !== 'api' ? (
        <p className="text-xs text-ws-muted-fg">{t('ownsub.no_browser')}</p>
      ) : null}
    </div>
  )
}

function Register({ assignment, onDone }: { assignment: string; onDone: () => void }): ReactNode {
  const { t } = useApp()
  const [name, setName] = useState('')
  const add = useMutation({
    mutationFn: () => registerOwnSub(name, assignment),
    onSuccess: () => {
      setName('')
      onDone()
    },
  })
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="own-sub-register">
      <EmptyLine
        icon={<StickyNote className="size-4" aria-hidden />}
        text={t('ownsub.empty.subs')}
      />
      <Input
        className="h-7 w-40"
        value={name}
        placeholder={t('ownsub.register.placeholder')}
        onChange={(e) => {
          setName(e.target.value)
        }}
      />
      <Button
        size="xs"
        disabled={name.trim().replace(/^\/?r\//u, '') === '' || add.isPending}
        onClick={() => {
          add.mutate()
        }}
      >
        {t('ownsub.register')}
      </Button>
      <Hint text={t('ownsub.register.hint')} />
    </div>
  )
}

function Row({
  item,
  rules,
  assignment,
  onStaged,
  onIgnore,
}: {
  item: OwnSubQueueItem
  rules: readonly string[]
  assignment: string
  onStaged: () => void
  onIgnore: () => void
}): ReactNode {
  const { t } = useApp()
  const [rule, setRule] = useState<string>(item.suggestion.rule ?? '')
  const [note, setNote] = useState<string | undefined>(undefined)
  const stage = useMutation({
    mutationFn: (input: { action: 'approve' | 'remove' | 'ban'; ban_days?: number }) =>
      stageOwnSub(
        {
          account_id: item.account_id,
          item_id: item.id,
          action: input.action,
          ...(input.action === 'remove' && rule !== '' ? { removal_rule: rule } : {}),
          ...(input.ban_days === undefined ? {} : { ban_days: input.ban_days }),
        },
        assignment,
      ),
    onSuccess: (res) => {
      setNote(
        res.staged
          ? t('ownsub.staged')
          : t('ownsub.blocked_by_guard', { message: res.message ?? '' }),
      )
      onStaged()
    },
  })
  const pending = item.pending_approval_id !== undefined
  const line = item.title ?? item.excerpt
  const v = item.suggestion
  return (
    <li
      className="flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2"
      data-testid="own-sub-item"
      data-id={item.id}
      data-kind={item.kind}
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {item.thing === 'post' ? (
          <StickyNote
            className="size-3.5 shrink-0 text-ws-muted-fg"
            aria-label={t('ownsub.thing.post')}
          />
        ) : (
          <MessageSquare
            className="size-3.5 shrink-0 text-ws-muted-fg"
            aria-label={t('ownsub.thing.comment')}
          />
        )}
        <a
          className="min-w-0 flex-1 truncate hover:underline"
          href={item.url === '' ? undefined : item.url}
          target="_blank"
          rel="noreferrer noopener"
          title={`${item.title ?? ''}\n${item.excerpt}`}
        >
          {line}
        </a>
        <span className="shrink-0 text-xs text-ws-muted-fg">u/{item.author}</span>
      </div>
      {item.title !== undefined && item.excerpt !== '' ? (
        <p className="truncate pl-5 text-xs text-ws-muted-fg">{item.excerpt}</p>
      ) : null}
      {item.report_reasons.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-1 pl-5" data-testid="own-sub-reports">
          <Flag className="size-3 text-ws-bad" aria-hidden />
          {item.report_reasons.map((r) => (
            <WsTag key={r}>{r}</WsTag>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 pl-5">
        <StatusPill
          tone={VERDICT_TONE[v.verdict]}
          data-testid="own-sub-suggestion"
          data-verdict={v.verdict}
        >
          {t(`ownsub.verdict.${v.verdict}`)}
        </StatusPill>
        <span className="min-w-0 flex-1 text-xs text-ws-body" data-testid="own-sub-reason">
          {v.reason}
        </span>
      </div>
      {item.last_failure === undefined ? null : (
        <p className="pl-5 text-xs text-ws-bad" data-testid="own-sub-failed">
          {t('ownsub.failed', { message: item.last_failure })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pl-5">
        {pending || note !== undefined ? (
          <span className="text-xs text-ws-muted-fg" data-testid="own-sub-staged">
            {note ?? t('ownsub.pending')}
          </span>
        ) : (
          <Actions
            t={t}
            rules={rules}
            rule={rule}
            setRule={setRule}
            busy={stage.isPending}
            onAction={(action, ban_days) => {
              stage.mutate({ action, ...(ban_days === undefined ? {} : { ban_days }) })
            }}
            onIgnore={onIgnore}
          />
        )}
        {/* WP255（决策 144）：回复这一条——出一张回帖卡（先把它记成社媒库里的一条线程） */}
        <ReplyButton
          assignment={assignment}
          resolveThread={async () =>
            (await ownSubThread({ account_id: item.account_id, item_id: item.id }, assignment))
              .thread_id
          }
        />
      </div>
    </li>
  )
}

function Actions({
  t,
  rules,
  rule,
  setRule,
  busy,
  onAction,
  onIgnore,
}: {
  t: T
  rules: readonly string[]
  rule: string
  setRule: (r: string) => void
  busy: boolean
  onAction: (action: 'approve' | 'remove' | 'ban', ban_days?: number) => void
  onIgnore: () => void
}): ReactNode {
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={busy}
        data-testid="own-sub-approve"
        onClick={() => onAction('approve')}
      >
        <Check className="size-3.5" aria-hidden />
        {t('ownsub.action.approve')}
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={busy}
        data-testid="own-sub-remove"
        onClick={() => onAction('remove')}
      >
        <Trash2 className="size-3.5" aria-hidden />
        {t('ownsub.action.remove')}
      </Button>
      {rules.length === 0 ? null : (
        <select
          className="h-6 max-w-44 rounded-md border bg-background px-1 text-xs"
          aria-label={t('ownsub.rule.label')}
          value={rule}
          data-testid="own-sub-rule"
          onChange={(e) => {
            setRule(e.target.value)
          }}
        >
          <option value="">{t('ownsub.rule.none')}</option>
          {rules.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="xs" variant="ghost" disabled={busy} data-testid="own-sub-ban">
            <Ban className="size-3.5" aria-hidden />
            {t('ownsub.action.ban')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => onAction('ban', 7)}>
            {t('ownsub.action.ban7')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onAction('ban')}>
            {t('ownsub.action.ban_forever')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button size="xs" variant="ghost" data-testid="own-sub-ignore" onClick={onIgnore}>
        <EyeOff className="size-3.5" aria-hidden />
        {t('ownsub.action.ignore')}
      </Button>
    </>
  )
}

export function OwnSubQueue({ assignment }: { assignment: string }): ReactNode {
  const { t } = useApp()
  const qc = useQueryClient()
  const key = ['own-sub-queue', assignment]
  // 每刷新一次要开好几页 Reddit（官方号浏览器那条低频限速）：不随窗口聚焦自动重读
  const q = useQuery({
    queryKey: key,
    queryFn: () => getOwnSubQueue(assignment),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: key })
  }
  const view = q.data
  const items = (view?.items ?? []).filter((i) => !hidden.has(i.id))
  const rulesOf = (sub: string): readonly string[] =>
    view?.rules.find((r) => r.subreddit === sub)?.rules ?? []
  const failed = (view?.sources ?? []).filter(
    (s) => s.status !== 'ok' && s.source !== 'join_requests',
  )
  const join = (view?.sources ?? []).find((s) => s.source === 'join_requests')

  return (
    <div className="flex flex-col gap-3" data-testid="own-sub-queue">
      <Header
        view={view}
        assignment={assignment}
        onChanged={refresh}
        refreshing={q.isFetching}
        onRefresh={refresh}
      />
      {view !== undefined && view.subreddits.length === 0 ? (
        <Register assignment={assignment} onDone={refresh} />
      ) : null}
      {failed.length === 0 || view?.channel === 'none' ? null : (
        <ul
          className="flex flex-col gap-0.5 text-xs text-ws-warn"
          data-testid="own-sub-source-failed"
        >
          {failed.map((s) => (
            <li key={`${s.subreddit}-${s.source}`}>
              {t('ownsub.source.failed', {
                source: `r/${s.subreddit} ${t(`ownsub.source.${s.source}`)}`,
                message: s.message ?? '',
              })}
            </li>
          ))}
        </ul>
      )}
      {view !== undefined &&
      view.subreddits.length > 0 &&
      view.channel !== 'none' &&
      items.length === 0 ? (
        <EmptyLine icon={<Check className="size-4" aria-hidden />} text={t('ownsub.empty.items')} />
      ) : null}
      {GROUPS.map((g) => {
        const rows = items.filter((i) => i.kind === g)
        if (rows.length === 0) return null
        return (
          <section
            key={g}
            className="flex flex-col gap-1.5"
            data-testid="own-sub-group"
            data-group={g}
          >
            <h5 className="flex items-center gap-1.5 px-1 text-xs font-medium text-ws-muted-fg">
              {t(`ownsub.group.${g}`)}
              <span className="rounded-full bg-ws-surface px-1.5 text-[11px]">{rows.length}</span>
            </h5>
            <ul className="flex flex-col gap-1.5">
              {rows.map((item) => (
                <Row
                  key={item.id}
                  item={item}
                  rules={rulesOf(item.subreddit)}
                  assignment={assignment}
                  onStaged={() => undefined}
                  onIgnore={() => {
                    setHidden((h) => new Set([...h, item.id]))
                  }}
                />
              ))}
            </ul>
          </section>
        )
      })}
      {join === undefined || join.status === 'ok' ? null : (
        <div
          className="flex items-center gap-1.5 px-1 text-xs text-ws-muted-fg"
          data-testid="own-sub-join"
        >
          {t('ownsub.group.join_request')}
          <WsTag>{t('ownsub.join.unsupported')}</WsTag>
          <Hint text={join.message ?? ''} />
        </div>
      )}
      <p className="px-1 text-xs text-ws-muted-fg">{t('ownsub.note')}</p>
    </div>
  )
}
