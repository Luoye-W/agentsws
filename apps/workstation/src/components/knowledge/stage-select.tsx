/**
 * WP488（决策 1682）：一条知识的范围（公共 / 售前 / 售后）——卡上就地改。
 *
 * 一个小下拉，不另开编辑器；改了马上存（`POST /v1/knowledge/cards/:id/stage`），知识库页与第三栏一起刷新。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { type KnowledgeCardRow, type KnowledgeStageId, setKnowledgeCardStage } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export const STAGE_IDS: readonly KnowledgeStageId[] = ['both', 'presales', 'postsales']

export function StageSelect({
  value,
  onChange,
  disabled = false,
  testId,
}: {
  value: KnowledgeStageId
  onChange(next: KnowledgeStageId): void
  disabled?: boolean
  testId?: string
}): ReactNode {
  const { t } = useApp()
  return (
    <select
      value={value}
      disabled={disabled}
      aria-label={t('kl.stage.label')}
      data-testid={testId}
      className="h-6 rounded-md border border-ws-line bg-ws-card px-1 text-xs text-ws-body"
      onChange={(e) => onChange(e.target.value as KnowledgeStageId)}
    >
      {STAGE_IDS.map((s) => (
        <option key={s} value={s}>
          {t(`kl.tab.${s}`)}
        </option>
      ))}
    </select>
  )
}

/** 知识库一行上的那一个（改了就存）。 */
export function CardStageSelect({ card }: { card: KnowledgeCardRow }): ReactNode {
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: (stage: KnowledgeStageId) => setKnowledgeCardStage(card.id, stage),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['knowledge-cards'] })
      void client.invalidateQueries({ queryKey: ['knowledge', 'cards'] })
    },
  })
  return (
    <StageSelect
      value={card.stage ?? 'both'}
      disabled={save.isPending || card.status === 'retired'}
      testId="knowledge-row-stage"
      onChange={(s) => save.mutate(s)}
    />
  )
}
