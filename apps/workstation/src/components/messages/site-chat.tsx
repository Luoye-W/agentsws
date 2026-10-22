/**
 * 「消息」里的来源「网站聊天」（WP351，Luoye 10-16 追加；原「聊天窗」页的对话那一半）。
 *
 * 装在商家网站上的那个挂件，访客聊的每一段都在这里看——和邮箱并列，是消息的另一个来源。
 * 做法照消息页里客服 Agent 那几封信（63 §9）：
 *
 * - 顶上一条「客服 AI 在处理」，右边一个「去工作线程 →」（网站在线客服那条职责的页面）；
 * - **不给直接回复框**——底部唯一的输入框是「教 AI」（WP124 修订第 1 条：对客直发入口数 = 0，
 *   `test/no-direct-reply.test.ts` 钉着）。教的话客户看不到；AI 改写成客户的语言、以 AI 口吻回。
 *   旁边「以后都这样」（WP289 / 决策 318）开着教 = 还出一张进职责规矩的卡。
 * - 未读用小圆点（36 减字）：这台电脑上看过之后这段又有新动静才算未读。看过到哪一刻记在本机
 *   （`SITE_CHAT_SEEN_KEY`，只有会话 id 与时间，没有一个字的内容）。
 *
 * WP139：两种请求各用自己那条分配——会话列表与对话用网站在线客服那条（`LIVE_CHAT_NEED`），
 * 教 AI 用持有 `customer.stage` 的那条（`LIVE_CHAT_TEACH_NEED`），都不改全局当前岗位。
 * 挂件的外观 / 嵌入代码 / 转发方式在「消息渠道」页的「网站聊天窗」（`chat-window/widget-settings.tsx`）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Settings2 } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AutoAnswerMark } from '@/components/chat/auto-answer-mark'
import { StatusPill } from '@/components/design'
import { DutyNeeded } from '@/components/duty-needed'
import { PageError } from '@/components/page-error'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  type ChatSessionView,
  ensureSession,
  getChatMessages,
  listChatSessions,
  type Me,
  teachChatSession,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { dutyHref } from '@/lib/duty-href'
import { useMode } from '@/lib/mode'
import {
  type AssignmentPick,
  type DutyNeed,
  LIVE_CHAT_NEED,
  LIVE_CHAT_TEACH_NEED,
  pickAssignment,
} from '@/lib/pick-assignment'
import { readString, SITE_CHAT_SEEN_KEY, writeString } from '@/lib/ui-state'
import { assignmentOf, canRequest, useDutyAssignment } from '@/lib/use-duty-assignment'
import { cn } from '@/lib/utils'

/** 「消息」里网站聊天那个来源的地址（老 `/chat-window` 跳到这里）。 */
export const SITE_CHAT_HREF = '/messages?view=all&source=chat'
/** 挂件设置：「消息渠道」页里「网站聊天窗」那一块。 */
export const SITE_CHAT_SETTINGS_HREF = '/im-channels#site-chat'

/** 常驻入口出不出：名下有网站在线客服这条职责（同 WP139 左栏那一格的判据）。 */
const SITE_CHAT_NEED: DutyNeed = {
  roles: ['dtc.live-chat'],
  needs_range: false,
  duty_key: 'need.duty.live_chat',
}

/**
 * 常驻件（左栏、⌘K、消息页那一格）读身份用的：与外壳共用 `['session']`，但**挂上来时不重取**。
 *
 * 为什么不直接用 `useDutyAssignment`：它在 `/v1/me` 出错时，每多一个新挂上的观察者就会重取一次
 * （TanStack 默认 `retryOnMount`）——外壳在「会话取不回来」时正是靠这份查询画整页错误 + 重试，
 * 常驻件一挂上就把它拉回「加载中」、再出错、再挂……整页空白（boot-error 那条测试撞出来的）。
 */
function useQuietSession(): Me | undefined {
  const me = useQuery({
    queryKey: ['session'],
    queryFn: ensureSession,
    retry: false,
    retryOnMount: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  })
  return me.data
}

/** 常驻件里挑分配：问不到身份 = 没有（不发请求）。 */
function useQuietPick(need: DutyNeed): AssignmentPick | undefined {
  const { position } = useApp()
  const me = useQuietSession()
  return me === undefined ? undefined : pickAssignment(me.assignments, need, position)
}

/**
 * 名下有没有网站在线客服。问不到身份时按「没有」算——常驻入口（来源那一格、⌘K、消息渠道那一块、
 * 左栏「消息」的点）只在确知有这条职责时出，免得没这条职责的人也去问一遍访客会话。
 * 老地址 `/chat-window` 照样能进那个来源（进去照实说缺什么）。
 */
