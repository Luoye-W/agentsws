/**
 * WP469：「日历与待办」两面、左栏数字、首页那一行、收件箱「记成待办」共用的取数与改动。
 *
 * 没做完的待办是同一份（`['todos']`，和以前待办页同一个键——别处 invalidate 它照旧生效）；
 * 做完的另一份（`['todos', 'done']`）：清单「今天」里留到当天结束、「做完的」那一组、日历上划掉的那几条。
 */
import type { Todo } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import {
  completeTodo,
  delegateTodo,
  dropTodo,
  getPositions,
  listTodos,
  updateTodo,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import type { TodoPatch } from '@/lib/cal-todo'

export const OPEN_TODOS_QUERY = ['todos'] as const
export const DONE_TODOS_QUERY = ['todos', 'done'] as const

export function useOpenTodos(enabled = true) {
  return useQuery({
    queryKey: OPEN_TODOS_QUERY,
    queryFn: () => listTodos('?status=open,doing,blocked'),
    enabled,
    retry: false,
  })
}

export function useDoneTodos(enabled = true) {
  return useQuery({
    queryKey: DONE_TODOS_QUERY,
    queryFn: () => listTodos('?status=done'),
    enabled,
    retry: false,
  })
}

/** 改完一条：待办两份、首页、日历都重取。 */
export function useTodoRefresh(): () => void {
  const client = useQueryClient()
  return useCallback(() => {
    void client.invalidateQueries({ queryKey: OPEN_TODOS_QUERY })
    void client.invalidateQueries({ queryKey: ['home'] })
    void client.invalidateQueries({ queryKey: ['calendar'] })
  }, [client])
}

export type TodoOp =
  | { op: 'done' }
  | { op: 'undone' }
  | { op: 'drop' }
  | { op: 'delegate' }
  | { op: 'patch'; patch: TodoPatch }

/** 一条待办上的几种改法（打勾 / 取消打勾 / 关闭 / 交给 AI / 换档）。 */
export function useTodoAct(onError?: (e: Error) => void) {
  const refresh = useTodoRefresh()
  return useMutation({
    mutationFn: async (input: { id: string } & TodoOp): Promise<{ todo: Todo }> => {
      if (input.op === 'done') return completeTodo(input.id)
      if (input.op === 'undone') return updateTodo(input.id, { status: 'open' })
      if (input.op === 'drop') return dropTodo(input.id)
      if (input.op === 'delegate') return delegateTodo(input.id)
      return updateTodo(input.id, input.patch)
    },
    onSettled: refresh,
    ...(onError === undefined ? {} : { onError }),
  })
}

/** 待办上的 `position_id`（一条分配）→ 岗位名（「红人营销」）；认不出就不写。 */
export function usePositionName(): (assignment_id: string | undefined) => string | undefined {
  const { lang } = useApp()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions, staleTime: 60_000 })
  const instances = positions.data?.instances
  return useCallback(
    (assignment_id) => {
      if (assignment_id === undefined || instances === undefined) return undefined
      const hit = instances.find((p) => p.roles.some((r) => r.my_assignment_id === assignment_id))
      if (hit === undefined) return undefined
      return lang === 'en' ? hit.name.en : hit.name.zh
    },
    [instances, lang],
  )
}
