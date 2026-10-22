/**
 * WP429：顶栏铃铛 + 通知面板（「告诉你一声」的事，不是卡）。
 *
 * - 铃铛是右上那一排里的一个图标（`RailTopBar`：排在浏览器、变更审阅之后、「⋮」之前）；有未读时右上一个红色小数字；
 * - 点开是一张浮层：「未读 / 全部」两档、按时间排，每条一行字 + 时间（同一件事合并过的带 ×N）；
 *   点一条 = 标已读 + 跳到那件事；右上「全部已读」与「通知设置」两个小图标；
 * - 每 30 秒问一次（切回窗口时也问）；新来的、类别开了「系统」的，桌面版同时弹系统通知（{@link useSystemNotify}）；
 *   正看着那一页时来的那条直接算已读、不弹。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bell,
  BellOff,
  CheckCheck,
  Coins,
  type LucideIcon,
  Mail,
  RefreshCw,
  SendHorizontal,
  Settings2,
  Unplug,
  Users,
  Zap,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  type InboxNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  NOTIFICATIONS_KEY,
  type NotificationCategory,
} from '@/lib/api-notifications'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import { useSystemNotify } from './use-system-notify'

/** 多久问一次（毫秒）。 */
export const NOTIFY_POLL_MS = 30_000

const ICON = 'relative flex size-8 items-center justify-center rounded-md transition-colors'
const ICON_ACTIVE = 'bg-sidebar-accent text-sidebar-accent-foreground'
const ICON_IDLE = 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground'

/** 每类一个图标、一种底色（浅 / 深两套由 `--ws-*` 令牌管）。 */
export const CATEGORY_LOOK: Record<NotificationCategory, { icon: LucideIcon; tone: string }> = {
  team: { icon: Users, tone: 'bg-ws-info-bg text-ws-info' },
  task: { icon: Zap, tone: 'bg-ws-good-bg text-ws-good' },
  connection: { icon: Unplug, tone: 'bg-ws-bad-bg text-ws-bad' },
  credits: { icon: Coins, tone: 'bg-ws-warn-bg text-ws-warn' },
  update: { icon: RefreshCw, tone: 'bg-ws-brand-soft text-ws-brand' },
  // WP432：等你在插件里发
  outbound: { icon: SendHorizontal, tone: 'bg-ws-warn-bg text-ws-warn' },
  // WP441：消息规则「告诉我一声」、今天的简报
  messages: { icon: Mail, tone: 'bg-ws-info-bg text-ws-info' },
}

/** 「刚刚 / 5 分钟前 / 3 小时前 / 昨天 / 4 天前」。 */
export function agoText(
  at: string,
  nowMs: number,
  t: (k: string, v?: Record<string, string | number>) => string,
): string {
  const ms = Math.max(0, nowMs - Date.parse(at))
  const min = Math.floor(ms / 60_000)
  if (min < 1) return t('notify.ago.now')
  if (min < 60) return t('notify.ago.min', { n: min })
  const h = Math.floor(min / 60)
  if (h < 24) return t('notify.ago.hour', { n: h })
  const d = Math.floor(h / 24)
  return d === 1 ? t('notify.ago.yesterday') : t('notify.ago.day', { n: d })
}

/** 未读数怎么写在红点上（超过 99 写 99+）。 */
export const badgeText = (n: number): string => (n > 99 ? '99+' : String(n))

