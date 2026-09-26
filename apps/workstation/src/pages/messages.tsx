/**
 * WP113（63 §8）：**消息**——左栏那个入口点开的那一页。
 *
 * 中栏是三块（36 §1 的三栏里那一栏自己再分）：**文件夹 / 标签条 + 会话列表 +
 * 阅读区**。左右分（宽屏），窄屏上下切——选了一条会话就只显示阅读区，返回键回列表。
 *
 * 几处刻意的取舍：
 *
 * - **未读用点不用粗红数字**（36 的减字与图形化）。一个 6px 的品牌色圆点说得清
 *   "这条没读"，而一个红色的 "3" 会让整屏看起来像在报警。
 * - **`kefuagents` / `kolagents` 里的信在这里只读**（63 §9）：顶上一条状态带说
 *   "客服 Agent 在处理"，右下角一个 → 去工作线程。**不给"直接回复"**——
 *   人与 Agent 同时回同一个客户，是这套东西最难解释的一种错。
 *   真要补充口径：教 AI 一句（WP124：人工直发的路已拆，界面只留教 AI）。
 * - **删除永远是"移到垃圾箱"**：界面上那个键叫"删除"，打出去的请求是
 *   `move { to: 'trash' }`，没有第二种去处。
 * - **键盘**：`j`/`k` 上下、`e` 归档、`r` 回复、`a` 全部回复、`/` 搜索。
 *   跟主流邮箱一致——肌肉记忆比自创一套值钱。
 */
import type { MessageFolderKind, MessageRecord, MessageThreadSummary } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  ArrowLeft,
  CornerUpLeft,
  Forward,
  Image as ImageIcon,
  Inbox,
  ListFilter,
  Mail,
  PenSquare,
  RefreshCw,
  ReplyAll,
  Search,
  Star,
  Trash2,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { StatusPill, WsAvatar, WsTag } from '@/components/design'
import { Composer, type ComposeSeed, seedFrom } from '@/components/messages/composer'
import { MessageBody } from '@/components/messages/message-body'
import { focusMessage, USE_SUGGESTION_EVENT } from '@/components/rail/panels/mail-assistant-panel'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  backfillMessages,
  discardMessageDraft,
  getMessageThread,
  listMessageAccounts,
  listMessageLabels,
  listMessageThreads,
  type MessageAccountView,
  messageQuery,
  messageToTodo,
  moveMessage,
  saveMessageDraft,
  sendMessage,
  setMessageFlags,
  showMessageImages,
  syncMessages,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'

/** 左边那一列的文件夹（按**语义**画，真名各家不一样）。 */
const FOLDERS: readonly { kind: MessageFolderKind; icon: typeof Inbox }[] = [
  { kind: 'inbox', icon: Inbox },
  { kind: 'support', icon: Mail },
  { kind: 'kol', icon: Mail },
  { kind: 'sent', icon: Forward },
  { kind: 'drafts', icon: PenSquare },
  { kind: 'spam', icon: ListFilter },
  { kind: 'trash', icon: Trash2 },
]

interface Filters {
  folder_kind: MessageFolderKind
  account?: string | undefined
  label?: string | undefined
  q: string
}

