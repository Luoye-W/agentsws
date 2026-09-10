/**
 * 36 §3 的布局：左栏（首页 / 岗位 / 知识库 / 连接 / 设置）+ 主区。
 *
 * 左栏按岗位分组——岗位就是一条 Assignment，点进去才展开它的面板（06 §1.3「被带过去」）。
 * 顶栏只有三样：深浅色、语言、⌘K。**没有全局聊天输入框**（36 §3 A4）。
 */
import type { DeckCard, TileSpec } from '@agentsws/deck'
import {
  BookOpen,
  Bot,
  Briefcase,
  Building2,
  CalendarDays,
  Command as CommandIcon,
  Crown,
  Headset,
  Home,
  Languages,
  ListTodo,
  type LucideIcon,
  Megaphone,
  Moon,
  Plug,
  Settings,
  Sparkles,
  Store,
  Sun,
  Target,
  Users,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { CommandPalette } from '@/components/command-palette'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import type { PositionSummary } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

function navClass({ isActive }: { isActive: boolean }): string {
  return cn(
    'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
    // 选中态图标跟文字同色（`[&_svg]:text-current`），未选中时图标压成 muted。
    isActive
      ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium [&_svg]:text-current'
      : 'hover:bg-sidebar-accent/60 [&_svg]:text-muted-foreground',
  )
}

/**
 * 岗位图标按职责挑：客服 / 运营 / 投放 / 所有者各有专属，其余落到 Briefcase。
 * 认不出的 role_id 一律 Briefcase——图标是提示，不是分类学。
 */
function positionIcon(role_id: string): LucideIcon {
  if (role_id.endsWith('.aftersales')) return Headset
  if (role_id.endsWith('.ops')) return Store
  if (role_id.startsWith('ads.')) return Megaphone
  if (role_id === 'common.owner') return Crown
  return Briefcase
}

/** 侧栏图标统一 16px；颜色交给 `navClass` 里的 `[&_svg]` 规则。 */
function NavIcon({ icon: Icon }: { icon: LucideIcon }): ReactNode {
  return <Icon aria-hidden className="size-4 shrink-0" />
}

export function AppShell({
  children,
  positions,
  cards,
  tileLibrary,
  onAddTile,
}: {
  children: ReactNode
  positions: PositionSummary[]
  cards: DeckCard[]
  tileLibrary: TileSpec[]
  onAddTile: (position_id: string, tile_id: string) => void
}): ReactNode {
  const { t, theme, toggleTheme, lang, setLang } = useApp()
  const [paletteOpen, setPaletteOpen] = useState(false)

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="hidden w-56 shrink-0 flex-col gap-1 border-r bg-sidebar p-3 md:flex">
        <div className="px-2 pb-3 text-sm font-semibold">{t('app.title')}</div>
        <nav className="flex flex-col gap-0.5" aria-label={t('nav.home')}>
          <NavLink to="/" end className={navClass}>
            <NavIcon icon={Home} />
            {t('nav.home')}
          </NavLink>
          {/* 37 工作模型：待办 / 日历 / 目标 */}
          <NavLink to="/todos" className={navClass}>
            <NavIcon icon={ListTodo} />
            {t('nav.todos')}
          </NavLink>
          <NavLink to="/calendar" className={navClass}>
            <NavIcon icon={CalendarDays} />
            {t('nav.calendar')}
          </NavLink>
          <NavLink to="/goals" className={navClass}>
            <NavIcon icon={Target} />
            {t('nav.goals')}
          </NavLink>
          <div className="px-2 pt-3 pb-1 text-xs text-muted-foreground">{t('nav.positions')}</div>
          {positions.map((p) => (
            <NavLink key={p.position_id} to={`/positions/${p.position_id}`} className={navClass}>
              <NavIcon icon={positionIcon(p.role_id)} />
              <span className="truncate">{p.role_name}</span>
            </NavLink>
          ))}
          <Separator className="my-2" />
          {/* 41 §1：每人自带的个人代理——问别人的代理、管自己的 profile 与日程 */}
          <NavLink to="/secretary" className={navClass}>
            <NavIcon icon={Bot} />
            {t('nav.secretary')}
          </NavLink>
          <NavLink to="/meetings" className={navClass}>
            <NavIcon icon={Users} />
            {t('nav.meetings')}
          </NavLink>
          <NavLink to="/knowledge" className={navClass}>
            <NavIcon icon={BookOpen} />
            {t('nav.knowledge')}
          </NavLink>
          <NavLink to="/skills" className={navClass}>
            <NavIcon icon={Sparkles} />
            {t('nav.skills')}
          </NavLink>
          {/* WP28 制度面：岗位 / 成员 / 职责（谁在做什么、能做到哪一步） */}
          <NavLink to="/org" className={navClass}>
            <NavIcon icon={Building2} />
            {t('nav.org')}
          </NavLink>
          <NavLink to="/connections" className={navClass}>
            <NavIcon icon={Plug} />
            {t('nav.connections')}
          </NavLink>
          <NavLink to="/settings" className={navClass}>
            <NavIcon icon={Settings} />
            {t('nav.settings')}
          </NavLink>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-1 border-b px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setPaletteOpen(true)
            }}
            aria-label="命令面板 (⌘K)"
          >
            <CommandIcon aria-hidden />
            <span className="hidden text-xs sm:inline">⌘K</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              setLang(lang === 'zh' ? 'en' : 'zh')
            }}
            aria-label={t('settings.lang')}
          >
            <Languages aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? t('theme.light') : t('theme.dark')}
          >
            {theme === 'dark' ? <Sun aria-hidden /> : <Moon aria-hidden />}
          </Button>
        </header>
        <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        positions={positions}
        cards={cards}
        tileLibrary={tileLibrary}
        onAddTile={onAddTile}
      />
    </div>
  )
}
