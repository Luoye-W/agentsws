/**
 * WP506（决策 1796 C）：「停用 / 启用这几条知识？」卡的卡身——AI 提的，人点了才生效。
 *
 * - 列出是哪几条（正文前一行，多了「+N」可展开）与 AI 的理由（外来文字原样显示）；
 * - 主按钮「停用 N 条」/「启用 N 条」、「不用」在卡底那一排（`deckActionLabel` 按 form 换字）；
 * - 批了之后：「已停用 N 条 · 撤销」——撤销是人点的，走只给人点的那个停用 / 启用接口。
 */
import type { KnowledgeTogglePayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { setKnowledgeCardsDisabled } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export const isKnowledgeToggleBody = (p: unknown): p is KnowledgeTogglePayload =>
  typeof p === 'object' &&
  p !== null &&
  (p as { form?: unknown }).form === 'knowledge_toggle' &&
  Array.isArray((p as { items?: unknown }).items)

/** 卡上最多露几条（其余「+N」）。 */
const SHOWN = 5

export function KnowledgeToggleBody({
  card,
  payload,
}: {
  card: Pick<DeckCard, 'status' | 'position_id'>
  payload: KnowledgeTogglePayload
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const disabling = payload.action === 'disable'
  const items = payload.items
  const shown = open ? items : items.slice(0, SHOWN)
  const approved = card.status === 'approved' || card.status === 'approved_edited'
  const undo = useMutation({
    mutationFn: () =>
      setKnowledgeCardsDisabled(
        items.map((i) => i.id),
        !disabling,
        card.position_id,
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['knowledge-cards'] })
    },
  })
  return (
    <div className="mt-2.5 flex flex-col gap-2.5" data-testid="deck-knowledge-toggle">
      <ul className="flex flex-col divide-y divide-ws-line rounded-lg bg-ws-surface px-3 text-sm">
        {shown.map((i) => (
          <li
            key={i.id}
            className="truncate py-1.5 text-ws-body"
            data-testid="knowledge-toggle-item"
          >
            {i.statement.split('\n')[0]}
          </li>
        ))}
      </ul>
      {items.length > SHOWN ? (
        <button
          type="button"
          className="w-fit text-xs text-ws-muted-fg underline-offset-2 hover:underline"
          data-testid="knowledge-toggle-more"
          onClick={() => {
            setOpen((v) => !v)
          }}
        >
          {open ? t('kl.toggle.less') : t('kl.toggle.more', { n: items.length - SHOWN })}
        </button>
      ) : null}
      {payload.reason.trim() === '' ? null : (
        <p className="text-xs text-ws-muted-fg" data-testid="knowledge-toggle-reason">
          {t('kl.toggle.reason', { reason: payload.reason })}
        </p>
      )}
      {approved ? (
        <p className="flex items-center gap-2 text-xs" data-testid="knowledge-toggle-done">
          <span className="text-ws-body">
            {undo.isSuccess
              ? t('kl.toggle.undone')
              : t(disabling ? 'kl.toggle.done.disable' : 'kl.toggle.done.enable', {
                  n: items.length,
                })}
          </span>
          {undo.isSuccess ? null : (
            <button
              type="button"
              className="font-medium text-ws-brand hover:underline disabled:opacity-50"
              disabled={undo.isPending}
              data-testid="knowledge-toggle-undo"
              onClick={() => {
                undo.mutate()
              }}
            >
              {t('library.undo')}
            </button>
          )}
        </p>
      ) : null}
    </div>
  )
}
