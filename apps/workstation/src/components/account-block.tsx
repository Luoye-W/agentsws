/**
 * WP71（36 §10，09-16 Luoye 定）：**账号块在左栏最下面**。头像 + 名字 + 「角色 · 公司名」一行，点开是一个小菜单。
 *
 * WP342（决策 853，Luoye 10-15「学 Codex / Claude」）：这个菜单现在装得更多——
 *
 * - **积分**：顶栏那个「积分 96.059」搬进来（菜单第一行：余额 + 充值）；余额低时头像右上角一个小点，
 *   不在顶栏常驻。没关联工坊账号就只有「账号与积分」一行。
 * - **两组入口**：原来左栏下半那几页收成两组，默认收着、点开记在本机——
 *   「工作内容」会议 / 知识库 / 技能；「设置」岗位与品牌 / 连接 / 消息渠道 / 设置。路由一个没动。
 * - **场景**：原来账户块上方那一行，变成菜单里一行子菜单（「场景 ›」，面板往右开）。
 * - 深浅色、退出照旧（语言 WP361 起只在设置弹窗里）。
 *
 * WP356（决策 923）：「设置」那一组换成一行「设置 ⌘,」——点了打开设置弹窗（盖在当前页上，不切走），
 * 岗位与品牌 / 连接 / 消息渠道都在弹窗里；「工作内容」那一组不变。
 *
 * WP361：「工作内容」多一项「进行中」（② ③ 才有，决策 925）；「语言」从菜单拿掉，只在设置弹窗 →
 * 个人 → 通用里改（决策 926）——深浅色、场景是一键切换的事，留在菜单。
 *
 * WP481（决策 1634，Luoye 10-23）：名字下面那行不再写工作区名（个人用户看到的是「default」）——只写名字；
 * 同事互联 / 公司模式下要分清是哪个品牌 / 公司时才写（公司模式照旧「所有者 · 公司」）。
 * 「反馈」不再在名字旁边单独一颗按钮，收进这个菜单（「反馈」「我的反馈」）；⌘K 照旧搜得到。
 *
 * 键盘：菜单开了焦点进第一项；↑↓ 在各项之间走，Esc 收起并回到账号块上。
 * 托盘「管理场景…」打开的是 `/?scenes=1`——看到这个参数先把菜单打开，场景那一行自己展开面板。
 */
import { useQuery } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Coins,
  Handshake,
  LogOut,
  MessageSquareText,
  MessagesSquare,
  Moon,
  Settings,
  Sun,
  Wallet,
} from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { avatarInitial } from '@/components/design'
import { useRailState } from '@/components/rail/rail-state'
import { SceneSwitcher } from '@/components/scene-switcher'
import { SHELL_PAGES, type ShellPage, shellPageVisible } from '@/components/shell-pages'
import { Separator } from '@/components/ui/separator'
import { clearToken, getCloudCredits, getPositions, type Me } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { useAppVersion } from '@/lib/app-version'
import { creditsLow } from '@/lib/credits-runway'
import { openFeedback } from '@/lib/feedback'
import { useMode } from '@/lib/mode'
import { ACCOUNT_GROUPS_KEY, readFlags, writeFlags } from '@/lib/ui-state'
import { cn } from '@/lib/utils'

/**
 * 名字取一个字当头像。
 *
 * WP100：与卡片 / 岗位卡上那些头像走**同一个函数**（中文取名字末字、拉丁取首字母、
 * `AI` 这种缩写原样留着）——同一屏里"王岚"在左下角是「王」、在岗位卡上是「岚」，
 * 人会以为那是两个人。
 */
const initialOf = avatarInitial

const ITEM =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none'

/** 积分余额（问不到 / 没关联 = `undefined`，菜单里就只写「账号与积分」）。 */
function useBalance(): { available?: number; low: boolean; canTopup: boolean } {
  const credits = useQuery({
    queryKey: ['cloud-credits', 'chip'],
    queryFn: () => getCloudCredits(),
    retry: false,
  })
  const balance = credits.data?.linked === true ? credits.data.balance : undefined
  return {
    ...(balance === undefined ? {} : { available: balance.available }),
    // WP426：按「还够几轮」判，不再用钱包写死的 50
    low: balance !== undefined && creditsLow(balance.available),
    canTopup: credits.data?.linked === true && credits.data.can_topup !== false,
  }
}