export function MessagesPage(): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const [filters, setFilters] = useState<Filters>({ folder_kind: 'inbox', q: '' })
  const [selected, setSelected] = useState<string | undefined>()
  const [cursor, setCursor] = useState(0)
  const [compose, setCompose] = useState<ComposeSeed | undefined>()
  const [draftId, setDraftId] = useState<string | undefined>()

  const accounts = useQuery({ queryKey: ['messages', 'accounts'], queryFn: listMessageAccounts })
  const labels = useQuery({ queryKey: ['messages', 'labels'], queryFn: listMessageLabels })

  const query = messageQuery({
    folder_kind: filters.folder_kind,
    ...(filters.account === undefined ? {} : { account: filters.account }),
    ...(filters.label === undefined ? {} : { label: filters.label }),
    ...(filters.q === '' ? {} : { q: filters.q }),
  })
  const threads = useQuery({
    queryKey: ['messages', 'threads', query],
    queryFn: () => listMessageThreads(query),
  })
  const thread = useQuery({
    queryKey: ['messages', 'thread', selected],
    enabled: selected !== undefined,
    queryFn: () => getMessageThread(selected as string),
  })

  const rows = useMemo(() => threads.data?.threads ?? [], [threads.data])
  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['messages'] })
  }, [client])

  const me = accounts.data?.accounts[0]?.address ?? ''
  const open = thread.data?.messages.at(-1)
  /** 客服 / 红人那条线程上的信在这里**只读**（63 §9）。 */
  const readOnly = thread.data?.agent_status !== undefined

  const act = useMutation({
    mutationFn: async (input: {
      op: 'read' | 'star' | 'archive' | 'trash' | 'todo' | 'images'
      id: string
    }) => {
      if (input.op === 'read') return setMessageFlags(input.id, { read: true })
      if (input.op === 'star') {
        const current = thread.data?.messages.find((m) => m.id === input.id)
        return setMessageFlags(input.id, { starred: current?.flags.starred !== true })
      }
      if (input.op === 'archive') return moveMessage(input.id, { to: 'archive' })
      // 界面上那个键叫"删除"，打出去的是"移到垃圾箱"——没有第二种去处
      if (input.op === 'trash') return moveMessage(input.id, { to: 'trash' })
      if (input.op === 'images') return showMessageImages(input.id, false)
      return messageToTodo(input.id)
    },
    onSettled: refresh,
  })

  const send = useMutation({
    mutationFn: sendMessage,
    onSuccess: async () => {
      if (draftId !== undefined) await discardMessageDraft(draftId).catch(() => undefined)
      setDraftId(undefined)
      setCompose(undefined)
    },
    onSettled: refresh,
  })

  const sync = useMutation({ mutationFn: syncMessages, onSettled: refresh })
  const backfill = useMutation({
    mutationFn: () =>
      backfillMessages(filters.account === undefined ? {} : { account: filters.account }),
    onSettled: refresh,
  })

  /** 打开一条会话就把最后一封标成已读（回写 IMAP 由服务端做）。 */
  const openThread = useCallback(
    (row: MessageThreadSummary, index: number) => {
      setSelected(row.thread_id)
      setCursor(index)
      if (row.unread > 0) act.mutate({ op: 'read', id: row.last_message_id })
    },
    [act],
  )

  /**
   * 告诉第三栏"现在打开的是哪封信"。
   *
   * 走那份内存真源而不是往面板注册接口上加一格——那份接口是所有面板共用的
   * （WP100 `deck-focus.ts` 同一条路）。离开这一页时清空，面板照实说"没打开信"。
   */
  useEffect(() => {
    focusMessage(open?.id)
    return () => {
      focusMessage(undefined)
    }
  }, [open?.id])

  /**
   * 右栏点了一条回复建议 → **进编辑框**（不是发送）。
   *
   * 非岗位信件永不自动发（63 §6）：这条路的终点是一个装着建议正文的写信框，
   * 人改完自己按发送。客服 / 红人那条线程上只读，所以那时不接这个事件。
   */
  useEffect(() => {
    const onUse = (e: Event): void => {
      const text = (e as CustomEvent<string>).detail
      if (typeof text !== 'string' || open === undefined || readOnly) return
      setCompose({ ...seedFrom('reply', open, me), text })
    }
    window.addEventListener(USE_SUGGESTION_EVENT, onUse)
    return () => {
      window.removeEventListener(USE_SUGGESTION_EVENT, onUse)
    }
  }, [open, me, readOnly])

  /** 键盘：j k e r a /（跟主流邮箱一致，肌肉记忆比自创一套值钱）。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable === true)
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '/' && !typing) {
        e.preventDefault()
        document.querySelector<HTMLInputElement>('[data-testid="messages-search"]')?.focus()
        return
      }
      if (typing) return
      const row = rows[cursor]
      if (e.key === 'j' && cursor < rows.length - 1) {
        const next = rows[cursor + 1]
        if (next !== undefined) openThread(next, cursor + 1)
      } else if (e.key === 'k' && cursor > 0) {
        const prev = rows[cursor - 1]
        if (prev !== undefined) openThread(prev, cursor - 1)
      } else if (e.key === 'e' && row !== undefined) {
        act.mutate({ op: 'archive', id: row.last_message_id })
      } else if ((e.key === 'r' || e.key === 'a') && open !== undefined && !readOnly) {
        setCompose(seedFrom(e.key === 'r' ? 'reply' : 'reply_all', open, me))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [rows, cursor, open, me, readOnly, act, openThread])

  if (accounts.isPending) return <Skeleton className="h-96 w-full" />
  if (accounts.error !== null)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error.generic')}：{accounts.error.message}
      </p>
    )

  const list = accounts.data.accounts
  if (list.length === 0) return <NoMailbox />

  return (
    <div className="flex h-[calc(100vh-7.5rem)] gap-3" data-testid="messages-page">
      {/* ── 文件夹 / 标签 / 多邮箱 ──────────────────────────────────── */}
      <aside
        className="hidden w-48 shrink-0 flex-col gap-3 overflow-y-auto lg:flex"
        data-testid="messages-sidebar"
      >
        <Button
          size="sm"
          className="w-full"
          data-testid="messages-compose"
          onClick={() => {
            setCompose(seedFrom('new', undefined, me))
          }}
        >
          <PenSquare aria-hidden className="mr-1 size-3.5" />
          {t('messages.compose.new')}
        </Button>

        {/* WP124：聊天窗的离线留言落在这里（source = 'chat'）。一个开关，不是第二个收件箱。 */}
        <Button
          size="sm"
          variant={filters.account === 'chat' ? 'secondary' : 'outline'}
          className="w-full"
          data-testid="messages-source-chat"
          aria-pressed={filters.account === 'chat'}
          onClick={() => {
            setFilters((f) => ({ ...f, account: f.account === 'chat' ? undefined : 'chat' }))
            setSelected(undefined)
          }}
        >
          {t('messages.source.chat')}
        </Button>

        <nav className="flex flex-col gap-0.5" aria-label={t('messages.folders')}>
          {FOLDERS.map(({ kind, icon: Icon }) => {
            const unread = list
              .flatMap((a) => a.folders)
              .filter((f) => f.kind === kind)
              .reduce((n, f) => n + f.unread, 0)
            const active = filters.folder_kind === kind
            return (
              <button
                key={kind}
                type="button"
                data-testid="messages-folder"
                data-folder={kind}
                data-active={active ? 'true' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-[13px]',
                  active
                    ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                    : 'text-ws-body hover:bg-sidebar-accent/60',
                )}
                onClick={() => {
                  setFilters((f) => ({ ...f, folder_kind: kind }))
                  setSelected(undefined)
                }}
              >
                <Icon aria-hidden className="size-4 shrink-0" />
                <span className="truncate">{t(`messages.folder.${kind}`)}</span>
                {/* 未读用点不用粗红数字（36 减字 / 图形化） */}
                {unread > 0 ? (
                  <i
                    aria-hidden
                    data-testid="messages-folder-dot"
                    className="ml-auto size-1.5 rounded-full bg-ws-brand"
                  />
                ) : null}
              </button>
            )
          })}
        </nav>

        <div className="flex flex-col gap-1">
          <div className="px-2.5 text-[11px] tracking-wider text-ws-muted-fg uppercase">
            {t('messages.labels')}
          </div>
          <div className="flex flex-wrap gap-1 px-1.5">
            {(labels.data?.labels ?? []).map((l) => (
              <button
                key={l.id}
                type="button"
                data-testid="messages-label"
                data-label={l.id}
                data-active={filters.label === l.id ? 'true' : undefined}
                onClick={() => {
                  setFilters((f) => ({ ...f, label: f.label === l.id ? undefined : l.id }))
                }}
              >
                <WsTag className={cn(filters.label === l.id && 'bg-ws-tint text-ws-brand-ink')}>
                  {lang === 'en' ? l.name_en : l.name_zh}
                </WsTag>
              </button>
            ))}
          </div>
        </div>

        {list.length > 1 ? (
          <div className="flex flex-col gap-1">
            <div className="px-2.5 text-[11px] tracking-wider text-ws-muted-fg uppercase">
              {t('messages.accounts')}
            </div>
            <AccountPicker
              accounts={list}
              value={filters.account}
              onChange={(account) => {
                setFilters((f) => ({ ...f, account }))
              }}
            />
          </div>
        ) : null}

        <div className="mt-auto flex flex-col gap-1 pt-2">
          <button
            type="button"
            data-testid="messages-backfill"
            className="px-2.5 text-left text-[12px] text-ws-muted-fg hover:text-foreground"
            onClick={() => {
              backfill.mutate()
            }}
          >
            {t('messages.backfill')}
          </button>
          <span className="px-2.5 text-[11px] text-ws-muted-fg">
            {t('messages.backfill.since', {
              date: formatDateTime(list[0]?.backfill_floor ?? '', lang),
            })}
          </span>
        </div>
      </aside>

      {/* ── 会话列表 ────────────────────────────────────────────────── */}
      <section
        className={cn(
          'flex w-full shrink-0 flex-col gap-2 md:w-[320px]',
          selected !== undefined && 'hidden md:flex',
        )}
        data-testid="messages-list"
      >
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-ws-muted-fg"
            />
            <Input
              className="pl-7"
              aria-label={t('messages.search')}
              placeholder={t('messages.search.placeholder')}
              data-testid="messages-search"
              value={filters.q}
              onChange={(e) => {
                setFilters((f) => ({ ...f, q: e.target.value }))
              }}
            />
          </div>
          <button
            type="button"
            aria-label={t('messages.sync')}
            data-testid="messages-sync"
            className="rounded-[10px] p-2 text-ws-muted-fg hover:bg-ws-surface"
            onClick={() => {
              sync.mutate()
            }}
          >
            <RefreshCw aria-hidden className={cn('size-4', sync.isPending && 'animate-spin')} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {threads.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : rows.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-ws-muted-fg">{t('messages.empty')}</p>
          ) : (
            rows.map((row, i) => (
              <ThreadRow
                key={row.thread_id}
                row={row}
                selected={row.thread_id === selected}
                onOpen={() => {
                  openThread(row, i)
                }}
              />
            ))
          )}
        </div>
      </section>

      {/* ── 阅读区 ──────────────────────────────────────────────────── */}
      <section
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto',
          selected === undefined && 'hidden md:flex',
        )}
        data-testid="messages-reader"
      >
        {selected === undefined ? (
          <p className="m-auto text-sm text-ws-muted-fg">{t('messages.pick')}</p>
        ) : thread.isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <>
            <button
              type="button"
              className="flex w-fit items-center gap-1 text-[12px] text-ws-muted-fg md:hidden"
              data-testid="messages-back"
              onClick={() => {
                setSelected(undefined)
              }}
            >
              <ArrowLeft aria-hidden className="size-3.5" />
              {t('messages.back')}
            </button>

            {thread.data?.agent_status === undefined ? null : (
              <AgentBand status={thread.data.agent_status} />
            )}

            <h1 className="text-[15px] font-semibold">{thread.data?.subject}</h1>

            {(thread.data?.messages ?? []).map((m) => (
              <MessageCard
                key={m.id}
                message={m}
                onStar={() => {
                  act.mutate({ op: 'star', id: m.id })
                }}
                onImages={() => {
                  act.mutate({ op: 'images', id: m.id })
                }}
              />
            ))}

            {readOnly ? (
              <p
                className="text-[12px] text-ws-muted-fg"
                data-testid="messages-readonly"
                data-slot="status"
              >
                {t('messages.readonly')}
              </p>
            ) : compose === undefined ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="messages-reply"
                  onClick={() => {
                    setCompose(seedFrom('reply', open, me))
                  }}
                >
                  <CornerUpLeft aria-hidden className="mr-1 size-3.5" />
                  {t('messages.reply')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="messages-reply-all"
                  onClick={() => {
                    setCompose(seedFrom('reply_all', open, me))
                  }}
                >
                  <ReplyAll aria-hidden className="mr-1 size-3.5" />
                  {t('messages.reply_all')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="messages-forward"
                  onClick={() => {
                    setCompose(seedFrom('forward', open, me))
                  }}
                >
                  <Forward aria-hidden className="mr-1 size-3.5" />
                  {t('messages.forward')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="messages-archive"
                  onClick={() => {
                    if (open !== undefined) act.mutate({ op: 'archive', id: open.id })
                  }}
                >
                  <Archive aria-hidden className="mr-1 size-3.5" />
                  {t('messages.archive')}
                </Button>
                {/* 「删除」= 移到垃圾箱。绝不永久删除（63 §7） */}
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="messages-delete"
                  onClick={() => {
                    if (open !== undefined) act.mutate({ op: 'trash', id: open.id })
                  }}
                >
                  <Trash2 aria-hidden className="mr-1 size-3.5" />
                  {t('messages.delete')}
                </Button>
              </div>
            ) : (
              <Composer
                key={`${compose.mode}|${compose.thread_id ?? 'new'}|${compose.text.length}`}
                seed={compose}
                busy={send.isPending}
                onSend={(input) => {
                  send.mutate(input)
                }}
                onSaveDraft={(input) => {
                  void saveMessageDraft({
                    ...(draftId === undefined ? {} : { id: draftId }),
                    ...(compose.thread_id === undefined ? {} : { thread_id: compose.thread_id }),
                    ...input,
                  }).then((r) => {
                    setDraftId(r.draft.id)
                  })
                }}
                onClose={() => {
                  setCompose(undefined)
                }}
              />
            )}
          </>
        )}
      </section>
    </div>
  )
}

