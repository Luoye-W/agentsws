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
 * - **`KefuAgents` / `KOLAgents` 里的信在这里只读**（63 §9）：顶上一条状态带说
 *   "客服 Agent 在处理"，右下角一个 → 去工作线程。**不给"直接回复"**——
 *   人与 Agent 同时回同一个客户，是这套东西最难解释的一种错。
 *   真要补充口径：教 AI 一句（WP124：人工直发的路已拆，界面只留教 AI）。
 * - **删除永远是"移到垃圾箱"**：界面上那个键叫"删除"，打出去的请求是
 *   `move { to: 'trash' }`，没有第二种去处。
 * - **键盘**：`j`/`k` 上下、`e` 归档、`r` 回复、`a` 全部回复、`/` 搜索。
 *   跟主流邮箱一致——肌肉记忆比自创一套值钱。
 * - **WP204：点了就有回音**。每个按钮要么立刻看得见变化，要么底下冒一句话（好消息几秒后
 *   自己消失，错误留着）；归档 / 删除挪的是整条会话、挪完离开这条、带「撤销」；删除先问一句；
 *   影子模式（只看不动）下归档 / 删除置灰、问号里说为什么；「显示图片」由本机代取、只对这一封。
 * - **WP212（docs/88）：默认视图是「没人接的」**（`components/messages/unclaimed-view.tsx`）——
 *   一件要你决定的事只在卡片流里出现，消息页只管兜底（没人接的）与原件档案（「全部」）。
 *   「全部」就是下面这套文件夹 + 会话 + 阅读区（完整的原件档案是第 3 步），岗位在办的会话挂
 *   「X 在办 · 有 N 张卡等你 →」链到卡片；卡片那头的「看原件 →」落在这里（`?view=all&thread=`）。
 */
import type {
  MessageAttachmentMeta,
  MessageFolderKind,
  MessageRecord,
  MessageThreadSummary,
  MessageWriteback,
} from '@agentsws/contracts'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  CornerUpLeft,
  Forward,
  Image as ImageIcon,
  Inbox,
  ListFilter,
  Loader2,
  Mail,
  Paperclip,
  PenSquare,
  RefreshCw,
  ReplyAll,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { StatusPill, WsAvatar, WsTag } from '@/components/design'
import { Composer, type ComposeSeed, seedFrom } from '@/components/messages/composer'
import {
  type HandNotice,
  positionName,
  useMessageOverview,
} from '@/components/messages/hand-actions'
import { MailAiAssistant } from '@/components/messages/mail-ai-assistant'
import { MessageBody } from '@/components/messages/message-body'
import { PendingActions, PendingNavItem } from '@/components/messages/pending-confirm'
import { UnclaimedView } from '@/components/messages/unclaimed-view'
import { focusMessage, USE_SUGGESTION_EVENT } from '@/components/rail/panels/mail-assistant-panel'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  backfillMessages,
  discardMessageDraft,
  downloadMessageAttachment,
  getMessageThread,
  listMessageAccounts,
  listMessageLabels,
  listMessageThreads,
  type MessageAccountView,
  messageQuery,
  moveMessage,
  saveMessageDraft,
  sendMessage,
  setMessageFlags,
  showMessageImages,
  syncMessages,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * 左边那一列的文件夹（按**语义**画，真名各家不一样）。
 *
 * WP161：岗位那三只的显示名走 i18n（客服在处理 / 红人合作 / B2B 往来），服务器上的
 * 真名是 `KefuAgents` / `KOLAgents` / `BtoBAgents`（或用户邮箱里已有的大小写变体）。
 * `onlyWhenPresent` = 没有对应岗位时不画：WP172 起「B2B 往来」按岗位判断——有一只邮箱在收
 * B2B 信（B2B 岗位开着），或者消息库里已经有 B2B 那只文件夹的信，才显示它。
 */
const FOLDERS: readonly {
  kind: MessageFolderKind
  icon: typeof Inbox
  onlyWhenPresent?: boolean
}[] = [
  { kind: 'inbox', icon: Inbox },
  { kind: 'support', icon: Mail },
  { kind: 'kol', icon: Mail },
  { kind: 'b2b', icon: Mail, onlyWhenPresent: true },
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
  /** WP167：看「待确认」那一栏（分拣拿不准的信）。 */
  pending?: boolean | undefined
}

/**
 * WP204：点了之后的那一句话。好消息几秒后自己消失，错误留着直到人关掉或被下一句换掉；
 * 归档 / 删除带「撤销」。
 */
interface Notice {
  tone: 'ok' | 'warn' | 'error'
  text: string
  undo?: (() => void) | undefined
}

