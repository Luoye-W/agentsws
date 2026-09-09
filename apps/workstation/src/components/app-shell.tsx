/**
 * 36 §3 的布局：左栏（首页 / 岗位 / 知识库 / 连接与设置）+ 主区。
 *
 * 左栏按岗位分组——岗位就是一条 Assignment，点进去才展开它的面板（06 §1.3「被带过去」）。
 * 顶栏只有三样：深浅色、语言、⌘K。**没有全局聊天输入框**（36 §3 A4）。
 */
import type { DeckCard, TileSpec } from '@agentsws/deck'
import { Command as CommandIcon, Languages, Moon, Sun } from 'lucide-react'
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
    'block rounded-md px-2 py-1.5 text-sm transition-colors',
    isActive
      ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
      : 'hover:bg-sidebar-accent/60',
  )
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
            {t('nav.home')}
          </NavLink>
          {/* 37 工作模型：待办 / 日历 / 目标 */}
          <NavLink to="/todos" className={navClass}>
            {t('nav.todos')}
          </NavLink>
          <NavLink to="/calendar" className={navClass}>
            {t('nav.calendar')}
          </NavLink>
          <NavLink to="/goals" className={navClass}>
            {t('nav.goals')}
          </NavLink>
          <div className="px-2 pt-3 pb-1 text-xs text-muted-foreground">{t('nav.positions')}</div>
          {positions.map((p) => (
            <NavLink key={p.position_id} to={`/positions/${p.position_id}`} className={navClass}>
              {p.role_name}
            </NavLink>
          ))}
          <Separator className="my-2" />
          <NavLink to="/knowledge" className={navClass}>
            {t('nav.knowledge')}
          </NavLink>
          <NavLink to="/settings" className={navClass}>
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