/** 一条会话（列表上的一行）。未读是一个点，不是一个红数字。 */
function ThreadRow({
  row,
  selected,
  onOpen,
}: {
  row: MessageThreadSummary
  selected: boolean
  onOpen(): void
}): ReactNode {
  const { lang } = useApp()
  const who = row.participants[0]
  return (
    <button
      type="button"
      data-testid="messages-thread"
      data-thread={row.thread_id}
      data-unread={row.unread > 0 ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      onClick={onOpen}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-[12px] px-2.5 py-2 text-left',
        selected ? 'bg-ws-tint' : 'hover:bg-ws-surface',
      )}
    >
      <WsAvatar name={who?.name ?? who?.email ?? '?'} id={who?.email ?? ''} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-1.5">
          <span
            className={cn('min-w-0 flex-1 truncate text-[13px]', row.unread > 0 && 'font-semibold')}
          >
            {who?.name ?? who?.email ?? ''}
          </span>
          {row.count > 1 ? (
            <span className="ws-num shrink-0 text-[11px] text-ws-muted-fg">{row.count}</span>
          ) : null}
          <span className="shrink-0 text-[11px] text-ws-muted-fg">
            {formatDateTime(row.last_at, lang)}
          </span>
        </span>
        <span className={cn('truncate text-[13px]', row.unread > 0 && 'font-medium')}>
          {row.subject}
        </span>
        <span className="truncate text-[12px] text-ws-muted-fg">{row.snippet}</span>
      </span>
      <span className="mt-1.5 flex shrink-0 flex-col items-center gap-1">
        {row.unread > 0 ? (
          <i
            aria-hidden
            data-testid="messages-unread-dot"
            className="size-1.5 rounded-full bg-ws-brand"
          />
        ) : null}
        {row.starred ? <Star aria-hidden className="size-3 fill-ws-warn text-ws-warn" /> : null}
      </span>
    </button>
  )
}

