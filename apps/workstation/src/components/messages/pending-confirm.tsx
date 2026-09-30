/**
 * WP167：「消息」页的「待确认」一栏——分拣拿不准的信（把握不够的客服 / 红人判定）。
 *
 * 这些信**没开事项、没起 Run、没挪**（docs/63 §D「收信一个入口」），只在这里等人点一下：
 * 「这是客服」交给客服那一路（开事项、起 Run，再按邮箱卡上的开关挪信），「不是」只记人的判断。
 * WP172：拿不准的询盘挂「这是 B2B」——交给 B2B 那一路（落成询盘），再挪进 `BtoBAgents`。
 * 两下都算**人工分拣**，服务端写事件。
 *
 * 少字：左栏一格（有待确认的信就亮一个点，和未读同一种点），每行底下两个小按钮；解释进问号。
 */
import type { MessageThreadSummary } from '@agentsws/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { HelpCircle } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { confirmMessageRoute, listMessageThreads, messageQuery } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/** 左栏那一格：「待确认」+ 问号 + 有信时一个点。 */
export function PendingNavItem({
  active,
  onSelect,
}: {
  active: boolean
  onSelect(): void
}): React.ReactNode {
  const { t } = useApp()
  const query = messageQuery({ pending_route: true, limit: 50 })
  const pending = useQuery({
    queryKey: ['messages', 'threads', query],
    queryFn: () => listMessageThreads(query),
  })
  const count = pending.data?.threads.length ?? 0
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        data-testid="messages-pending"
        data-active={active ? 'true' : undefined}
        className={cn(
          'flex flex-1 items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-[13px]',
          active
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
            : 'text-ws-body hover:bg-sidebar-accent/60',
        )}
        onClick={onSelect}
      >
        <HelpCircle aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{t('messages.pending')}</span>
        {count > 0 ? (
          <i
            aria-hidden
            data-testid="messages-pending-dot"
            className="ml-auto size-1.5 rounded-full bg-ws-brand"
          />
        ) : null}
      </button>
      <Hint text={t('messages.pending.hint')} />
    </div>
  )
}

/** 一行待确认的会话底下那两个按钮。 */
export function PendingActions({
  row,
  onDone,
  onError,
}: {
  row: MessageThreadSummary
  onDone(): void
  /** WP204：交不出去以外的失败（网断了、服务报错）也要说一句，不吞。 */
  onError?(e: unknown): void
}): React.ReactNode {
  const { t } = useApp()
  const [refused, setRefused] = useState(false)
  const id = row.pending_message_id
  const wanted =
    row.suggested_route === 'kol' ? 'kol' : row.suggested_route === 'b2b' ? 'b2b' : 'support'
  const confirm = useMutation({
    mutationFn: (route: 'support' | 'kol' | 'b2b' | 'inbox') =>
      confirmMessageRoute(id as string, route),
    onSuccess: (out, route) => {
      setRefused(route !== 'inbox' && !out.handed_off)
      onDone()
    },
    onError: (e) => {
      onError?.(e)
    },
  })
  if (id === undefined) return null
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2 pl-12"
      data-testid="messages-pending-actions"
      data-message={id}
    >
      <Button
        size="xs"
        variant="secondary"
        disabled={confirm.isPending}
        data-testid="messages-pending-yes"
        onClick={() => {
          confirm.mutate(wanted)
        }}
      >
        {t(`messages.pending.${wanted}`)}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={confirm.isPending}
        data-testid="messages-pending-no"
        onClick={() => {
          confirm.mutate('inbox')
        }}
      >
        {t('messages.pending.no')}
      </Button>
      {refused ? (
        <span role="alert" className="text-[11px] text-destructive">
          {t(wanted === 'b2b' ? 'messages.pending.refused_b2b' : 'messages.pending.refused')}
        </span>
      ) : null}
    </div>
  )
}
