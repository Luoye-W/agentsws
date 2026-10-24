/**
 * WP504（决策 1765、1779 A）：知识库搬进岗位第三栏（客服是主场；B2B / 网站运营同一个面板按本岗位筛），
 * 旧整页 `/knowledge` 改成**跳转**：当前岗位用知识就开在当前岗位，不用的就跳到客服岗位；
 * 一个用知识的岗位都没有就跳首页、照样开那一格。原来那一页的五块（导入导出 / 要复核 / 上传 / 缺口 / 清单）
 * 全在面板里：`components/knowledge/knowledge-library-panel.tsx`。
 */
import { useQuery } from '@tanstack/react-query'
import { Navigate, useSearchParams } from 'react-router-dom'
import {
  KNOWLEDGE_LIBRARY,
  KNOWLEDGE_POSITIONS,
} from '@/components/knowledge/knowledge-library-status'
import { Skeleton } from '@/components/ui/skeleton'
import { getPositions, type PositionInstanceData } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { myAssignments } from '@/lib/positions'

/** 跳到哪（纯函数，测试用）。 */
export function knowledgeTarget(
  instances: readonly PositionInstanceData[],
  current: string | null,
  search: URLSearchParams,
): string {
  const here = instances.find((i) => current !== null && myAssignments(i).includes(current))
  const usable = (i: PositionInstanceData): boolean =>
    KNOWLEDGE_POSITIONS.includes(i.position_id) && myAssignments(i).length > 0
  const target =
    here !== undefined && usable(here)
      ? here
      : KNOWLEDGE_POSITIONS.map((id) => instances.find((i) => i.position_id === id)).find(
          (i): i is PositionInstanceData => i !== undefined && usable(i),
        )
  const next = new URLSearchParams(search)
  next.set('panel', KNOWLEDGE_LIBRARY)
  const asg =
    target === undefined
      ? undefined
      : target === here && current !== null
        ? current
        : myAssignments(target)[0]
  const base = asg === undefined ? '/' : `/positions/${encodeURIComponent(asg)}`
  return `${base}?${next.toString()}`
}

export function KnowledgePage(): React.ReactNode {
  const { position } = useApp()
  const [search] = useSearchParams()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  if (positions.isPending)
    return (
      <div data-testid="knowledge-redirecting">
        <Skeleton className="h-8 w-64" />
      </div>
    )
  return (
    <Navigate replace to={knowledgeTarget(positions.data?.instances ?? [], position, search)} />
  )
}