/** 一封信（阅读区里的一块）。 */
function MessageCard({
  message,
  onStar,
  onImages,
}: {
  message: MessageRecord
  onStar(): void
  onImages(): void
}): ReactNode {
  const { t, lang } = useApp()
  return (
    <article
      className="flex flex-col gap-2 rounded-[14px] border border-ws-line bg-ws-card p-3"
      data-testid="messages-message"
      data-message={message.id}
    >
      <header className="flex items-start gap-2">
        <WsAvatar name={message.from.name ?? message.from.email} id={message.from.email} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">
            {message.from.name ?? message.from.email}
          </div>
          <div className="truncate text-[11px] text-ws-muted-fg">{message.from.email}</div>
        </div>
        <span className="shrink-0 text-[11px] text-ws-muted-fg">
          {formatDateTime(message.date, lang)}
        </span>
        <button
          type="button"
          aria-label={t('messages.star')}
          data-testid="messages-star"
          className="shrink-0 rounded p-1 text-ws-muted-fg hover:bg-ws-surface"
          onClick={onStar}
        >
          <Star
            aria-hidden
            className={cn('size-4', message.flags.starred && 'fill-ws-warn text-ws-warn')}
          />
        </button>
      </header>

      {/* 远程图片默认不加载：在按下这一行之前，浏览器一个请求都没发出去 */}
      {message.has_remote_images ? (
        <div
          className="flex items-center gap-2 rounded-[10px] bg-ws-surface px-2.5 py-1.5 text-[12px]"
          data-testid="messages-remote-images"
        >
          <ImageIcon aria-hidden className="size-3.5 text-ws-muted-fg" />
          <span className="text-ws-muted-fg">{t('messages.images.blocked')}</span>
          <button
            type="button"
            className="ml-auto text-ws-brand hover:underline"
            data-testid="messages-show-images"
            onClick={onImages}
          >
            {t('messages.images.show')}
          </button>
        </div>
      ) : null}

      <MessageBody message={message} />

      {message.attachments.length === 0 ? null : (
        <div className="flex flex-wrap gap-1" data-testid="messages-attachments">
          {message.attachments.map((a) => (
            <WsTag key={a.id}>{a.name}</WsTag>
          ))}
        </div>
      )}
    </article>
  )
}