/** 「显示图片」只对这一封、这一次生效：代取回来的正文按信 id 记在这一页里，不写回库。 */
type ShownImages = Record<string, { html: string; has_remote_images: boolean }>

/** 挪信的一步（撤销 = 反着挪回去）。 */
interface MoveStep {
  id: string
  from: MessageFolderKind
  to: MessageFolderKind
}

export function MessagesPage(): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  // WP212：`?view=all` = 「全部」（原件档案），缺省 = 「没人接的」；`?thread=` = 打开这条会话
  const [params, setParams] = useSearchParams()
  const view: 'unclaimed' | 'all' = params.get('view') === 'all' ? 'all' : 'unclaimed'
  const threadParam = params.get('thread') ?? undefined
  const overview = useMessageOverview()
  /** 「我自己回」：切到「全部」打开这条会话，信到了就开写信框。 */
  const [replyOnOpen, setReplyOnOpen] = useState<string | undefined>()
  const [filters, setFilters] = useState<Filters>({ folder_kind: 'inbox', q: '' })
  const [selected, setSelected] = useState<string | undefined>(threadParam)
  // -1 = 还没选过：`j` 打开第一条（以前从 0 起，第一条永远被跳过）
  const [cursor, setCursor] = useState(-1)
  const [compose, setCompose] = useState<ComposeSeed | undefined>()
  const [composeError, setComposeError] = useState<string | undefined>()
  const [draftId, setDraftId] = useState<string | undefined>()
  const [notice, setNotice] = useState<Notice | undefined>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [shown, setShown] = useState<ShownImages>({})

  const accounts = useQuery({ queryKey: ['messages', 'accounts'], queryFn: listMessageAccounts })
  const labels = useQuery({ queryKey: ['messages', 'labels'], queryFn: listMessageLabels })

  // WP204：搜索跨全部文件夹（63 §G「搜索：发件人、主题、正文、标签、文件夹」）
  const searching = filters.q.trim() !== ''
  const query = messageQuery({
    // WP167：「待确认」那一栏不分文件夹（拿不准的信都还在收件箱那条路上）
    ...(filters.pending === true
      ? { pending_route: true }
      : searching
        ? {}
        : { folder_kind: filters.folder_kind }),
    ...(filters.account === undefined ? {} : { account: filters.account }),
    ...(filters.label === undefined ? {} : { label: filters.label }),
    ...(searching ? { q: filters.q } : {}),
  })
  const threads = useQuery({
    queryKey: ['messages', 'threads', query],
    queryFn: () => listMessageThreads(query),
    // 边打字边搜时列表不闪成骨架
    placeholderData: keepPreviousData,
  })
  const thread = useQuery({
    queryKey: ['messages', 'thread', selected],
    enabled: selected !== undefined,
    queryFn: () => getMessageThread(selected as string),
  })

  const rows = useMemo(() => threads.data?.threads ?? [], [threads.data])
  // 卡片那头的「看原件 →」、没人接的「→」都靠 `?thread=` 落到这条会话（人已经在这一页时也要跟上）
  useEffect(() => {
    if (threadParam !== undefined) setSelected(threadParam)
  }, [threadParam])
  const switchView = useCallback(
    (next: 'unclaimed' | 'all', thread?: string) => {
      const p = new URLSearchParams()
      if (next === 'all') p.set('view', 'all')
      if (thread !== undefined) p.set('thread', thread)
      setParams(p)
      if (thread === undefined && next === 'all') setSelected(undefined)
    },
    [setParams],
  )
  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['messages'] })
  }, [client])
  const fail = useCallback(
    (e: unknown) => {
      setNotice({ tone: 'error', text: apiErrorText(e, t) })
    },
    [t],
  )

  // 换了文件夹 / 搜索 / 标签：从头数
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖就是"列表换了"这件事，不进闭包
  useEffect(() => {
    setCursor(-1)
  }, [query])

  useEffect(() => {
    if (notice === undefined || notice.tone === 'error') return
    const timer = setTimeout(
      () => {
        setNotice(undefined)
      },
      notice.undo === undefined ? 4000 : 8000,
    )
    return () => {
      clearTimeout(timer)
    }
  }, [notice])

  const list = accounts.data?.accounts ?? []
  const open = thread.data?.messages.at(-1)
  // 自己的地址按**这封信所在的那只邮箱**算（多邮箱时「全部回复」不该把另一只自己抄进去）
  const me = open?.account ?? list[0]?.address ?? ''
  /** 客服 / 红人那条线程上的信在这里**只读**（63 §9）。 */
  const readOnly = thread.data?.agent_status !== undefined
  /** WP204：这封信所在的邮箱开着影子模式（只看不动）。 */
  const shadow = list.some((a) => a.address === open?.account && a.shadow_mode === true)
  const anyShadow = list.some((a) => a.shadow_mode === true)

  /** 回写没成（邮箱服务器没答应）要说一句；只在本机标（影子模式）左栏已经挂着标，不再每下都说。 */
  const onWriteback = useCallback(
    (writeback: MessageWriteback | undefined) => {
      if (writeback === 'failed') setNotice({ tone: 'warn', text: t('messages.writeback.failed') })
    },
    [t],
  )

  const { mutate: markRead } = useMutation({
    mutationFn: (id: string) => setMessageFlags(id, { read: true }),
    onSuccess: (r) => {
      onWriteback(r.writeback)
    },
    onError: fail,
    onSettled: refresh,
  })

  const star = useMutation({
    mutationFn: (m: MessageRecord) => setMessageFlags(m.id, { starred: !m.flags.starred }),
    onSuccess: (r) => {
      onWriteback(r.writeback)
    },
    onError: fail,
    onSettled: refresh,
  })

  const move = useMutation({
    mutationFn: async (input: {
      kind: 'archive' | 'trash' | 'restore' | 'undo'
      steps: MoveStep[]
    }) => {
      let failed = false
      for (const s of input.steps) {
        const r = await moveMessage(s.id, { to: s.to })
        if (r.writeback === 'failed') failed = true
      }
      return { ...input, failed }
    },
    onSuccess: (out) => {
      setConfirmDelete(false)
      if (out.kind === 'undo') {
        setNotice({ tone: 'ok', text: t('messages.undone') })
        return
      }
      // 挪走了就离开这条会话：阅读区还停在一封已经不在这里的信上，看起来就像"没反应"
      setSelected(undefined)
      setCompose(undefined)
      const text = t(
        out.kind === 'trash'
          ? 'messages.trashed'
          : out.kind === 'archive'
            ? 'messages.archived'
            : 'messages.restored',
      )
      const back = out.steps.map((s) => ({ id: s.id, from: s.to, to: s.from }))
      setNotice({
        tone: out.failed ? 'warn' : 'ok',
        text: out.failed ? `${text}。${t('messages.writeback.failed')}` : text,
        undo: () => {
          move.mutate({ kind: 'undo', steps: back })
        },
      })
    },
    onError: fail,
    onSettled: refresh,
  })

  /**
   * 归档 / 删除 / 移回收件箱挪的是**整条会话里在眼前这个文件夹的那几封**——以前只挪最后一封，
   * 一条会话里有两封收件箱的信时，挪完那一行还在列表里，看起来就是"没反应"。
   */
  const moveThread = (kind: 'archive' | 'trash' | 'restore'): void => {
    if (open === undefined) return
    if (shadow) {
      setNotice({ tone: 'warn', text: t('messages.shadow.hint') })
      return
    }
    if (readOnly) {
      setNotice({ tone: 'warn', text: t('messages.readonly') })
      return
    }
    const to: MessageFolderKind = kind === 'restore' ? 'inbox' : kind
    const view =
      filters.pending === true ? 'inbox' : searching ? open.folder_kind : filters.folder_kind
    const all = thread.data?.messages ?? []
    const inView = all.filter((m) => m.folder_kind === view)
    const steps = (inView.length > 0 ? inView : [open])
      .filter((m) => m.folder_kind !== to)
      .map((m) => ({ id: m.id, from: m.folder_kind, to }))
    if (steps.length > 0) move.mutate({ kind, steps })
  }
  /** 键盘 `e` 走同一条路（监听器只挂一次，读的是这一拍的那一份）。 */
  const moveThreadRef = useRef(moveThread)
  moveThreadRef.current = moveThread

  const images = useMutation({
    mutationFn: (id: string) => showMessageImages(id, false),
    onSuccess: (r) => {
      const html = r.message.html
      if (html !== undefined)
        setShown((s) => ({
          ...s,
          [r.message.id]: { html, has_remote_images: r.message.has_remote_images },
        }))
      const got = r.images
      if (got !== undefined && got.failed > 0)
        setNotice({
          tone: 'warn',
          text:
            got.shown === 0
              ? t('messages.images.none')
              : t('messages.images.partial', { n: got.failed }),
        })
    },
    onError: fail,
  })

  const send = useMutation({
    mutationFn: sendMessage,
    onMutate: () => {
      setComposeError(undefined)
    },
    onSuccess: async () => {
      if (draftId !== undefined) await discardMessageDraft(draftId).catch(() => undefined)
      setDraftId(undefined)
      setCompose(undefined)
      setNotice({ tone: 'ok', text: t('messages.sent') })
    },
    // 没发出去：写信框留着、话说在框里（以前 500 被吞掉，人以为发了）
    onError: (e) => {
      setComposeError(t('messages.compose.failed', { reason: apiErrorText(e, t) }))
    },
    onSettled: refresh,
  })

  const sync = useMutation({
    mutationFn: syncMessages,
    onSuccess: (r) => {
      if (r.accounts === 0) setNotice({ tone: 'warn', text: t('messages.sync.no_account') })
      else if (r.failed.length > 0)
        setNotice({
          tone: 'warn',
          text: t('messages.sync.failed', { n: r.failed.length, list: r.failed.join('、') }),
        })
      else
        setNotice({
          tone: 'ok',
          text:
            r.fetched > 0 ? t('messages.sync.done', { n: r.fetched }) : t('messages.sync.fresh'),
        })
    },
    onError: fail,
    onSettled: refresh,
  })
  const backfill = useMutation({
    mutationFn: () =>
      backfillMessages(filters.account === undefined ? {} : { account: filters.account }),
    onSuccess: (r) => {
      setNotice({
        tone: 'ok',
        text: t('messages.backfill.done', { date: formatDateTime(r.floor, lang) }),
      })
    },
    onError: fail,
    onSettled: refresh,
  })

  const download = useMutation({
    mutationFn: (input: { id: string; attachment: string; name: string }) =>
      downloadMessageAttachment(input.id, input.attachment, input.name),
    onError: fail,
  })

  /** 打开一条会话就把最后一封标成已读（回写 IMAP 由服务端做；影子模式下只在本机标）。 */
  const openThread = useCallback(
    (row: MessageThreadSummary, index: number) => {
      setSelected(row.thread_id)
      setCursor(index)
      setConfirmDelete(false)
      setComposeError(undefined)
      if (row.unread > 0) markRead(row.last_message_id)
    },
    [markRead],
  )

  /**
   * 告诉邮件助手"现在打开的是哪封信"。
   *
   * 走那份内存真源（WP100 `deck-focus.ts` 同一条路）。WP208 起助手在阅读区里（不在第三栏了），
   * 这条路原样留着：助手那一块与这一页之间仍然只靠它和下面那个事件。离开这一页时清空。
   */
  useEffect(() => {
    focusMessage(open?.id)
    return () => {
      focusMessage(undefined)
    }
  }, [open?.id])

  /**
   * 邮件助手里点了一条回复建议 → **进编辑框**（不是发送）。
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

  /** WP212：「我自己回」——信到了就开写信框（人自己按发送；岗位在办的线程只读，不开）。 */
  useEffect(() => {
    if (replyOnOpen === undefined || replyOnOpen !== selected || open === undefined) return
    if (open.thread_id !== replyOnOpen) return
    setReplyOnOpen(undefined)
    if (!readOnly) setCompose(seedFrom('reply', open, me))
  }, [replyOnOpen, selected, open, me, readOnly])

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
      if (e.key === 'j' && cursor < rows.length - 1) {
        const next = rows[cursor + 1]
        if (next !== undefined) openThread(next, cursor + 1)
      } else if (e.key === 'k' && cursor > 0) {
        const prev = rows[cursor - 1]
        if (prev !== undefined) openThread(prev, cursor - 1)
      } else if (e.key === 'e' && open !== undefined && !move.isPending) {
        // 与「归档」键同一条路：整条会话、影子模式与只读都照样拦、带撤销
        moveThreadRef.current('archive')
      } else if ((e.key === 'r' || e.key === 'a') && open !== undefined && compose === undefined) {
        // 写信框开着时不重开（以前按一下 r 就把写了一半的回信冲掉）
        if (readOnly) setNotice({ tone: 'warn', text: t('messages.readonly') })
        else setCompose(seedFrom(e.key === 'r' ? 'reply' : 'reply_all', open, me))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [rows, cursor, open, me, readOnly, compose, move.isPending, openThread, t])

  if (accounts.isPending) return <Skeleton className="h-96 w-full" />
  if (accounts.error !== null)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error.generic')}：{accounts.error.message}
      </p>
    )

  if (list.length === 0) return <NoMailbox />

  const noticeBar =
    notice === undefined ? null : (
      <div
        role={notice.tone === 'error' ? 'alert' : 'status'}
        data-testid="messages-notice"
        data-tone={notice.tone}
        className="fixed bottom-4 left-1/2 z-40 flex max-w-[92%] -translate-x-1/2 items-center gap-3 rounded-[12px] border border-ws-line bg-ws-card px-3 py-2 text-[13px] shadow-ws"
      >
        <span
          className={cn(
            notice.tone === 'error' && 'text-destructive',
            notice.tone === 'warn' && 'text-ws-warn',
          )}
        >
          {notice.text}
        </span>
        {notice.undo === undefined ? null : (
          <button
            type="button"
            data-testid="messages-undo"
            className="shrink-0 font-medium text-ws-brand hover:underline"
            onClick={() => {
              const undo = notice.undo
              setNotice(undefined)
              undo?.()
            }}
          >
            {t('messages.undo')}
          </button>
        )}
        <button
          type="button"
          aria-label={t('messages.notice.close')}
          data-testid="messages-notice-close"
          className="shrink-0 rounded p-0.5 text-ws-muted-fg hover:bg-ws-surface"
          onClick={() => {
            setNotice(undefined)
          }}
        >
          <X aria-hidden className="size-3.5" />
        </button>
      </div>
    )

  const header = (
    <header className="flex flex-wrap items-center gap-3">
      <h1 className="text-[22px] font-semibold">{t('nav.messages')}</h1>
      <ViewToggle
        view={view}
        unclaimed={overview.data?.unclaimed}
        onChange={(next) => {
          switchView(next)
        }}
      />
    </header>
  )

  // WP212：默认视图「没人接的」（方向 A）
  if (view === 'unclaimed')
    return (
      <div
        className="relative flex flex-col gap-4 pb-16"
        data-testid="messages-page"
        data-view="unclaimed"
      >
        {header}
        <UnclaimedView
          onOpenOriginal={(thread) => {
            switchView('all', thread)
          }}
          onReplySelf={(thread) => {
            setReplyOnOpen(thread)
            switchView('all', thread)
          }}
          onNotice={(n: HandNotice) => {
            setNotice(n)
          }}
        />
        {noticeBar}
      </div>
    )

  return (
    <div className="relative flex flex-col gap-3" data-testid="messages-page" data-view="all">
      {header}
      <div className="flex h-[calc(100vh-10rem)] gap-3">
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
            {FOLDERS.filter(
              ({ kind, onlyWhenPresent }) =>
                onlyWhenPresent !== true ||
                list.some(
                  (a) =>
                    (kind === 'b2b' && a.b2b === true) || a.folders.some((f) => f.kind === kind),
                ),
            ).map(({ kind, icon: Icon }) => {
              const unread = list
                .flatMap((a) => a.folders)
                .filter((f) => f.kind === kind)
                .reduce((n, f) => n + f.unread, 0)
              // 搜索时跨全部文件夹，不亮哪一只（亮着像是只在它里面搜）
              const active = filters.folder_kind === kind && filters.pending !== true && !searching
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
                    // WP204：点文件夹就退出搜索（搜索跨全部文件夹，不清掉的话点了像没反应）
                    setFilters((f) => ({ ...f, folder_kind: kind, pending: false, q: '' }))
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
            {/* WP167：分拣拿不准的信在这里等人点一下（没开事项、没挪） */}
            <PendingNavItem
              active={filters.pending === true}
              onSelect={() => {
                setFilters((f) => ({ ...f, pending: true, q: '' }))
                setSelected(undefined)
              }}
            />
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
            {anyShadow ? (
              <div className="flex items-center gap-1 px-2.5" data-testid="messages-shadow">
                <StatusPill tone="warn">{t('messages.shadow.tag')}</StatusPill>
                <Hint text={t('messages.shadow.hint')} />
              </div>
            ) : null}
            <MailboxFailure accounts={list} />
            <button
              type="button"
              data-testid="messages-backfill"
              disabled={backfill.isPending}
              className="px-2.5 text-left text-[12px] text-ws-muted-fg hover:text-foreground disabled:opacity-60"
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
              disabled={sync.isPending}
              className="rounded-[10px] p-2 text-ws-muted-fg hover:bg-ws-surface disabled:opacity-60"
              onClick={() => {
                sync.mutate()
              }}
            >
              <RefreshCw aria-hidden className={cn('size-4', sync.isPending && 'animate-spin')} />
            </button>
          </div>

          {searching && filters.pending !== true ? (
            <span className="px-1 text-[11px] text-ws-muted-fg" data-testid="messages-search-all">
              {t('messages.search.all')}
            </span>
          ) : null}

          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {threads.error !== null && threads.data === undefined ? (
              <p role="alert" className="px-2 py-6 text-center text-sm text-destructive">
                {apiErrorText(threads.error, t)}
              </p>
            ) : threads.isPending ? (
              <Skeleton className="h-40 w-full" />
            ) : rows.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-ws-muted-fg">
                {t('messages.empty')}
              </p>
            ) : (
              rows.map((row, i) =>
                filters.pending === true ? (
                  <div key={row.thread_id} className="flex flex-col">
                    <ThreadRow
                      row={row}
                      selected={row.thread_id === selected}
                      onOpen={() => {
                        openThread(row, i)
                      }}
                    />
                    <PendingActions row={row} onDone={refresh} onError={fail} />
                  </div>
                ) : (
                  <ThreadRow
                    key={row.thread_id}
                    row={row}
                    selected={row.thread_id === selected}
                    onOpen={() => {
                      openThread(row, i)
                    }}
                  />
                ),
              )
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
          ) : thread.error !== null ? (
            <p role="alert" className="m-auto text-sm text-destructive">
              {apiErrorText(thread.error, t)}
            </p>
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

              {thread.data?.agent_status === undefined ? (
                <ClaimBand view={thread.data} />
              ) : (
                <AgentBand
                  status={thread.data.agent_status}
                  cards={thread.data.open_card_count ?? 0}
                  cardLink={thread.data.card_link}
                />
              )}

              <h1 className="text-[15px] font-semibold">{thread.data?.subject}</h1>

              {(thread.data?.messages ?? []).map((m) => (
                <MessageCard
                  key={m.id}
                  message={
                    shown[m.id] === undefined
                      ? m
                      : { ...m, ...(shown[m.id] as ShownImages[string]) }
                  }
                  starring={star.isPending && star.variables?.id === m.id}
                  imagesBusy={images.isPending && images.variables === m.id}
                  onStar={() => {
                    star.mutate(m)
                  }}
                  onImages={() => {
                    images.mutate(m.id)
                  }}
                  onDownload={(a) => {
                    download.mutate({ id: m.id, attachment: a.id, name: a.name })
                  }}
                />
              ))}

              {/* WP208：邮件助手从第三栏搬进来——看信时才出现，一块可收起（Luoye 09-30） */}
              {/* WP212：兜底助手——只在没人接的信上生成建议，岗位在办的只挂「在办 · 有卡等你」 */}
              {open === undefined ? null : (
                <MailAiAssistant
                  message={open}
                  {...(thread.data === undefined ? {} : { view: thread.data })}
                  onReplySelf={() => {
                    if (!readOnly) setCompose(seedFrom('reply', open, me))
                  }}
                  onNotice={(n) => {
                    setNotice(n)
                  }}
                />
              )}

              {readOnly ? (
                <p
                  className="text-[12px] text-ws-muted-fg"
                  data-testid="messages-readonly"
                  data-slot="status"
                >
                  {t('messages.readonly')}
                </p>
              ) : compose === undefined ? (
                <div className="flex flex-wrap items-center gap-2" data-testid="messages-actions">
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
                  {/* WP204：影子模式下归档 / 删除会动邮箱，所以置灰，问号里说为什么 */}
                  {open === undefined ||
                  open.folder_kind === 'archive' ||
                  open.folder_kind === 'trash' ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="messages-archive"
                      disabled={shadow || move.isPending}
                      title={shadow ? t('messages.shadow.hint') : undefined}
                      onClick={() => {
                        moveThread('archive')
                      }}
                    >
                      <Archive aria-hidden className="mr-1 size-3.5" />
                      {t('messages.archive')}
                    </Button>
                  )}
                  {open?.folder_kind === 'trash' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="messages-restore"
                      disabled={shadow || move.isPending}
                      title={shadow ? t('messages.shadow.hint') : undefined}
                      onClick={() => {
                        moveThread('restore')
                      }}
                    >
                      <Inbox aria-hidden className="mr-1 size-3.5" />
                      {t('messages.restore')}
                    </Button>
                  ) : confirmDelete ? (
                    // 「删除」= 移到垃圾箱，绝不永久删除（63 §G）；先问一句，之后还能撤销
                    <span
                      className="flex items-center gap-1.5"
                      data-testid="messages-delete-confirm"
                    >
                      <span className="text-[12px] text-ws-muted-fg">
                        {t('messages.delete.confirm')}
                      </span>
                      <Button
                        size="xs"
                        variant="destructive"
                        data-testid="messages-delete-yes"
                        disabled={move.isPending}
                        onClick={() => {
                          moveThread('trash')
                        }}
                      >
                        {t('messages.delete.yes')}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        data-testid="messages-delete-no"
                        onClick={() => {
                          setConfirmDelete(false)
                        }}
                      >
                        {t('messages.delete.no')}
                      </Button>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="messages-delete"
                      disabled={shadow || move.isPending}
                      title={shadow ? t('messages.shadow.hint') : undefined}
                      onClick={() => {
                        setConfirmDelete(true)
                      }}
                    >
                      <Trash2 aria-hidden className="mr-1 size-3.5" />
                      {t('messages.delete')}
                    </Button>
                  )}
                  {shadow ? (
                    <Hint text={t('messages.shadow.hint')} testId="messages-shadow-hint" />
                  ) : null}
                </div>
              ) : (
                <Composer
                  key={`${compose.mode}|${compose.thread_id ?? 'new'}|${compose.text.length}`}
                  seed={compose}
                  busy={send.isPending}
                  {...(composeError === undefined ? {} : { error: composeError })}
                  onSend={(input) => {
                    send.mutate(input)
                  }}
                  onSaveDraft={(input) => {
                    saveMessageDraft({
                      ...(draftId === undefined ? {} : { id: draftId }),
                      ...(compose.account === undefined ? {} : { account: compose.account }),
                      ...(compose.thread_id === undefined ? {} : { thread_id: compose.thread_id }),
                      ...(compose.in_reply_to === undefined
                        ? {}
                        : { in_reply_to: compose.in_reply_to }),
                      ...input,
                    })
                      .then((r) => {
                        setDraftId(r.draft.id)
                      })
                      // 草稿没存上也要说（以前这里的失败没人接，写了半天的信可能没存）
                      .catch(fail)
                  }}
                  onClose={() => {
                    setCompose(undefined)
                    setComposeError(undefined)
                  }}
                />
              )}
            </>
          )}
        </section>
      </div>
      {noticeBar}
    </div>
  )
}

