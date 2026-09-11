/**
 * 应用外壳：先拿会话（本地单机档自动 magic-link），再装 shell 与路由。
 *
 * 全应用只有一个后端：`/v1`。没有模型 SDK，没有全局聊天框。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppShell } from '@/components/app-shell'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ensureSession,
  getHome,
  getOnboardingState,
  getPositions,
  NeedsLoginError,
  setAssignment,
  setHomeTiles,
  storedToken,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { connectRealtime } from '@/lib/realtime'
import { CalendarPage } from '@/pages/calendar'
import { ConnectionsPage } from '@/pages/connections'
import { GoalsPage } from '@/pages/goals'
import { HomePage } from '@/pages/home'
import { KnowledgePage } from '@/pages/knowledge'
import { LoginPage } from '@/pages/login'
import { MatterPage } from '@/pages/matter'
import { MeetingPage } from '@/pages/meeting'
import { MeetingsPage } from '@/pages/meetings'
import { OnboardingPage, onboardingSkipped } from '@/pages/onboarding'
import { OrgPage } from '@/pages/org'
import { PeoplePage, PersonPage } from '@/pages/people'
import { PositionPage } from '@/pages/position'
import { SecretaryPage } from '@/pages/profile'
import { SettingsPage } from '@/pages/settings'
import { SkillsPage } from '@/pages/skills'
import { TodosPage } from '@/pages/todos'

/**
 * 登录与接受邀请这两条路不需要会话（WP28）：同事点着邀请链接进来时，
 * 他在这个工作区里还什么都不是——先接受、再登录，然后才谈得上岗位与卡片。
 */
export function App(): ReactNode {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite/:token" element={<LoginPage />} />
      <Route path="*" element={<Workspace />} />
    </Routes>
  )
}

function Workspace(): ReactNode {
  const { t, selectPosition, position } = useApp()
  const client = useQueryClient()
  const location = useLocation()

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

  /**
   * 46 §1 末段：向导只在**这个工作区还没设过公司名**的时候弹（服务端的
   * `needs_setup` 还多看一条——除所有者外没有别的分配，免得一个用了半年的
   * 工作区在第 100 天被弹一次）。
   */
  const onboarding = useQuery({
    queryKey: ['onboarding', 'state'],
    enabled: positions.data !== undefined,
    queryFn: () => getOnboardingState(),
    // 弹不弹向导这件事不该因为一次网络抖动就把人挡在外面
    retry: false,
  })

  // 命令面板要能搜卡片：拿首页的队列就够（跨岗位合并过了）
  const home = useQuery({
    queryKey: ['home', 'yesterday'],
    enabled: positions.data !== undefined,
    queryFn: () => getHome('yesterday'),
  })

  /**
   * WP33：实时刷新。收到摘要就让对应的查询失效，TanStack Query 自己重取。
   *
   * 连不上（浏览器拦了 WS、代理不支持）就什么都不发生——各页面原有的手动 invalidate
   * 一直都在，工作台照常能用，只是要多点一下才看得到别人刚做完的事。
   */
  useEffect(() => {
    if (position === null || session.data === undefined) return
    const handle = connectRealtime({
      client,
      assignment: position,
      token: storedToken() ?? undefined,
    })
    return () => {
      handle.stop()
    }
  }, [client, position, session.data])

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

  // WP28：没有会话不是错误，是"该登录了"——工作区现在可能不止一个人
  if (session.error instanceof NeedsLoginError) return <LoginPage />
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

  // 第一次打开 → 直接进四步向导。"先跳过"之后这一次会话里不再拦。
  if (
    onboarding.data?.needs_setup === true &&
    !onboardingSkipped() &&
    location.pathname !== '/onboarding'
  ) {
    return <Navigate to="/onboarding" replace />
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
        {/* 46 §1：首次设置向导（公司 → 你 → 你做什么 → 要配的东西） */}
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/positions/:id" element={<PositionPage />} />
        {/* 37 工作模型：事项 / 待办 / 日历 / 目标 */}
        <Route path="/matters/:id" element={<MatterPage />} />
        <Route path="/todos" element={<TodosPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/goals" element={<GoalsPage />} />
        <Route path="/meetings" element={<MeetingsPage />} />
        <Route path="/meetings/:id" element={<MeetingPage />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        {/* 24 技能与学习回路：当前版本、三层 overlay、待审提案 */}
        <Route path="/skills" element={<SkillsPage />} />
        {/* 41 §1 个人代理（原「秘书」）：我的代理（问 / profile 与公开级别 / 谁问过我 / 约时间） */}
        <Route path="/secretary" element={<SecretaryPage />} />
        <Route path="/people" element={<PeoplePage />} />
        <Route path="/people/:id" element={<PersonPage />} />
        {/* WP28 制度面：岗位 / 成员 / 职责 */}
        <Route path="/org" element={<OrgPage />} />
        {/* WP20 连接向导：左栏「连接」与各处「去连接」都跳这里（?service= 高亮那张卡） */}
        <Route path="/connections" element={<ConnectionsPage />} />
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
