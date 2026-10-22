/**
 * WP459：收件箱里点了之后做什么——卡走岗位卡片流同一条决定，信走消息面原来那几条
 * （交给 X / 只是通知 / 我自己回）。做完底下冒一句（好消息几秒后自己消失，错误留着）。
 */
import type { InboxItem } from '@agentsws/deck'
import { useMutation } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { claimMessage, handMessageToPosition } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'
import { cn } from '@/lib/utils'
import { positionLabel, useDecideCard, useInbox, useInboxRefresh } from './inbox-model'
import type { RowAct } from './inbox-row'

export interface InboxNotice {
  tone: 'ok' | 'warn' | 'error'
  text: string
  undo?: (() => void) | undefined
}

/** 「我自己回」：到「全部信」打开这条会话并开写信框。 */
export function replySelfUrl(thread_id: string): string {
  return `/messages?view=all&thread=${encodeURIComponent(thread_id)}&reply=1`
}

export function useInboxActions(onNotice: (n: InboxNotice) => void): {
  act(item: InboxItem, act: RowAct): void
  busy: string | undefined
} {
  const { t, lang } = useApp()
  const navigate = useNavigate()
  const refresh = useInboxRefresh()
  const inbox = useInbox()
  const [busy, setBusy] = useState<string | undefined>()
  const decide = useDecideCard()
  const hand = useMutation({
    mutationFn: (input: { id: string; position: string }) =>
      handMessageToPosition(input.id, input.position, false),
    onSettled: refresh,
  })
  const claim = useMutation({
    mutationFn: (input: { id: string; as: 'notice' | 'me' | 'none' }) =>
      claimMessage(input.id, input.as),
    onSettled: refresh,
  })
  const fail = (e: unknown): void => {
    onNotice({ tone: 'error', text: apiErrorText(e, t) })
  }
  const act = (item: InboxItem, what: RowAct): void => {
    const card = item.card
    const mail = item.mail
    setBusy(item.id)
    const done = (): void => {
      setBusy(undefined)
    }
    if (card !== undefined && (what === 'approve' || what === 'reject' || what === 'snooze')) {
      decide.mutate(
        { card, body: { action: what, version: card.version } },
        { onError: fail, onSettled: done },
      )
      return
    }
    if (mail === undefined) {
      done()
      return
    }
    if (what === 'hand' && mail.suggest?.position !== undefined) {
      const position = mail.suggest.position
      hand.mutate(
        { id: mail.message_id, position },
        {
          onSuccess: (out) => {
            const name = positionLabel(inbox.data?.positions, position, lang) ?? position
            if (out.handed_off) onNotice({ tone: 'ok', text: t('messages.hand.done', { name }) })
            else
              onNotice({ tone: 'warn', text: out.refused ?? t('messages.hand.closed', { name }) })
          },
          onError: fail,
          onSettled: done,
        },
      )
      return
    }
    if (what === 'notice' || (what === 'self' && mail.kind === 'billing_system')) {
      const as = what === 'notice' ? 'notice' : 'me'
      claim.mutate(
        { id: mail.message_id, as },
        {
          onSuccess: () => {
            onNotice({
              tone: 'ok',
              text: t(as === 'notice' ? 'messages.action.noticed' : 'messages.action.mine'),
              undo: () => {
                claim.mutate({ id: mail.message_id, as: 'none' }, { onError: fail })
              },
            })
          },
          onError: fail,
          onSettled: done,
        },
      )
      return
    }
    done()
    if (what === 'self') navigate(replySelfUrl(mail.thread_id))
    else if (what === 'original')
      navigate(`/messages?view=all&thread=${encodeURIComponent(mail.thread_id)}`)
  }
  return { act, busy }
}

/** 底下那一句（同消息页的提示条）。 */
export function InboxToast({
  notice,
  onClose,
}: {
  notice: InboxNotice | undefined
  onClose(): void
}): ReactNode {
  const { t } = useApp()
  useEffect(() => {
    if (notice === undefined || notice.tone === 'error') return
    const timer = setTimeout(onClose, 6000)
    return () => {
      clearTimeout(timer)
    }
  }, [notice, onClose])
  if (notice === undefined) return null
  return (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      data-testid="inbox-notice"
      data-tone={notice.tone}
      className="fixed bottom-4 left-1/2 z-40 flex max-w-[92%] -translate-x-1/2 items-center gap-3 rounded-[12px] bg-ws-card px-3 py-2 text-[13px] shadow-ws"
    >
      <span
        className={cn(
          notice.tone === 'error' && 'text-ws-bad',
          notice.tone === 'warn' && 'text-ws-warn',
        )}
      >
        {notice.text}
      </span>
      {notice.undo === undefined ? null : (
        <button
          type="button"
          data-testid="inbox-undo"
          className="ws-link shrink-0"
          onClick={() => {
            const undo = notice.undo
            onClose()
            undo?.()
          }}
        >
          {t('messages.undo')}
        </button>
      )}
      <button
        type="button"
        aria-label={t('messages.notice.close')}
        className="shrink-0 rounded-[6px] p-0.5 text-ws-muted-fg hover:bg-ws-surface"
        onClick={onClose}
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}
