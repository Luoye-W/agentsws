/**
 * WP372（决策 1019）：岗位页中间栏回到对话框形态，「工作」与数据看板搬进右侧面板「报表」的下半截
 * （`PositionBoards`）。老用例测的是同一页上的那几块，这里把两样并排挂在 `/positions/:id` 上——
 * 真应用里一个在中间栏、一个在右侧面板，组件本身没变。
 */
import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { PositionBoards } from '@/components/reports/scope-boards'
import { PositionPage } from '@/pages/position'

export function PositionWithBoards(): ReactNode {
  const { id } = useParams<{ id: string }>()
  return (
    <>
      <PositionPage />
      <PositionBoards id={id ?? ''} />
    </>
  )
}