export function AccountBlock({
  me,
  compact = false,
}: {
  me?: Me
  /** WP431：左栏收成图标列时只画头像（菜单照旧往右上开）。 */
  compact?: boolean
}): React.ReactNode {
  const { t, theme, toggleTheme } = useApp()
  // WP271：① 个人只写品牌名，不写「所有者」（这里只有你一个人）
  const { solo, mode, known, t: tm } = useMode()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [open, setOpen] = useState(false)
  const [groups, setGroups] = useState<Record<string, boolean>>(() => readFlags(ACCOUNT_GROUPS_KEY))
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const { available, low, canTopup } = useBalance()
  const { version } = useAppVersion()

  /**
   * 「角色」那一格：持有 `common.owner` 就是所有者，否则是成员。
   *
   * 不为这一行单开一条接口——左栏那份岗位清单里本来就有 `role_id`（同
   * `pages/position.tsx` 里 `isOwner` 的算法，一处判据两处用）。
   */
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions, retry: false })
  const isOwner = (positions.data?.positions ?? []).some((p) => p.role_id === 'common.owner')

  // 托盘「管理场景…」→ `/?scenes=1`：先把菜单打开（场景那一行自己展开面板、再把参数拿掉）
  useEffect(() => {
    if (params.get('scenes') === '1') setOpen(true)
  }, [params])

  // 点外面收起；开了把焦点放进第一项（键盘可达）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(e.target as Node)) setOpen(false)
    }
    globalThis.document?.addEventListener('mousedown', onDown)
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => {
      globalThis.document?.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const name = me?.person.name ?? me?.person.email ?? '—'
  const company = me?.workspace.name ?? ''
  /*
   * WP276（docs/95 §2.1、决策 256）：② 同事互联——发起人写「发起人」，别的同事只写品牌名
   * （不写「成员」「所有者」，第二个人进来时界面不能像公司）。
   */
  const role = isOwner ? tm('account.role.owner') : t('account.role.member')
  /*
   * WP481（决策 1634）：个人模式只写名字（工作区名对个人用户没意义，默认叫「default」）；
   * 同事互联照旧（决策 256：发起人「发起人 · 品牌」、别的同事只写品牌）；公司模式「角色 · 公司」。
   * 工作区名是空的或还叫「default」时不写名字那一截。
   */
  const where = company === '' || company === 'default' ? '' : company
  // 模式还没问到时先不写（问到之前默认算公司模式，个人用户会先闪一下「成员 · default」）
  const subtitle =
    solo || !known
      ? ''
      : mode === 'peers' && !isOwner
        ? where
        : where === ''
          ? role
          : `${role} · ${where}`

  const close = (): void => {
    setOpen(false)
    toggle.current?.focus()
  }
  const go = (to: string): void => {
    setOpen(false)
    navigate(to)
  }
  const rail = useRailState()
  const flip = (id: string): void => {
    setGroups((prev) => {
      const next = { ...prev, [id]: prev[id] !== true }
      writeFlags(ACCOUNT_GROUPS_KEY, next)
      return next
    })
  }
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = items.indexOf(globalThis.document?.activeElement as HTMLElement)
    const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }
  const label = (p: ShellPage): string => t(p.key)
  const group = (id: 'work'): React.ReactNode => {
    const expanded = groups[id] === true
    return (
      <div data-testid={`account-group-${id}`}>
        <button
          type="button"
          role="menuitem"
          aria-expanded={expanded}
          data-testid={`account-group-${id}-toggle`}
          className={cn(ITEM, 'text-ws-muted-fg')}
          onClick={() => {
            flip(id)
          }}
        >
          {expanded ? (
            <ChevronDown aria-hidden className="size-4" />
          ) : (
            <ChevronRight aria-hidden className="size-4" />
          )}
          {t(`account.group.${id}`)}
        </button>
        {expanded
          ? SHELL_PAGES.filter((p) => p.group === id && shellPageVisible(p, { known, solo })).map(
              (p) => (
                <button
                  key={p.to}
                  type="button"
                  role="menuitem"
                  data-testid={p.testId}
                  className={cn(ITEM, 'pl-7')}
                  onClick={() => {
                    go(p.to)
                  }}
                >
                  <p.icon aria-hidden className="size-4" />
                  {label(p)}
                </button>
              ),
            )
          : null}
      </div>
    )
  }

  return (
    <div ref={root} className="relative" data-testid="account-block">
      <button
        ref={toggle}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('account.menu')}
        data-testid="account-toggle"
        {...(compact ? { title: name } : {})}
        className={cn(
          'flex items-center gap-2 rounded-md text-left hover:bg-sidebar-accent/60',
          compact ? 'size-9 justify-center' : 'w-full px-2 py-1.5',
        )}
        onClick={() => {
          setOpen(!open)
        }}
      >
        <span
          aria-hidden
          className="relative flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium"
        >
          {initialOf(name)}
          {/* 余额低：头像右上角一个小点（不在顶栏常驻），说法在菜单那一行的悬停里 */}
          {low ? (
            <i
              data-testid="account-low-dot"
              className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-ws-warn ring-2 ring-sidebar"
            />
          ) : null}
        </span>
        <span className={cn('min-w-0 flex-1', compact && 'sr-only')}>
          <span className="block truncate text-sm font-medium" data-testid="account-name">
            {name}
          </span>
          {subtitle === '' ? null : (
            <span
              className="block truncate text-xs text-muted-foreground"
              data-testid="account-subtitle"
            >
              {subtitle}
            </span>
          )}
        </span>
        {compact ? null : <ChevronsUpDown aria-hidden className="size-3 shrink-0 opacity-60" />}
      </button>
      {open ? (
        // 与品牌切换器同一种朴素下拉：一个按钮 + 一张列表，不引浮层引擎
        <div
          ref={menu}
          role="menu"
          aria-label={t('account.menu')}
          data-testid="account-menu"
          onKeyDown={onMenuKey}
          className="absolute bottom-full left-0 z-50 mb-1 w-60 rounded-md border bg-popover p-1 shadow-md"
        >
          {/* 积分：余额 + 充值（没关联 = 「账号与积分」一行） */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              role="menuitem"
              data-testid="account-credits"
              {...(available === undefined
                ? {}
                : { title: low ? t('account.balance.low') : t('account.balance.tip') })}
              className={cn(ITEM, 'min-w-0 flex-1')}
              onClick={() => {
                go('/settings?tab=account')
              }}
            >
              {available === undefined ? (
                <>
                  <Wallet aria-hidden className="size-4" />
                  {t('settings.tab.account')}
                </>
              ) : (
                <>
                  <Coins aria-hidden className={cn('size-4', low && 'text-ws-warn')} />
                  <span>{t('account.balance')}</span>
                  <span
                    data-testid="account-balance"
                    className={cn('ws-num ml-auto tabular-nums', low && 'text-ws-warn')}
                  >
                    {available.toLocaleString()}
                  </span>
                </>
              )}
            </button>
            {canTopup && available !== undefined ? (
              <button
                type="button"
                role="menuitem"
                data-testid="account-topup"
                className="shrink-0 rounded-sm px-2 py-1 text-xs font-medium text-ws-brand hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                onClick={() => {
                  go('/settings?tab=account')
                }}
              >
                {t('account.topup')}
              </button>
            ) : null}
          </div>
          {/* WP390（docs/105 §4.1 ③）：工坊服务——全部服务（按岗位分组）+ 我的订单，在第三栏开 */}
          <button
            type="button"
            role="menuitem"
            data-testid="account-workshop-services"
            className={ITEM}
            onClick={() => {
              setOpen(false)
              rail.show('workshop-services')
            }}
          >
            <Handshake aria-hidden className="size-4" />
            {t('menu.workshop_services')}
          </button>
          <Separator className="my-1" />
          {group('work')}
          <button
            type="button"
            role="menuitem"
            data-testid="nav-settings"
            className={ITEM}
            onClick={() => {
              go('/settings')
            }}
          >
            <Settings aria-hidden className="size-4" />
            {t('nav.settings')}
            <kbd className="ws-num ml-auto text-ws-tiny text-ws-muted-fg">⌘,</kbd>
          </button>
          {/* WP136：切到 dsh 的其他场景（只有所有者看得到；这台切不了就整行不出） */}
          <SceneSwitcher variant="menu" />
          <Separator className="my-1" />
          <button
            type="button"
            role="menuitem"
            data-testid="account-theme"
            className={ITEM}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? (
              <Sun aria-hidden className="size-4" />
            ) : (
              <Moon aria-hidden className="size-4" />
            )}
            {theme === 'dark' ? t('theme.light') : t('theme.dark')}
          </button>
          {/* WP481（决策 1634）：「反馈」从左下角那颗按钮挪进来 */}
          <button
            type="button"
            role="menuitem"
            data-testid="account-feedback"
            title={t('feedback.button.hint')}
            className={ITEM}
            onClick={() => {
              setOpen(false)
              openFeedback('new')
            }}
          >
            <MessageSquareText aria-hidden className="size-4" />
            {t('feedback.button')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="account-feedback-mine"
            className={ITEM}
            onClick={() => {
              setOpen(false)
              openFeedback('mine')
            }}
          >
            <MessagesSquare aria-hidden className="size-4" />
            {t('feedback.tab.mine')}
          </button>
          <Separator className="my-1" />
          <button
            type="button"
            role="menuitem"
            data-testid="account-logout"
            className={ITEM}
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
          {/* WP426：一行小字看得到装的是哪个版本（桌面壳的安装包版本；网页里是服务端报的） */}
          {version === undefined ? null : (
            <p
              className="ws-num px-2 pt-1 pb-0.5 text-xs text-ws-muted-fg select-text"
              data-testid="account-version"
            >
              {t('account.version', { version })}
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}