export function NotificationBell(): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'unread' | 'all'>('unread')
  const box = useRef<HTMLDivElement | null>(null)

  // 铃铛上的数与系统通知都看「未读」这一份
  const unread = useQuery({
    queryKey: [...NOTIFICATIONS_KEY, 'unread'],
    queryFn: () => listNotifications('unread', 50),
    refetchInterval: NOTIFY_POLL_MS,
    refetchOnWindowFocus: true,
    retry: false,
  })
  const all = useQuery({
    queryKey: [...NOTIFICATIONS_KEY, 'all'],
    queryFn: () => listNotifications('all', 100),
    enabled: open && view === 'all',
    retry: false,
  })
  const refresh = (): Promise<void> => client.invalidateQueries({ queryKey: NOTIFICATIONS_KEY })
  const read = useMutation({
    mutationFn: (ids: string[]) => markNotificationsRead(ids),
    onSettled: refresh,
  })
  const readAll = useMutation({ mutationFn: markAllNotificationsRead, onSettled: refresh })

  useSystemNotify(unread.data?.items, {
    pathname,
    onSeenHere: (ids) => read.mutate(ids),
    onOpen: (path) => navigate(path),
  })

  // 点外面 / Esc 收起
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    globalThis.addEventListener?.('mousedown', onDown)
    globalThis.addEventListener?.('keydown', onKey)
    return () => {
      globalThis.removeEventListener?.('mousedown', onDown)
      globalThis.removeEventListener?.('keydown', onKey)
    }
  }, [open])

  const count = unread.data?.unread ?? 0
  const items = (view === 'all' ? all.data?.items : unread.data?.items) ?? []
  const nowMs = Date.now()
  const label = count > 0 ? t('notify.bell.unread', { n: count }) : t('notify.bell')

  const openOne = (n: InboxNotification): void => {
    if (n.read_at === undefined) read.mutate([n.id])
    setOpen(false)
    if (n.href !== undefined) navigate(n.href)
  }

  return (
    <div ref={box} className="relative" data-testid="notify">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="notify-bell"
        data-unread={count}
        className={cn(ICON, open ? ICON_ACTIVE : ICON_IDLE)}
        onClick={() => {
          setOpen((v) => !v)
        }}
      >
        <Bell aria-hidden className="size-4" />
        {count > 0 ? (
          <span
            data-testid="notify-badge"
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-ws-bad px-1 text-[10px] leading-none font-semibold text-white ring-2 ring-ws-paper tabular-nums"
          >
            {badgeText(count)}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t('notify.title')}
          data-testid="notify-panel"
          className="absolute top-10 right-0 z-50 flex max-h-[min(70vh,560px)] w-[min(360px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-[12px] border border-ws-line bg-popover text-popover-foreground shadow-lg"
        >
          <div className="flex items-center gap-2 border-b border-ws-line px-3 py-2">
            <span className="text-sm font-semibold">{t('notify.title')}</span>
            <div
              role="tablist"
              className="ml-1 flex items-center rounded-full bg-ws-tint p-0.5 text-xs"
              data-testid="notify-views"
            >
              {(['unread', 'all'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  data-testid={`notify-view-${v}`}
                  className={cn(
                    'rounded-full px-2.5 py-0.5 transition-colors',
                    view === v
                      ? 'bg-ws-card font-medium text-foreground shadow-sm'
                      : 'text-ws-muted-fg hover:text-foreground',
                  )}
                  onClick={() => {
                    setView(v)
                  }}
                >
                  {t(`notify.view.${v}`)}
                  {v === 'unread' && count > 0 ? (
                    <span className="ml-1 tabular-nums text-ws-muted-fg">{badgeText(count)}</span>
                  ) : null}
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center">
              <button
                type="button"
                aria-label={t('notify.read_all')}
                title={t('notify.read_all')}
                data-testid="notify-read-all"
                disabled={count === 0 || readAll.isPending}
                className={cn(
                  ICON,
                  'size-7',
                  ICON_IDLE,
                  'disabled:pointer-events-none disabled:opacity-40',
                )}
                onClick={() => {
                  readAll.mutate()
                }}
              >
                <CheckCheck aria-hidden className="size-4" />
              </button>
              <button
                type="button"
                aria-label={t('notify.settings')}
                title={t('notify.settings')}
                data-testid="notify-settings"
                className={cn(ICON, 'size-7', ICON_IDLE)}
                onClick={() => {
                  setOpen(false)
                  navigate('/settings/notifications')
                }}
              >
                <Settings2 aria-hidden className="size-4" />
              </button>
            </div>
          </div>
          {items.length === 0 ? (
            <div
              className="flex flex-col items-center gap-2 px-4 py-10 text-sm text-ws-muted-fg"
              data-testid="notify-empty"
            >
              <span className="flex size-10 items-center justify-center rounded-full bg-ws-tint">
                <BellOff aria-hidden className="size-5" />
              </span>
              {t(view === 'all' ? 'notify.empty.all' : 'notify.empty.unread')}
            </div>
          ) : (
            <ul className="flex-1 overflow-y-auto p-1" data-testid="notify-list">
              {items.map((n) => (
                <NotificationRow
                  key={n.id}
                  n={n}
                  ago={agoText(n.updated_at, nowMs, t)}
                  onOpen={() => {
                    openOne(n)
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}

function NotificationRow({
  n,
  ago,
  onOpen,
}: {
  n: InboxNotification
  ago: string
  onOpen: () => void
}): ReactNode {
  const { t } = useApp()
  const look = CATEGORY_LOOK[n.category] ?? CATEGORY_LOOK.team
  const Icon = look.icon
  const unread = n.read_at === undefined
  return (
    <li>
      <button
        type="button"
        data-testid="notify-item"
        data-category={n.category}
        data-unread={unread}
        title={t(`notify.cat.${n.category}`)}
        className="group flex w-full items-start gap-2.5 rounded-[8px] px-2 py-2 text-left transition-colors hover:bg-sidebar-accent/60"
        onClick={onOpen}
      >
        <span
          className={cn(
            'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
            look.tone,
          )}
        >
          <Icon aria-hidden className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              'line-clamp-2 text-[13px] leading-snug',
              unread ? 'font-medium text-foreground' : 'text-ws-muted-fg',
            )}
          >
            {n.text}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-ws-muted-fg">
            <span>{ago}</span>
            {n.count > 1 ? (
              <span
                className="rounded-full bg-ws-tint px-1.5 tabular-nums"
                data-testid="notify-item-count"
              >
                {t('notify.count', { n: n.count })}
              </span>
            ) : null}
          </span>
        </span>
        {unread ? (
          <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-ws-brand" />
        ) : null}
      </button>
    </li>
  )
}
