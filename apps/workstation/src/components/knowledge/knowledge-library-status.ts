/**
 * WP504：知识库 / 素材的**轻的那一半**（卡片列判出不出、卡头那个数）——注册表启动时就读，不拉整个面板。
 */
import { useQuery } from '@tanstack/react-query'
import type { RailScope } from '@/components/rail/rail-scope'
import type { CardStatus, RailPanelBodyProps } from '@/components/rail/registry'
import { listKnowledgeCards } from '@/lib/api'

export const KNOWLEDGE_LIBRARY = 'knowledge-library'

/**
 * 1779 A：用知识的岗位（卡片列有「知识库」卡、`/knowledge` 跳到这里）。客服是主场，排第一；
 * 不在这里的岗位从 `/knowledge` 进来时去客服。
 */
export const KNOWLEDGE_POSITIONS: readonly string[] = ['customer-care', 'b2b', 'web-ops']

/** 1779 A：素材面板在设计岗位（全局 `/brand-assets` 照旧是总库）。 */
export const BRAND_ASSETS_POSITIONS: readonly string[] = ['design']

/** 这一层是哪个岗位（职责层取它的上一层）。 */
export function positionOf(scope: RailScope | undefined): string | undefined {
  if (scope === undefined) return undefined
  return scope.tier === 'role' ? scope.parent?.scope_id : scope.scope_id
}

export function usesKnowledge(props: Pick<RailPanelBodyProps, 'scope'>): boolean {
  const p = positionOf(props.scope)
  return p !== undefined && KNOWLEDGE_POSITIONS.includes(p)
}

export function usesBrandAssets(props: Pick<RailPanelBodyProps, 'scope'>): boolean {
  const p = positionOf(props.scope)
  return p !== undefined && BRAND_ASSETS_POSITIONS.includes(p)
}

/**
 * 卡片列「知识库 N」的 N：在用的条数——退役的、停用的（WP506 决策 1789 B）都不算，
 * 和卡身里公共 / 售前 / 售后三格的数对得上（int/1039 实拍时头上 14、卡身 12）。
 */
export function liveKnowledgeCount(
  cards: readonly { status: string; disabled_at?: string | undefined }[],
): number {
  return cards.filter((c) => c.status !== 'retired' && c.disabled_at === undefined).length
}

export function useKnowledgeLibraryStatus(_props: RailPanelBodyProps): CardStatus | undefined {
  const cards = useQuery({ queryKey: ['knowledge-cards'], queryFn: () => listKnowledgeCards() })
  if (cards.data === undefined) return undefined
  return { count: liveKnowledgeCount(cards.data) }
}
