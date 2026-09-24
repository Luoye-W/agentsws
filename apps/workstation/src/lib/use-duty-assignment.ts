/**
 * WP139：`pickAssignment` 的 React 一侧——从 `/v1/me`（与外壳共用 `['session']` 这份缓存）
 * 里挑这一页该用的分配。
 *
 * 问不到 `/v1/me`（老服务进程、测试替身没给）就回 `fallback`：退回老行为，
 * 用全局当前岗位发请求——宁可像以前那样可能 403，也不把整页挡死。
 */
import { useQuery } from '@tanstack/react-query'
import { ensureSession } from './api'
import { useApp } from './app-context'
import { type AssignmentPick, type DutyNeed, pickAssignment } from './pick-assignment'

export type DutyAssignmentState = { kind: 'loading' } | { kind: 'fallback' } | AssignmentPick

export function useDutyAssignment(need: DutyNeed): DutyAssignmentState {
  const { position } = useApp()
  const me = useQuery({ queryKey: ['session'], queryFn: ensureSession, retry: false })
  if (me.data !== undefined) return pickAssignment(me.data.assignments, need, position)
  if (me.isPending) return { kind: 'loading' }
  return { kind: 'fallback' }
}

/** 这一页的请求该带哪条 `X-Assignment`；`undefined` = 用全局当前岗位（老行为）。 */
export function assignmentOf(state: DutyAssignmentState): string | undefined {
  return state.kind === 'ok' || state.kind === 'no_range' ? state.assignment : undefined
}

/** 能不能发请求：挑到了、或者问不到身份只好退回老行为。 */
export function canRequest(state: DutyAssignmentState): boolean {
  return state.kind === 'ok' || state.kind === 'fallback'
}
