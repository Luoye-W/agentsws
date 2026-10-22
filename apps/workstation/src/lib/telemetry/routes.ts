/**
 * WP476：地址 → 路由模板（页面访问只报模板，不报具体的 id、查询串、`#…`）。
 *
 * `/positions/a_9f3/duties/dtc.customer-care?draft=…` → `/positions/:id/duties/:role_id`。
 * 设置弹窗的地址按 `settingsTargetOf` 归到 `/settings/<节>`（节名是代码里的固定编号）。
 * 认不出的一律 `/other`——宁可少一格信息，也不把一段没见过的地址原样带出去。
 *
 * 这张表与 `App.tsx` 的 `<Route path>` 一一对应；对不上时 `telemetry.test.ts` 会红。
 */
import { matchPath } from 'react-router-dom'
import { settingsTargetOf } from '@/components/settings-panel/route'

/** 每条都与 `App.tsx` 里的一条 `<Route path>` 对应（`?` 可选段写成两条）。 */
export const ROUTE_TEMPLATES = [
  '/',
  '/login',
  '/invite/:token',
  '/join/:code',
  '/assistant',
  '/assistant/:id',
  '/free-chat',
  '/free-chat/:id',
  '/onboarding',
  '/positions/:id',
  '/positions/:assignment/duties/:role_id',
  '/matters/:id',
  '/cards/:id',
  '/todos',
  '/calendar',
  '/goals',
  '/messages',
  '/inbox',
  '/meetings',
  '/meetings/:id',
  '/knowledge',
  '/in-progress',
  '/org',
  '/settings/inprogress',
  '/chat',
  '/chat-window',
  '/skills',
  '/secretary',
  '/people',
  '/people/:id',
  '/brand-design',
  '/brand-assets',
  '/influencer/creators',
  '/influencer/setup',
  '/ui-kit',
] as const

export const UNKNOWN_ROUTE = '/other'

export function routeTemplate(loc: { pathname: string; search?: string; hash?: string }): string {
  const pathname = (loc.pathname.replace(/\/+$/, '') || '/').toLowerCase()
  const settings = settingsTargetOf({
    pathname,
    search: loc.search ?? '',
    hash: loc.hash ?? '',
  })
  if (settings !== null) return `/settings/${settings.section}`
  for (const template of ROUTE_TEMPLATES)
    if (matchPath({ path: template, end: true }, pathname) !== null) return template
  return UNKNOWN_ROUTE
}