/** 63 §9：`kefuagents` / `kolagents` 里的信顶上那条状态带。 */
function AgentBand({
  status,
}: {
  status: NonNullable<Awaited<ReturnType<typeof getMessageThread>>['agent_status']>
}): ReactNode {
  const { t } = useApp()
  const tone =
    status.state === 'waiting_for_you' ? 'warn' : status.state === 'replied' ? 'good' : 'info'
  return (
    <div
      className="flex items-center gap-2 rounded-[12px] bg-ws-surface px-3 py-2"
      data-testid="messages-agent-band"
      data-state={status.state}
    >
      <StatusPill tone={tone}>{t(`messages.agent.${status.state}`)}</StatusPill>
      <span className="text-[12px] text-ws-muted-fg">
        {t(`messages.agent.route.${status.route}`)}
      </span>
      {status.href === undefined ? null : (
        <Link
          to={status.href}
          className="ml-auto text-[12px] text-ws-brand hover:underline"
          data-testid="messages-agent-link"
        >
          {t('messages.agent.open')}
        </Link>
      )}
    </div>
  )
}

function AccountPicker({
  accounts,
  value,
  onChange,
}: {
  accounts: readonly MessageAccountView[]
  value: string | undefined
  onChange(account: string | undefined): void
}): ReactNode {
  const { t } = useApp()
  return (
    <div className="flex flex-col gap-0.5" data-testid="messages-accounts">
      <button
        type="button"
        data-active={value === undefined ? 'true' : undefined}
        className={cn(
          'rounded-[10px] px-2.5 py-1 text-left text-[12px]',
          value === undefined ? 'bg-sidebar-accent font-medium' : 'text-ws-muted-fg',
        )}
        onClick={() => {
          onChange(undefined)
        }}
      >
        {t('messages.accounts.all')}
      </button>
      {accounts.map((a) => (
        <button
          key={a.address}
          type="button"
          data-account={a.address}
          data-active={value === a.address ? 'true' : undefined}
          className={cn(
            'truncate rounded-[10px] px-2.5 py-1 text-left text-[12px]',
            value === a.address ? 'bg-sidebar-accent font-medium' : 'text-ws-muted-fg',
          )}
          onClick={() => {
            onChange(a.address)
          }}
        >
          {a.address}
        </button>
      ))}
    </div>
  )
}

/** 一只邮箱都没连：照实说，并指向连接页——**不新增凭据入口**（63 §2）。 */
function NoMailbox(): ReactNode {
  const { t } = useApp()
  return (
    <div className="flex max-w-lg flex-col gap-3" data-testid="messages-no-mailbox">
      <h1 className="text-base font-semibold">{t('nav.messages')}</h1>
      <p className="flex items-center gap-1 text-sm text-ws-muted-fg">
        {t('messages.no_mailbox')}
        <Hint text={t('messages.no_mailbox.hint')} />
      </p>
      <Link
        to="/connections?service=email"
        className="w-fit rounded-[10px] bg-primary px-3 py-1.5 text-[13px] text-primary-foreground"
        data-testid="messages-connect"
      >
        {t('messages.connect')}
      </Link>
    </div>
  )
}