/** WP212：顶上「没人接的 N / 全部」分段。 */
function ViewToggle({
  view,
  unclaimed,
  onChange,
}: {
  view: 'unclaimed' | 'all'
  unclaimed: number | undefined
  onChange(view: 'unclaimed' | 'all'): void
}): ReactNode {
  const { t } = useApp()
  return (
    <div
      className="ml-auto inline-flex rounded-[12px] bg-ws-surface p-0.5 text-[13px]"
      role="tablist"
      data-testid="messages-view-toggle"
    >
      {(['unclaimed', 'all'] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={view === v}
          data-testid={`messages-view-${v}`}
          className={cn(
            'rounded-[10px] px-3 py-1',
            view === v
              ? 'bg-ws-card font-medium shadow-ws'
              : 'text-ws-muted-fg hover:text-foreground',
          )}
          onClick={() => {
            onChange(v)
          }}
        >
          {t(`messages.view.${v}`)}
          {v === 'unclaimed' && unclaimed !== undefined ? (
            <span className="ws-num ml-1">{unclaimed}</span>
          ) : null}
        </button>
      ))}
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
        <ClaimTag row={row} />
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
  starring,
  imagesBusy,
  onStar,
  onImages,
  onDownload,
}: {
  message: MessageRecord
  starring: boolean
  imagesBusy: boolean
  onStar(): void
  onImages(): void
  onDownload(attachment: MessageAttachmentMeta): void
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
          aria-pressed={message.flags.starred}
          data-testid="messages-star"
          data-starred={message.flags.starred ? 'true' : undefined}
          disabled={starring}
          className="shrink-0 rounded p-1 text-ws-muted-fg hover:bg-ws-surface disabled:opacity-60"
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
          <Hint text={t('messages.images.proxy_hint')} />
          <button
            type="button"
            className="ml-auto flex items-center gap-1 text-ws-brand hover:underline disabled:opacity-60"
            data-testid="messages-show-images"
            disabled={imagesBusy}
            onClick={onImages}
          >
            {imagesBusy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
            {t(imagesBusy ? 'messages.images.loading' : 'messages.images.show')}
          </button>
        </div>
      ) : null}

      <MessageBody message={message} />

      {message.attachments.length === 0 ? null : (
        <div className="flex flex-wrap gap-1" data-testid="messages-attachments">
          {message.attachments
            .filter((a) => a.inline !== true)
            .map((a) => (
              <button
                key={a.id}
                type="button"
                data-testid="messages-attachment"
                data-attachment={a.id}
                aria-label={t('messages.attachment.download', { name: a.name })}
                onClick={() => {
                  onDownload(a)
                }}
              >
                <WsTag className="gap-1 hover:bg-ws-tint">
                  <Paperclip aria-hidden className="size-3" />
                  {a.name}
                </WsTag>
              </button>
            ))}
        </div>
      )}
    </article>
  )
}

