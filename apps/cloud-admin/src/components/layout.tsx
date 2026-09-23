/**
 * 侧栏 + 内容区（两个旧后台的共同布局，照搬）。
 *
 * 左上角是母品牌标记——取 `@agentsws/brand` 的那一份 SVG（WP112），**不自己画**：
 * 全仓只有一处几何，标记改一次所有地方跟着改。
 */

import { BRAND_MARK_SVG_DARK } from '@agentsws/brand'
import {
  Activity,
  Building2,
  Coins,
  Gauge,
  Languages,
  LogOut,
  Megaphone,
  Moon,
  ScrollText,
  Sun,
  Tags,
  Users,
} from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { api } from '@/lib/api'
import { useApp } from '@/lib/app'
import type { Key } from '@/lib/i18n'
import { StatusPill } from './design'

const NAV: { to: string; key: Key; icon: React.ComponentType<{ className?: string }> }[] = [
  { to: '/', key: 'nav.overview', icon: Gauge },
  { to: '/users', key: 'nav.users', icon: Users },
  { to: '/orgs', key: 'nav.orgs', icon: Building2 },
  { to: '/usage', key: 'nav.usage', icon: Activity },
  { to: '/credits', key: 'nav.credits', icon: Coins },
  { to: '/kol', key: 'nav.kol', icon: Megaphone },
  { to: '/pricing', key: 'nav.pricing', icon: Tags },
  { to: '/health', key: 'nav.health', icon: Gauge },
  { to: '/audit', key: 'nav.audit', icon: ScrollText },
]

export function Layout({ children }: { children: React.ReactNode }): React.ReactNode {
  const { t, me, lang, setLang, theme, setTheme } = useApp()
  return (
    <div className="flex min-h-screen bg-ws-paper text-ws-ink">
      <aside className="flex w-[208px] shrink-0 flex-col gap-1 border-ws-line border-r bg-[var(--sidebar)] px-3 py-4">
        <div className="mb-4 flex items-center gap-2.5 px-2">
          <span
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-[#1B1D22]"
            aria-hidden
            // 标记是一段固定的 SVG 常量（`@agentsws/brand`），不含任何外部输入
            dangerouslySetInnerHTML={{ __html: sized(BRAND_MARK_SVG_DARK, 20) }}
          />
          <span className="ws-display min-w-0 text-[13px] leading-tight">
            Agents {lang === 'zh' ? '工坊' : 'Workshop'}
            <span className="block text-[11px] font-normal text-ws-muted-fg">{t('app.short')}</span>
          </span>
        </div>

        <nav className="flex flex-col gap-0.5">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'} className="ws-nav">
              <item.icon className="size-4 shrink-0" aria-hidden />
              {t(item.key)}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-2 px-2 pt-4">
          {me !== undefined && (
            <>
              <StatusPill tone={me.role === 'admin' ? 'brand' : 'neutral'}>
                {t(me.role === 'admin' ? 'role.admin' : 'role.support')}
              </StatusPill>
              <span className="truncate text-[11px] text-ws-muted-fg" title={me.account.email}>
                {me.account.email}
              </span>
            </>
          )}
          <div className="flex gap-1">
            <IconButton
              label={t('nav.theme')}
              onClick={() => {
                setTheme(theme === 'dark' ? 'light' : 'dark')
              }}
            >
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </IconButton>
            <IconButton
              label={t('nav.lang')}
              onClick={() => {
                setLang(lang === 'zh' ? 'en' : 'zh')
              }}
            >
              <Languages className="size-4" />
            </IconButton>
            <IconButton
              label={t('nav.logout')}
              onClick={() => {
                void api.post('/v1/admin/auth/logout').finally(() => {
                  window.location.replace('/admin/login')
                })
              }}
            >
              <LogOut className="size-4" />
            </IconButton>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-6 py-5">{children}</main>
    </div>
  )
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.ReactNode {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-lg text-ws-muted-fg hover:bg-ws-surface hover:text-ws-ink"
    >
      {children}
    </button>
  )
}

/** 给那段 SVG 常量加上宽高（它本身只有 viewBox——尺寸由用它的地方定）。 */
function sized(svg: string, px: number): string {
  return svg.replace('<svg ', `<svg width="${String(px)}" height="${String(px)}" `)
}

export function PageHeader({
  title,
  right,
  note,
}: {
  title: string
  right?: React.ReactNode
  note?: React.ReactNode
}): React.ReactNode {
  return (
    <header className="mb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="ws-display text-[20px] text-ws-ink">{title}</h1>
        {right}
      </div>
      {note !== undefined && <div className="mt-2">{note}</div>}
    </header>
  )
}