export function useHoldsSiteChat(): boolean {
  const pick = useQuietPick(SITE_CHAT_NEED)
  return pick?.kind === 'ok' || pick?.kind === 'no_range'
}

const STATUS_KEYS: Record<string, string> = {
  open: 'chat.session.open',
  assist_requested: 'chat.session.assist_requested',
  assist_answered: 'chat.session.assist_answered',
  human_takeover: 'chat.session.human_takeover',
  email_follow_up: 'chat.session.email_follow_up',
  closed: 'chat.session.closed',
}

// ── 未读（本机记「看到哪一刻」） ───────────────────────────────────────

type Seen = Record<string, string>
const SEEN_KEY = ['site-chat', 'seen'] as const

function readSeen(): Seen {
  const raw = readString(SITE_CHAT_SEEN_KEY)
  if (raw === null || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Seen = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
      if (typeof v === 'string') out[k] = v
    return out
  } catch {
    return {}
  }
}

/** 没结束、并且这台电脑上看过之后又有动静（或者一次都没看过）。 */
export function siteChatUnread(s: ChatSessionView, seen: Seen): boolean {
  return s.status !== 'closed' && (seen[s.id] ?? '') < s.updated_at
}

function useSeen(): [Seen, (s: ChatSessionView) => void] {
  const client = useQueryClient()
  const seen = useQuery({
    queryKey: SEEN_KEY,
    queryFn: readSeen,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const mark = useCallback(
    (s: ChatSessionView) => {
      if (typeof s.updated_at !== 'string') return
      const prev = client.getQueryData<Seen>(SEEN_KEY) ?? readSeen()
      if ((prev[s.id] ?? '') >= s.updated_at) return
      const next = { ...prev, [s.id]: s.updated_at }
      writeString(SITE_CHAT_SEEN_KEY, JSON.stringify(next))
      client.setQueryData(SEEN_KEY, next)
    },
    [client],
  )
  return [seen.data ?? {}, mark]
}

/** 进行中的访客对话（这一来源打开时用；与左栏的点共用一份缓存）。 */
function useSessions() {
  const pick = useDutyAssignment(LIVE_CHAT_NEED)
  const asg = assignmentOf(pick)
  const sessions = useQuery({
    queryKey: ['chat-widget', 'sessions', asg],
    enabled: canRequest(pick),
    queryFn: () => listChatSessions(30, asg),
    refetchInterval: 60_000,
  })
  return { pick, asg, sessions }
}

/** 网站聊天里有没有没看过的（「消息」页来源那一格与左栏「消息」的小圆点用）。 */
export function useSiteChatUnread(): boolean {
  const holds = useHoldsSiteChat()
  const pick = useQuietPick(LIVE_CHAT_NEED)
  const asg = pick?.kind === 'ok' ? pick.assignment : undefined
  const sessions = useQuery({
    queryKey: ['chat-widget', 'sessions', asg],
    enabled: holds && asg !== undefined,
    queryFn: () => listChatSessions(30, asg),
    refetchInterval: 60_000,
    retry: false,
    retryOnMount: false,
  })
  const [seen] = useSeen()
  return holds && (sessions.data ?? []).some((s) => siteChatUnread(s, seen))
}

// ── 来源那一格 ──────────────────────────────────────────────────────────

const DOT = 'size-1.5 shrink-0 rounded-full bg-ws-brand'

/** 「消息」页左边那列里的「网站聊天」（和文件夹同一种样子）。 */
export function SiteChatSourceItem({
  active,
  onSelect,
  icon: Icon,
}: {
  active: boolean
  onSelect: () => void
  icon: typeof Settings2
}): ReactNode {
  const { t } = useApp()
  const unread = useSiteChatUnread()
  return (
    <button
      type="button"
      data-testid="messages-source-site-chat"
      data-active={active ? 'true' : undefined}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]',
        active
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-ws-body hover:bg-sidebar-accent/60',
      )}
      onClick={onSelect}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="truncate">{t('messages.source.site_chat')}</span>
      {unread ? (
        <i aria-hidden data-testid="messages-site-chat-dot" className={cn('ml-auto', DOT)} />
      ) : null}
    </button>
  )
}

// ── 列表 + 对话 ─────────────────────────────────────────────────────────