/** 63 §9：`KefuAgents` / `KOLAgents` 里的信顶上那条状态带。 */
function AgentBand({
  status,
  cards = 0,
  cardLink,
}: {
  status: NonNullable<Awaited<ReturnType<typeof getMessageThread>>['agent_status']>
  /** WP212：卡片流里还有几张卡等你批（有就挂「有 N 张卡等你 →」）。 */
  cards?: number
  cardLink?: string | undefined
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
      <StatusPill tone={tone}>
        {/* WP172：B2B 那条路说「B2B Agent 在处理」，不借客服那一句 */}
        {t(
          status.route === 'b2b' && status.state === 'working'
            ? 'messages.agent.working_b2b'
            : `messages.agent.${status.state}`,
        )}
      </StatusPill>
      <span className="text-[12px] text-ws-muted-fg">
        {t(`messages.agent.route.${status.route}`)}
      </span>
      {cards > 0 ? (
        <Link
          to={cardLink ?? '/'}
          className="ml-auto text-[12px] font-medium text-ws-brand hover:underline"
          data-testid="messages-cards-waiting"
        >
          {t('messages.claim.cards', { n: cards })} →
        </Link>
      ) : null}
      {status.href === undefined ? null : (
        <Link
          to={status.href}
          className={cn('text-[12px] text-ws-brand hover:underline', cards > 0 ? '' : 'ml-auto')}
          data-testid="messages-agent-link"
        >
          {t('messages.agent.open')}
        </Link>
      )}
    </div>
  )
}

