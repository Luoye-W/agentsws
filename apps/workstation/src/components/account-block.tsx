/**
 * WP71（36 §10，09-16 Luoye 定）：**账号块在左栏最下面**。
 *
 * 和 KOLAgents / KefuAgents 一样：头像 + 名字 + 「角色 · 公司名」一行，点开是一个
 * 小菜单——账号与积分 / 设置 / 退出。顶栏因此只剩 ⌘K、模型芯片、积分。
 *
 * 为什么搬下来：顶栏是"这一屏里正在发生什么"（⌘K、模型、余额），左栏是"我是谁、
 * 我能去哪儿"。账号与品牌属于后者，而且它们一天点不到一次——放在最下面，
 * 眼睛不用每次扫过去。
 *
 * 深浅色与语言两个开关原来在顶栏，这一版一起收进这个菜单：它们同样是"一次设定、
 * 之后不管"的东西，不该常驻在每一页的右上角。
 */
import { useQuery } from '@tanstack/react-query'
import { ChevronsUpDown, Languages, LogOut, Moon, Settings, Sun, Wallet } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Separator } from '@/components/ui/separator'
import { clearToken, getPositions, type Me } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 名字取头一个字当头像（中文一个字、英文一个字母，都刚好）。 */
function initialOf(name: string): string {
  const trimmed = name.trim()
  return trimmed === '' ? '?' : ([...trimmed][0] ?? '?')
}

export function AccountBlock({ me }: { me?: Me }): React.ReactNode {
  const { t, theme, toggleTheme, lang, setLang } = useApp()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  /**
   * 「角色」那一格：持有 `common.owner` 就是所有者，否则是成员。
   *
   * 不为这一行单开一条接口——左栏那份岗位清单里本来就有 `role_id`（同
   * `pages/position.tsx` 里 `isOwner` 的算法，一处判据两处用）。
   */
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions, retry: false })
  const isOwner = (positions.data?.positions ?? []).some((p) => p.role_id === 'common.owner')

  const name = me?.person.name ?? me?.person.email ?? '—'
  const company = me?.workspace.name ?? ''
  const role = isOwner ? t('account.role.owner') : t('account.role.member')

  const go = (to: string): void => {
    setOpen(false)
    navigate(to)
  }

  return (
    <div className="relative" data-testid="account-block">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('account.menu')}
        data-testid="account-toggle"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent/60"
        onClick={() => {
          setOpen(!open)
        }}
      >
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium"
        >
          {initialOf(name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium" data-testid="account-name">
            {name}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {company === '' ? role : `${role} · ${company}`}
          </span>
        </span>
        <ChevronsUpDown aria-hidden className="size-3 shrink-0 opacity-60" />
      </button>
      {open ? (
        // 与品牌切换器同一种朴素下拉：一个按钮 + 一张列表，不引浮层引擎
        <div
          role="menu"
          data-testid="account-menu"
          className="absolute bottom-full left-0 z-50 mb-1 w-56 rounded-md border bg-popover p-1 shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            data-testid="account-credits"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => {
              go('/settings?tab=account')
            }}
          >
            <Wallet aria-hidden className="size-4" />
            {t('settings.tab.account')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="account-settings"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => {
              go('/settings')
            }}
          >
            <Settings aria-hidden className="size-4" />
            {t('nav.settings')}
          </button>
          <Separator className="my-1" />
          <button
            type="button"
            role="menuitem"
            data-testid="account-theme"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={toggleTheme}
          >
            {theme === 'dark' ? (
              <Sun aria-hidden className="size-4" />
            ) : (
              <Moon aria-hidden className="size-4" />
            )}
            {theme === 'dark' ? t('theme.light') : t('theme.dark')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="account-lang"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => {
              setLang(lang === 'zh' ? 'en' : 'zh')
            }}
          >
            <Languages aria-hidden className="size-4" />
            {t('settings.lang')}
          </button>
          <Separator className="my-1" />
          <button
            type="button"
            role="menuitem"
            data-testid="account-logout"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => {
              // 退出 = 丢掉本机那个 bearer 再整站重载（cookie 档由服务端那一侧管）
              clearToken()
              setOpen(false)
              globalThis.location?.reload()
            }}
          >
            <LogOut aria-hidden className="size-4" />
            {t('account.logout')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
