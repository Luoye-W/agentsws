/**
 * 路由。`basename` 是 `/admin`——产物由云进程在那一段下托管（65 §8）。
 *
 * 没有 404 页：服务端对无权者一律 404，请求层收到 404 会把人送回登录页
 * （见 `lib/api.ts`），所以这里剩下的只有"路径打错了"，退回总览就好。
 */

import { Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from '@/components/layout'
import { AuditPage } from '@/pages/audit'
import { CreditsPage } from '@/pages/credits'
import { HealthPage } from '@/pages/health'
import { OrgsPage } from '@/pages/orgs'
import { OverviewPage } from '@/pages/overview'
import { UsagePage } from '@/pages/usage'
import { UsersPage } from '@/pages/users'

export function App(): React.ReactNode {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/orgs" element={<OrgsPage />} />
        <Route path="/usage" element={<UsagePage />} />
        <Route path="/credits" element={<CreditsPage />} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}