/**
 * WP212：交给了岗位的会话（不在 63 那三只岗位文件夹里的，例如交给公共关系）顶上一条：
 * 「公共关系在办 · 有 1 张卡等你 →」——点了跳卡片那一头。消息页里**没有批准按钮**。
 */
function ClaimBand({
  view,
}: {
  view: Awaited<ReturnType<typeof getMessageThread>> | undefined
}): ReactNode {
  const { t, lang } = useApp()
  const overview = useMessageOverview()
  const to = view?.handed_to
  if (view?.claim !== 'handed' || to === undefined || to === 'me' || to === 'notice') return null
  const name = positionName(overview.data?.positions, to, lang)
  const cards = view.open_card_count ?? 0
  return (
    <div
      className="flex items-center gap-2 rounded-[12px] bg-ws-surface px-3 py-2 text-[12px]"
      data-testid="messages-claim-band"
      data-position={to}
    >
      <StatusPill tone="info">{t('messages.claim.handed', { name })}</StatusPill>
      {cards > 0 || view.card_link !== undefined ? (
        <Link
          to={view.card_link ?? '/'}
          className="ml-auto font-medium text-ws-brand hover:underline"
          data-testid="messages-cards-waiting"
        >
          {cards > 0 ? `${t('messages.claim.cards', { n: cards })} →` : t('messages.agent.open')}
        </Link>
      ) : null}
    </div>
  )
}

