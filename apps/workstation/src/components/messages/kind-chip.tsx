/**
 * WP212（docs/88 §3.3）：**类型胶囊**——每条消息"这件事是什么"，灰胶囊带 ✎，点开改判。
 *
 * - 拿不准时写把握：「像是售后 · 把握 52%」（人改过的、发件人规则给的不写——那两种没什么好拿不准的）；
 * - 点开是一个**只有预设选项**的小单选层（36 §13.2），层顶写「把握 91% · 模型」/「发件人规则」/「你改过」；
 * - 「以后这个发件人都这样」默认勾着 → 写发件人规则（模型之前跑，下次不花钱）；
 *   不勾的改动进学习回路，「你教过它」里看得见。
 *
 * WP441（docs/108 §5.1.5）：**为什么这样处理**——命中了消息规则的，层顶写「规则：结算通知 · 另有 1 条也命中」，
 * 下面两个按钮：「这封不该归它」（给那条规则加这个发件人的排除，当场生效）、「在对话里改」（带着这封信和这条规则
 * 进助理对话）。
 */
import type { MessageKind, MessageKindBy, MessageRuleHit } from '@agentsws/contracts'
import { MESSAGE_KINDS } from '@agentsws/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, MessageSquare, Pencil, UserX } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { setPendingAsk } from '@/components/free-chat/pending-ask'
import { excludeFromMessageRule, setMessageKind } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { apiErrorText } from '@/lib/error-text'
import { cn } from '@/lib/utils'
import { Popover } from './popover'

/** 把握低于这条就写「像是 X · 把握 N%」。 */
export const KIND_SURE = 0.8

export function kindLabel(
  t: (key: string, vars?: Record<string, string | number>) => string,
  kind: MessageKind,
  confidence: number | undefined,
  by: MessageKindBy | undefined,
): string {
  const name = t(`messages.kind.${kind}`)
  const sure = by === 'user' || by === 'sender_rule' || (confidence ?? 1) >= KIND_SURE
  return sure
    ? name
    : t('messages.kind.unsure', { kind: name, pct: Math.round((confidence ?? 0) * 100) })
}

export function KindChip({
  messageId,
  kind,
  confidence,
  by,
  ruleHits,
  ruleRoute,
  about,
  onDone,
}: {
  messageId: string
  kind: MessageKind
  confidence?: number | undefined
  by?: MessageKindBy | undefined
  /** WP441：这封信命中的消息规则（按清单顺序）。 */
  ruleHits?: readonly MessageRuleHit[] | undefined
  /** WP441：去向由哪条规则定的。 */
  ruleRoute?: string | undefined
  /** WP441：「在对话里改」时带进对话的那封信（发件人、主题）。 */
  about?: { from: string; subject: string } | undefined
  /** 改完之后那一句（交给页面的提示条）。 */
  onDone?(text: string, tone: 'ok' | 'error'): void
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(true)
  const navigate = useNavigate()
  const hits = ruleHits ?? []
  const lead = hits.find((h) => h.rule_id === ruleRoute) ?? hits[0]
  const exclude = useMutation({
    mutationFn: (rule_id: string) => excludeFromMessageRule(messageId, rule_id),
    onSuccess: () => {
      setOpen(false)
      onDone?.(t('messages.rule.excluded', { name: lead?.name ?? '' }), 'ok')
    },
    onError: (e) => {
      onDone?.(apiErrorText(e, t), 'error')
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['messages'] })
    },
  })
  const save = useMutation({
    mutationFn: (next: MessageKind) => setMessageKind(messageId, next, remember),
    onSuccess: (_r, next) => {
      setOpen(false)
      const name = t(`messages.kind.${next}`)
      onDone?.(
        t(remember ? 'messages.kind.remembered' : 'messages.kind.changed', { kind: name }),
        'ok',
      )
    },
    onError: (e) => {
      onDone?.(apiErrorText(e, t), 'error')
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['messages'] })
    },
  })
  const pct = Math.round((by === 'user' || by === 'sender_rule' ? 1 : (confidence ?? 1)) * 100)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      testId="kind-popover"
      trigger={
        <button
          type="button"
          data-testid="kind-chip"
          data-kind={kind}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={t('messages.kind.edit')}
          className="inline-flex items-center gap-1 rounded-full bg-ws-surface px-2 py-0.5 text-[12px] text-ws-body hover:bg-ws-tint"
          onClick={() => {
            setOpen((v) => !v)
          }}
        >
          {kindLabel(t, kind, confidence, by)}
          <Pencil aria-hidden className="size-3 text-ws-muted-fg" />
        </button>
      }
    >
      <div className="flex w-56 flex-col gap-1 p-1.5">
        <div
          className="px-2 pt-1 pb-1.5 text-xs text-ws-muted-fg"
          data-testid="kind-popover-head"
        >
          {lead === undefined
            ? t('messages.kind.head', { pct, by: t(`messages.kind.by.${by ?? 'model'}`) })
            : t(hits.length > 1 ? 'messages.rule.head.more' : 'messages.rule.head', {
                name: lead.name ?? '',
                n: hits.length - 1,
                ...(lead.by === 'ai' && lead.confidence !== undefined
                  ? { pct: Math.round(lead.confidence * 100) }
                  : {}),
              })}
        </div>
        {lead === undefined ? null : (
          <div
            className="flex flex-col gap-0.5 border-b border-ws-line pb-1.5"
            data-testid="kind-rule-why"
          >
            <button
              type="button"
              data-testid="kind-rule-exclude"
              disabled={exclude.isPending}
              className="flex items-center gap-2 rounded-[8px] px-2 py-1 text-left text-[12px] hover:bg-ws-surface disabled:opacity-60"
              onClick={() => {
                exclude.mutate(lead.rule_id)
              }}
            >
              <UserX aria-hidden className="size-3.5 text-ws-muted-fg" />
              {t('messages.rule.exclude')}
            </button>
            <button
              type="button"
              data-testid="kind-rule-chat"
              className="flex items-center gap-2 rounded-[8px] px-2 py-1 text-left text-[12px] hover:bg-ws-surface"
              onClick={() => {
                setPendingAsk({
                  text: t('messages.rule.chat_text', {
                    name: lead.name ?? '',
                    from: about?.from ?? '',
                    subject: about?.subject ?? '',
                  }),
                  files: [],
                })
                navigate('/assistant')
              }}
            >
              <MessageSquare aria-hidden className="size-3.5 text-ws-muted-fg" />
              {t('messages.rule.chat')}
            </button>
          </div>
        )}
        {MESSAGE_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={k === kind}
            data-testid="kind-option"
            data-kind={k}
            disabled={save.isPending}
            className={cn(
              'flex items-center gap-2 rounded-[8px] px-2 py-1 text-left text-[13px] hover:bg-ws-surface disabled:opacity-60',
              k === kind && 'font-medium text-ws-brand-ink',
            )}
            onClick={() => {
              if (k === kind) setOpen(false)
              else save.mutate(k)
            }}
          >
            <span className="flex size-3.5 items-center justify-center">
              {k === kind ? <Check aria-hidden className="size-3.5" /> : null}
            </span>
            {t(`messages.kind.${k}`)}
          </button>
        ))}
        <label className="mt-1 flex items-center gap-2 border-t border-ws-line px-2 pt-2 text-[12px] text-ws-muted-fg">
          <input
            type="checkbox"
            data-testid="kind-remember"
            checked={remember}
            onChange={(e) => {
              setRemember(e.target.checked)
            }}
          />
          {t('messages.hand.remember')}
        </label>
      </div>
    </Popover>
  )
}
