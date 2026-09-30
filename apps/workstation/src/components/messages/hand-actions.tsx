/**
 * WP212（docs/88 §3.2）：「没人接的」每条那三个建议——**交给 X ▾** / **只是通知** / **我自己回**。
 *
 * AI 挑一个当主按钮（实心），另两个描边；主按钮排第一。
 *
 * - 「交给 X」= 63 的「这是客服」推广到所有岗位：交出去就是那个岗位的一件事（进卡片流），
 *   消息页不再催。▾ 里换岗位：AI 建议的排最上面、标「AI 建议 · 售后」；没开的岗位是灰的，
 *   问号里说"开了才能交"（63：岗位没开不挪信，这条不许绕过）。
 * - 「只是通知」：标已读（邮箱里标不标跟随「客信怎么动邮箱」开关）、不开事项、不花钱；能撤销。
 * - 「我自己回」：打开写信框（人自己按发送）。账单与系统通知那类写「我自己处理」——记成你自己处理。
 */
import type { MessageKind, MessagePositionOption, MessageSuggest } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { claimMessage, getMessageOverview, handMessageToPosition } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'
import { cn } from '@/lib/utils'
import { Popover } from './popover'

/** 页面上那一句提示（与消息页的提示条同一种形状）。 */
export interface HandNotice {
  tone: 'ok' | 'warn' | 'error'
  text: string
  undo?: (() => void) | undefined
}

/** 「交给 X ▾」要的岗位清单与名字（与顶上那一行共用一个请求）。 */
export function useMessageOverview() {
  return useQuery({ queryKey: ['messages', 'overview'], queryFn: getMessageOverview })
}

export function positionName(
  positions: readonly MessagePositionOption[] | undefined,
  id: string,
  lang: string,
): string {
  const p = positions?.find((x) => x.id === id)
  if (p === undefined) return id
  return lang === 'en' ? p.name_en : p.name_zh
}

export function HandActions({
  messageId,
  kind,
  suggest,
  onDone,
  onSelf,
}: {
  messageId: string
  kind: MessageKind | undefined
  suggest: MessageSuggest | undefined
  onDone(notice: HandNotice): void
  /** 「我自己回」：打开写信框（在哪儿打开由页面定）。 */
  onSelf(): void
}): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const overview = useMessageOverview()
  const positions = overview.data?.positions ?? []
  const [menu, setMenu] = useState(false)
  const [remember, setRemember] = useState(true)
  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['messages'] })
  }
  const primary = suggest?.action ?? 'self'
  const aiPosition = suggest?.action === 'hand' ? suggest.position : undefined
  const selfHandle = kind === 'billing_system'

  const hand = useMutation({
    mutationFn: (position: string) => handMessageToPosition(messageId, position, remember),
    onSuccess: (out, position) => {
      setMenu(false)
      const name = positionName(positions, position, lang)
      if (out.handed_off) onDone({ tone: 'ok', text: t('messages.hand.done', { name }) })
      else onDone({ tone: 'warn', text: out.refused ?? t('messages.hand.closed', { name }) })
    },
    onError: (e) => {
      onDone({ tone: 'error', text: apiErrorText(e, t) })
    },
    onSettled: refresh,
  })
  const claim = useMutation({
    mutationFn: (as: 'notice' | 'me') => claimMessage(messageId, as),
    onSuccess: (_r, as) => {
      onDone({
        tone: 'ok',
        text: t(as === 'notice' ? 'messages.action.noticed' : 'messages.action.mine'),
        undo: () => {
          void claimMessage(messageId, 'none').then(refresh, (e: unknown) => {
            onDone({ tone: 'error', text: apiErrorText(e, t) })
          })
        },
      })
    },
    onError: (e) => {
      onDone({ tone: 'error', text: apiErrorText(e, t) })
    },
    onSettled: refresh,
  })
  const busy = hand.isPending || claim.isPending
  const variant = (action: MessageSuggest['action']): 'default' | 'outline' =>
    action === primary ? 'default' : 'outline'

  const handButton = (
    <Popover
      key="hand"
      open={menu}
      onOpenChange={setMenu}
      testId="hand-menu"
      trigger={
        <span className="inline-flex">
          {aiPosition === undefined ? null : (
            <Button
              size="sm"
              variant={variant('hand')}
              className="rounded-r-none"
              data-testid="hand-primary"
              data-position={aiPosition}
              disabled={busy}
              onClick={() => {
                hand.mutate(aiPosition)
              }}
            >
              {t('messages.hand.to', { name: positionName(positions, aiPosition, lang) })}
            </Button>
          )}
          <Button
            size="sm"
            variant={variant('hand')}
            className={cn(aiPosition !== undefined && 'rounded-l-none border-l-0 px-1.5')}
            data-testid="hand-more"
            aria-label={t('messages.hand.more')}
            aria-expanded={menu}
            disabled={busy}
            onClick={() => {
              setMenu((v) => !v)
            }}
          >
            {aiPosition === undefined ? t('messages.hand.generic') : null}
            <ChevronDown
              aria-hidden
              className={cn('size-3.5', aiPosition === undefined && 'ml-1')}
            />
          </Button>
        </span>
      }
    >
      <HandMenu
        positions={positions}
        ai={aiPosition}
        kind={kind}
        busy={busy}
        onPick={(id) => {
          hand.mutate(id)
        }}
      />
    </Popover>
  )
  const noticeButton = (
    <Button
      key="notice"
      size="sm"
      variant={variant('notice')}
      data-testid="hand-notice"
      disabled={busy}
      onClick={() => {
        claim.mutate('notice')
      }}
    >
      {t('messages.action.notice')}
    </Button>
  )
  const selfButton = (
    <Button
      key="self"
      size="sm"
      variant={variant('self')}
      data-testid="hand-self"
      disabled={busy}
      onClick={() => {
        if (selfHandle) claim.mutate('me')
        else onSelf()
      }}
    >
      {t(selfHandle ? 'messages.action.self_handle' : 'messages.action.self')}
    </Button>
  )
  const order =
    primary === 'hand'
      ? [handButton, noticeButton, selfButton]
      : primary === 'notice'
        ? [noticeButton, handButton, selfButton]
        : [selfButton, handButton, noticeButton]
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-testid="hand-actions"
      data-primary={primary}
    >
      {order}
      {primary === 'hand' ? (
        <label className="ml-1 flex items-center gap-1.5 text-[12px] text-ws-muted-fg">
          <input
            type="checkbox"
            data-testid="hand-remember"
            checked={remember}
            onChange={(e) => {
              setRemember(e.target.checked)
            }}
          />
          {t('messages.hand.remember')}
        </label>
      ) : null}
    </div>
  )
}