/** WP212：「全部」里每一行的归属小标签（岗位在办 · 有 N 张卡 / 没人接）。 */
function ClaimTag({ row }: { row: MessageThreadSummary }): ReactNode {
  const { t, lang } = useApp()
  const overview = useMessageOverview()
  const to = row.handed_to
  if (row.claim === 'unclaimed')
    return (
      <span
        className="text-[11px] text-ws-warn"
        data-testid="messages-claim-tag"
        data-claim="unclaimed"
      >
        {t('messages.claim.unclaimed')}
      </span>
    )
  if (row.claim !== 'handed' || to === undefined || to === 'me' || to === 'notice') return null
  const cards = row.open_card_count ?? 0
  return (
    <span
      className="truncate text-[11px] text-ws-brand-ink"
      data-testid="messages-claim-tag"
      data-claim="handed"
    >
      {t('messages.claim.handed', { name: positionName(overview.data?.positions, to, lang) })}
      {cards > 0 ? ` · ${t('messages.claim.cards', { n: cards })} →` : ''}
    </span>
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

/**
 * WP163：判成客服的信没动成（没挪进客服文件夹 / 没标已读）——状态要一眼看见（36 §7），
 * 一行短字 + 问号里说是哪只邮箱、什么时候、为什么。几只邮箱都有就说最近的那一次。
 */
function MailboxFailure({ accounts }: { accounts: readonly MessageAccountView[] }): ReactNode {
  const { t, lang } = useApp()
  const latest = accounts
    .flatMap((a) =>
      a.last_mailbox_failure === undefined ? [] : [{ a, f: a.last_mailbox_failure }],
    )
    .sort((x, y) => y.f.at.localeCompare(x.f.at))[0]
  if (latest === undefined) return null
  const reasonKey = `messages.mailbox_failure.reason.${latest.f.reason}`
  const reason = t(reasonKey)
  return (
    <div
      className="flex items-center gap-1 px-2.5 text-[12px] text-ws-warn"
      data-testid="messages-mailbox-failure"
      data-reason={latest.f.reason}
    >
      <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{t(`messages.mailbox_failure.${latest.f.action}`)}</span>
      <Hint
        text={t('messages.mailbox_failure.hint', {
          account: latest.a.address,
          time: formatDateTime(latest.f.at, lang),
          reason: reason === reasonKey ? latest.f.reason : reason,
        })}
      />
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
