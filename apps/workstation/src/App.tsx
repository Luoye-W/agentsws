/**
 * 应用外壳：先拿会话（本地单机档自动 magic-link），再装 shell 与路由。
 *
 * 全应用只有一个后端：`/v1`。没有模型 SDK，没有全局聊天框。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/app-shell'
import { Skeleton } from '@/components/ui/skeleton'
import { ensureSession, getHome, getPositions, setAssignment, setHomeTiles } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { CalendarPage } from '@/pages/calendar'
import { GoalsPage } from '@/pages/goals'
import { HomePage } from '@/pages/home'
import { KnowledgePage } from '@/pages/knowledge'
import { MatterPage } from '@/pages/matter'
import { MeetingPage } from '@/pages/meeting'
import { MeetingsPage } from '@/pages/meetings'
import { PositionPage } from '@/pages/position'
import { SettingsPage } from '@/pages/settings'
import { TodosPage } from '@/pages/todos'

export function App(): ReactNode {
  const { t, selectPosition, position } = useApp()
  const client = useQueryClient()

  const session = useQuery({ queryKey: ['session'], queryFn: ensureSession, retry: false })

  const positions = useQuery({
    queryKey: ['positions', session.data?.person.id],
    enabled: session.data !== undefined,
    queryFn: async () => {
      // 先随便绑一个自己的 Assignment，否则网关会因为缺 X-Assignment 拒（31 §3.1）
      const first = session.data?.assignments.find((a) => a.revoked_at === undefined)
      if (first !== undefined && position === null) {
        setAssignment(first.id)
        selectPosition(first.id)
      }
      return getPositions()
    },
  })

  // 命令面板要能搜卡片：拿首页的队列就够（跨岗位合并过了）
  const home = useQuery({
    queryKey: ['home', 'yesterday'],
    enabled: positions.data !== undefined,
    queryFn: () => getHome('yesterday'),
  })

  const addTile = useMutation({
    mutationFn: (input: { position_id: string; tile_id: string }) => {
      const found = positions.data?.positions.find((p) => p.position_id === input.position_id)
      const next = [...(found?.tile_ids ?? []), input.tile_id]
      return setHomeTiles(input.position_id, next, undefined)
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['positions'] })
      void client.invalidateQueries({ queryKey: ['home'] })
    },
  })

  if (session.error !== null) {
    return (
      <div className="p-6">
        <p role="alert" className="text-sm text-destructive">
          {t('error.generic')}：{session.error.message}
        </p>
      </div>
    )
  }
  if (positions.data === undefined) {
    return (
      <div className="p-6">
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <AppShell
      positions={positions.data.positions}
      cards={home.data?.queue ?? []}
      tileLibrary={positions.data.tile_library}
      onAddTile={(position_id, tile_id) => {
        addTile.mutate({ position_id, tile_id })
      }}
    >
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/positions/:id" element={<PositionPage />} />
        {/* 37 工作模型：事项 / 待办 / 日历 / 目标 */}
        <Route path="/matters/:id" element={<MatterPage />} />
        <Route path="/todos" element={<TodosPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/goals" element={<GoalsPage />} />
        <Route path="/meetings" element={<MeetingsPage />} />
        <Route path="/meetings/:id" element={<MeetingPage />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route
          path="/settings"
          element={
            <SettingsPage
              {...(session.data === undefined ? {} : { identity: session.data.person.email })}
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}