/** ▾ 里那一列：AI 建议的在最上面；没开的灰着、说为什么；底下一句交出去之后怎样。 */
function HandMenu({
  positions,
  ai,
  kind,
  busy,
  onPick,
}: {
  positions: readonly MessagePositionOption[]
  ai: string | undefined
  kind: MessageKind | undefined
  busy: boolean
  onPick(id: string): void
}): ReactNode {
  const { t, lang } = useApp()
  const sorted = [...positions].sort(
    (a, b) => Number(b.id === ai) - Number(a.id === ai) || Number(b.open) - Number(a.open),
  )
  const noteName = positionName(positions, ai ?? sorted.find((p) => p.open)?.id ?? '', lang)
  return (
    <div
      className="flex w-64 flex-col gap-0.5 p-1.5"
      role="listbox"
      aria-label={t('messages.hand.title')}
    >
      <div className="px-2 pt-1 pb-1.5 text-[11px] text-ws-muted-fg">
        {t('messages.hand.title')}
      </div>
      {sorted.map((p) => {
        const name = lang === 'en' ? p.name_en : p.name_zh
        return (
          <button
            key={p.id}
            type="button"
            role="option"
            aria-selected={p.id === ai}
            aria-disabled={!p.open}
            data-testid="hand-option"
            data-position={p.id}
            data-open={p.open ? 'true' : 'false'}
            disabled={!p.open || busy}
            title={p.open ? undefined : t('messages.hand.closed', { name })}
            className={cn(
              'flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[13px]',
              p.open ? 'hover:bg-ws-surface' : 'cursor-not-allowed text-ws-muted-fg opacity-60',
              p.id === ai && 'bg-ws-tint font-medium text-ws-brand-ink',
            )}
            onClick={() => {
              onPick(p.id)
            }}
          >
            <span className="flex-1 truncate">{name}</span>
            {p.id === ai && kind !== undefined ? (
              <span className="shrink-0 text-[11px] text-ws-muted-fg">
                {t('messages.hand.ai', { kind: t(`messages.kind.${kind}`) })}
              </span>
            ) : !p.open ? (
              <span className="shrink-0 text-[11px]">{t('messages.hand.closed_short')}</span>
            ) : null}
          </button>
        )
      })}
      <p className="mt-1 border-t border-ws-line px-2 pt-2 text-[11px] leading-relaxed text-ws-muted-fg">
        {t('messages.hand.note', { name: noteName })}
      </p>
    </div>
  )
}
