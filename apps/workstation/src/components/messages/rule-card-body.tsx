/**
 * WP441（docs/108 §5.1.2）：卡片流里「要建这条规则吗」那张卡的卡身——与规则面板顶上同一个样子
 * （一行白话、试跑、会改掉去向的几封、花了多少积分、「也处理过去 30 天的」），主按钮「建」在卡身里
 * （要带上那个勾）；「修改」把原话带回消息页的规则面板；「不要」= 这条不建。
 */
import type { MessageRuleDraft, MessageRuleTrial } from '@agentsws/contracts'
import { MESSAGE_RULE_FORM } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMessageOverview } from '@/components/messages/hand-actions'
import { setPendingRuleText } from '@/components/messages/rule-draft-text'
import { RuleProposalView } from '@/components/messages/rule-proposal'
import { decide } from '@/lib/api'
import { RAIL_KEY } from '@/lib/work-archive'

interface RuleCardPayload {
  form: typeof MESSAGE_RULE_FORM
  draft: MessageRuleDraft
  plain?: string
  trial?: MessageRuleTrial
  rule_id?: string
  revision?: number
}

export function isMessageRuleCardPayload(p: unknown): p is RuleCardPayload {
  if (typeof p !== 'object' || p === null) return false
  const o = p as Record<string, unknown>
  return o.form === MESSAGE_RULE_FORM && typeof o.draft === 'object' && o.draft !== null
}

const EMPTY_TRIAL: MessageRuleTrial = { scanned: 0, matched: 0, sample: [], changed: [] }

export function MessageRuleCardBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: RuleCardPayload
}): ReactNode {
  const client = useQueryClient()
  const navigate = useNavigate()
  const overview = useMessageOverview()
  const go = useMutation({
    mutationFn: (pick: 'after' | 'after_past' | 'before') =>
      decide(
        card.id,
        {
          action: 'approve',
          version: card.version,
          via: 'workstation',
          selected_option_id: pick,
        } as never,
        card.position_id,
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['approval'] })
      void client.invalidateQueries({ queryKey: ['deck'] })
      void client.invalidateQueries({ queryKey: RAIL_KEY })
      void client.invalidateQueries({ queryKey: ['messages'] })
    },
  })
  const decidable = card.available_actions.includes('approve')
  const done = go.isSuccess ? (go.variables === 'before' ? 'dropped' : 'built') : undefined
  return (
    <div className="mt-2.5" data-testid="deck-layout-message-rule">
      <RuleProposalView
        testId="deck-rule-proposal"
        name={payload.draft.name}
        plain={payload.plain ?? ''}
        trial={payload.trial ?? EMPTY_TRIAL}
        editing={payload.rule_id !== undefined}
        positions={overview.data?.positions}
        busy={go.isPending || !decidable}
        {...(done === undefined ? {} : { decided: done })}
        onBuild={(past) => {
          go.mutate(past ? 'after_past' : 'after')
        }}
        onEdit={() => {
          setPendingRuleText({
            text: payload.draft.origin_text,
            ...(payload.rule_id === undefined ? {} : { rule_id: payload.rule_id }),
            ...(payload.revision === undefined ? {} : { revision: payload.revision }),
          })
          go.mutate('before')
          navigate('/messages?panel=rules')
        }}
        onDrop={() => {
          go.mutate('before')
        }}
      />
    </div>
  )
}