export function SiteChatView({
  initial,
  onOfflineMessages,
}: {
  /** 打开时就选中的那一段（`?thread=`）。 */
  initial?: string | undefined
  /** 「离线留言」：访客在没人值守时留下的话按邮件收在消息库里（source = 'chat'）。 */
  onOfflineMessages: () => void
}): ReactNode {
  const { t } = useApp()
  const { t: tm } = useMode()
  const client = useQueryClient()
  const [selected, setSelected] = useState<string | undefined>(initial)
  const [instruction, setInstruction] = useState('')
  /** WP289（决策 318）：这一句「以后都这样」（进职责规矩）。 */
  const [always, setAlways] = useState(false)
  const [taughtRule, setTaughtRule] = useState(false)
  const { pick, asg, sessions } = useSessions()
  const teachAsg = assignmentOf(useDutyAssignment(LIVE_CHAT_TEACH_NEED)) ?? asg
  const [seen, markSeen] = useSeen()

  const detail = useQuery({
    queryKey: ['chat-widget', 'messages', selected],
    enabled: selected !== undefined,
    queryFn: () => getChatMessages(selected as string, asg),
  })
  // 看到了就记一下（这段之后再有动静才又算未读）
  useEffect(() => {
    if (detail.data !== undefined) markSeen(detail.data.session)
  }, [detail.data, markSeen])

  const teach = useMutation({
    mutationFn: (input: { id: string; text: string; always: boolean }) =>
      teachChatSession(
        input.id,
        { instruction: input.text, scope: input.always ? 'global_rule' : 'similar_cases' },
        teachAsg,
      ),
    onMutate: () => {
      setTaughtRule(false)
    },
    onSuccess: async (out) => {
      setInstruction('')
      setAlways(false)
      setTaughtRule(out.sediment === 'role_rule')
      await client.invalidateQueries({ queryKey: ['chat-widget'] })
    },
  })

  const active = (sessions.data ?? []).filter((s) => s.status !== 'closed')
  const session = detail.data?.session
  /** 工作线程 = 网站在线客服那条职责的页面（客服 AI 在那里干活、出卡）。 */
  const workHref =
    pick.kind === 'ok' || pick.kind === 'no_range'
      ? dutyHref(pick.assignment, pick.role_id)
      : undefined

  return (
    <div className="flex min-w-0 flex-1 gap-3" data-testid="site-chat">
      {/* ── 会话列表 ── */}
      <section
        className={cn(
          'flex w-full shrink-0 flex-col gap-2 md:w-[320px]',
          selected !== undefined && 'hidden md:flex',
        )}
        data-testid="site-chat-list"
      >
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-[13px] font-medium">{t('chat.window.conversations')}</h2>
          <button
            type="button"
            data-testid="messages-source-chat"
            className="ws-link-muted ml-auto text-[12px]"
            onClick={onOfflineMessages}
          >
            {t('site_chat.offline')}
          </button>
          <Link
            to={SITE_CHAT_SETTINGS_HREF}
            aria-label={t('nav.chat_window')}
            title={t('nav.chat_window')}
            data-testid="site-chat-settings"
            className="rounded-[8px] p-1 text-ws-muted-fg hover:bg-ws-surface hover:text-foreground"
          >
            <Settings2 aria-hidden className="size-3.5" />
          </Link>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {pick.kind === 'none' || pick.kind === 'no_range' ? (
            <DutyNeeded need={LIVE_CHAT_NEED} kind={pick.kind} testid="chat-duty-needed" />
          ) : sessions.error !== null ? (
            <PageError
              error={sessions.error}
              testid="chat-sessions-error"
              overrides={{ forbidden: t('chat.forbidden') }}
              onRetry={() => {
                void sessions.refetch()
              }}
            />
          ) : sessions.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : active.length === 0 ? (
            <p
              className="px-2 py-6 text-center text-sm text-ws-muted-fg"
              data-testid="chat-conversations-empty"
            >
              {t('chat.window.conversations.empty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1" data-testid="chat-conversations">
              {active.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    data-testid="chat-conversation"
                    data-session={s.id}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px]',
                      selected === s.id
                        ? 'bg-sidebar-accent font-medium'
                        : 'hover:bg-sidebar-accent/60',
                    )}
                    onClick={() => {
                      setSelected(s.id)
                      markSeen(s)
                    }}
                  >
                    {siteChatUnread(s, seen) ? (
                      <i aria-hidden data-testid="site-chat-unread" className={DOT} />
                    ) : (
                      <i aria-hidden className="size-1.5 shrink-0" />
                    )}
                    <span className="truncate">{s.visitor_display ?? s.external_session_id}</span>
                    <span className="ml-auto shrink-0 text-xs text-ws-muted-fg">
                      {t(STATUS_KEYS[s.status] ?? 'chat.session.open')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ── 对话 ── */}
      <section
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto',
          selected === undefined && 'hidden md:flex',
        )}
        data-testid="site-chat-reader"
      >
        {selected === undefined ? (
          <p className="m-auto text-sm text-ws-muted-fg">{t('messages.pick')}</p>
        ) : detail.isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : detail.data === undefined ? null : (
          <div className="flex flex-col gap-3" data-testid="chat-conversation-view">
            <button
              type="button"
              className="ws-link-muted flex w-fit items-center gap-1 text-[12px] md:hidden"
              onClick={() => {
                setSelected(undefined)
              }}
            >
              <ArrowLeft aria-hidden className="size-3.5" />
              {t('messages.back')}
            </button>
            {session === undefined ? null : <SiteChatBand session={session} workHref={workHref} />}
            <h1 className="text-[14px] font-semibold">
              {session?.visitor_display ?? session?.external_session_id}
            </h1>
            <ul className="flex flex-col gap-1.5">
              {detail.data.messages.map((m) => (
                <li
                  key={m.id}
                  className={cn(
                    'max-w-[85%] rounded-[12px] px-3 py-2 text-[13px]',
                    m.role === 'visitor'
                      ? 'self-start bg-ws-card shadow-ws'
                      : 'self-end bg-ws-surface text-ws-body',
                  )}
                >
                  <span className="mr-1 text-xs text-ws-muted-fg">{t(`chat.role.${m.role}`)}:</span>
                  {m.text}
                  {/* WP428：AI 直接答的那一句标出处，旁边「这句不该直接答」 */}
                  <AutoAnswerMark sessionId={selected} message={m} assignment={asg} />
                </li>
              ))}
            </ul>
            {/* 唯一的输入框：教 AI。客户看不到这句话；AI 改写成客户语言后以 AI 口吻回。
                这里**没有**接手回复客户的框——那是被 KA 与 Luoye 一起拆掉的路。 */}
            <div className="flex items-start gap-2">
              <Textarea
                value={instruction}
                placeholder={t('chat.window.teach.placeholder')}
                data-testid="chat-teach-input"
                rows={2}
                onChange={(e) => setInstruction(e.target.value)}
              />
              <div className="flex flex-col items-stretch gap-1">
                <Button
                  size="sm"
                  data-testid="chat-teach-send"
                  disabled={instruction.trim() === '' || teach.isPending}
                  onClick={() => teach.mutate({ id: selected, text: instruction.trim(), always })}
                >
                  {t('chat.window.teach.send')}
                </Button>
                {/* WP289：「以后都这样」——和卡片指导同一个说法，开着教就出一张进职责规矩的卡 */}
                <Button
                  size="xs"
                  variant={always ? 'secondary' : 'ghost'}
                  aria-pressed={always}
                  data-testid="chat-teach-always"
                  onClick={() => {
                    setAlways((v) => !v)
                  }}
                >
                  {tm('card.instruct.scope.global_rule')}
                </Button>
              </div>
              <Hint text={t('chat.window.teach.hint')} />
            </div>
            {taughtRule ? (
              <p className="text-xs text-ws-muted-fg" data-testid="chat-teach-rule-receipt">
                {tm('deck.receipt.instruct.global_rule')}
              </p>
            ) : null}
          </div>
        )}
      </section>
    </div>
  )
}

/** 顶上那一条：客服 AI 在处理 / 等你拍板 / 已结束 · 这条归客服岗位 · 去工作线程 →。 */
function SiteChatBand({
  session,
  workHref,
}: {
  session: ChatSessionView
  workHref: string | undefined
}): ReactNode {
  const { t } = useApp()
  const waiting = session.status === 'assist_requested'
  const closed = session.status === 'closed'
  return (
    <div
      className="flex items-center gap-2 rounded-[12px] bg-ws-surface px-3 py-2"
      data-testid="site-chat-band"
      data-state={session.status}
    >
      <StatusPill tone={waiting ? 'warn' : closed ? 'neutral' : 'info'}>
        {waiting
          ? t('messages.agent.waiting_for_you')
          : closed
            ? t('chat.session.closed')
            : t('site_chat.working')}
      </StatusPill>
      <span className="text-[12px] text-ws-muted-fg">{t('messages.agent.route.support')}</span>
      {workHref === undefined ? null : (
        <Link
          to={workHref}
          className="ml-auto text-[12px] text-ws-brand hover:underline"
          data-testid="site-chat-work-link"
        >
          {t('messages.agent.open')}
        </Link>
      )}
    </div>
  )
}
