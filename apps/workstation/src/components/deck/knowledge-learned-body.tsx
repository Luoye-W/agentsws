/**
 * WP488（决策 1680 / 1681 / 1682）：知识库「学一遍」的两张卡的卡身。
 *
 * - **学到 N 条**（`knowledge_update` + `form: 'knowledge_learned'`）：每条一问一答 + 依据（几段往来 / 哪一页）+
 *   范围下拉（公共 / 售前 / 售后，就地改）+「不要这条」；主按钮「采纳 K 条」带着改过的范围与去掉的那几条批
 *   （`approve` + `edited_payload.stages / drop`，服务端只认这两处改动）。「不采纳」= 整批作废，在卡底那一排。
 * - **这几条可能过期**（`form: 'knowledge_stale'`）：哪条、网站上哪个数变了；「都没变」/「按网站重学」/「忽略」。
 *
 * 少字：标题已经说了学到几条；WP495（1701）：只有答案里真写了承诺（退款 / 退货天数、保修期、赔付 / 补发、
 * 价格保证）的那几条挂一个小图标，悬停出「含承诺，细看一眼」；别的不挂。
 */
import {
  hasCommitment,
  type KnowledgeLearnedPayload,
  type KnowledgeStage,
  type KnowledgeStalePayload,
} from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { type FootAction, FootButtons, useCardFootActions } from '@/components/deck/card-foot'
import { CommitmentMark } from '@/components/knowledge/commitment-mark'
import { StageSelect } from '@/components/knowledge/stage-select'
import { decide } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export const isKnowledgeLearnedBody = (p: unknown): p is KnowledgeLearnedPayload =>
  typeof p === 'object' &&
  p !== null &&
  (p as { form?: unknown }).form === 'knowledge_learned' &&
  Array.isArray((p as { items?: unknown }).items)

export const isKnowledgeStaleBody = (p: unknown): p is KnowledgeStalePayload =>
  typeof p === 'object' &&
  p !== null &&
  (p as { form?: unknown }).form === 'knowledge_stale' &&
  Array.isArray((p as { recheck_ids?: unknown }).recheck_ids)

function useDecide(card: DeckCard) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { action: 'approve' | 'reject'; edited_payload?: unknown }) =>
      decide(
        card.id,
        { ...input, version: card.version, via: 'workstation' } as never,
        card.position_id,
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['approval'] })
      void client.invalidateQueries({ queryKey: ['deck'] })
      void client.invalidateQueries({ queryKey: ['matter'] })
      void client.invalidateQueries({ queryKey: ['knowledge-cards'] })
    },
  })
}

export function KnowledgeLearnedBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: KnowledgeLearnedPayload
}): ReactNode {
  const { t } = useApp()
  const decidable = card.available_actions.includes('approve')
  const [stages, setStages] = useState<Record<string, KnowledgeStage>>({})
  const [drop, setDrop] = useState<string[]>([])
  const send = useDecide(card)
  const done = send.isPending || send.isSuccess
  const keep = payload.card_ids.length - drop.length
  const edited = Object.keys(stages).length > 0 || drop.length > 0
  const actions: FootAction[] | null = decidable
    ? [
        {
          key: 'kl-confirm',
          label: t('kl.card.confirm', { n: keep }),
          primary: true,
          disabled: keep === 0 || done,
          testId: 'kl-card-confirm',
          onSelect: () => {
            send.mutate({
              action: 'approve',
              ...(edited ? { edited_payload: { ...payload, stages, drop } } : {}),
            })
          },
        },
      ]
    : null
  const hosted = useCardFootActions(actions)
  const more = payload.card_ids.length - payload.items.length
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="deck-knowledge-learned">
      <ul className="flex flex-col divide-y divide-ws-line rounded-lg bg-ws-surface px-3 text-[13px] leading-5">
        {payload.items.map((it) => {
          const dropped = drop.includes(it.card_id)
          return (
            <li
              key={it.card_id}
              className="flex flex-col gap-1 py-2"
              data-testid="kl-card-item"
              data-dropped={dropped ? 'yes' : 'no'}
            >
              <p className={dropped ? 'text-ws-muted-fg line-through' : 'font-medium text-ws-ink'}>
                {it.question}
              </p>
              <p className={dropped ? 'text-ws-muted-fg line-through' : 'text-ws-body'}>
                {it.answer}
              </p>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-ws-muted-fg">
                <StageSelect
                  value={stages[it.card_id] ?? it.stage}
                  disabled={!decidable || done || dropped}
                  testId="kl-card-stage"
                  onChange={(s) => setStages({ ...stages, [it.card_id]: s })}
                />
                <span className="truncate">{t('kl.card.basis', { basis: it.basis })}</span>
                {(it.commitment ?? hasCommitment(it.answer)) ? <CommitmentMark /> : null}
                {decidable ? (
                  <label className="ml-auto inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={dropped}
                      disabled={done}
                      data-testid="kl-card-drop"
                      onChange={(e) =>
                        setDrop(
                          e.target.checked
                            ? [...drop, it.card_id]
                            : drop.filter((x) => x !== it.card_id),
                        )
                      }
                    />
                    {t('kl.card.drop')}
                  </label>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
      {more > 0 ? (
        <p className="text-xs text-ws-muted-fg">{t('kl.card.more', { n: more })}</p>
      ) : null}
      {decidable && !hosted ? <FootButtons actions={actions ?? []} /> : null}
      {send.isError ? (
        <span className="text-xs text-ws-bad">
          {t('kl.card.failed', {
            message: send.error instanceof Error ? send.error.message : String(send.error),
          })}
        </span>
      ) : null}
    </div>
  )
}

export function KnowledgeStaleBody({
  card,
  payload,
}: {
  card: DeckCard
  payload: KnowledgeStalePayload
}): ReactNode {
  const { t } = useApp()
  const decidable = card.available_actions.includes('approve')
  const send = useDecide(card)
  const done = send.isPending || send.isSuccess
  const pick = (resolution: 'unchanged' | 'relearn'): void => {
    send.mutate({ action: 'approve', edited_payload: { ...payload, resolution } })
  }
  const actions: FootAction[] | null = decidable
    ? [
        {
          key: 'kl-stale-unchanged',
          label: t('kl.stale.unchanged'),
          primary: true,
          disabled: done,
          testId: 'kl-stale-unchanged',
          onSelect: () => pick('unchanged'),
        },
        {
          key: 'kl-stale-relearn',
          label: t('kl.stale.relearn'),
          disabled: done,
          testId: 'kl-stale-relearn',
          onSelect: () => pick('relearn'),
        },
      ]
    : null
  const hosted = useCardFootActions(actions)
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="deck-knowledge-stale">
      <ul className="flex flex-col gap-1.5 rounded-lg bg-ws-surface p-3 text-[13px] leading-5">
        {payload.items.map((it) => (
          <li key={it.recheck_id} className="min-w-0">
            <p className="line-clamp-2 text-ws-ink">{it.statement}</p>
            <p className="truncate text-xs text-ws-muted-fg" title={it.url}>
              {it.change === '' ? it.url : `${it.change} · ${it.url}`}
            </p>
          </li>
        ))}
      </ul>
      {decidable && !hosted ? <FootButtons actions={actions ?? []} /> : null}
    </div>
  )
}
